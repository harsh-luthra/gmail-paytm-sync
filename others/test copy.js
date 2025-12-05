const fs = require("fs");
const axios = require("axios");
const { google } = require("googleapis");
const cron = require("node-cron");

const API_URL = "https://kite-pay-api-v1.onrender.com/paytm/payment-sync"; // your endpoint

async function authorize() {
    const credentials = JSON.parse(fs.readFileSync("credentials.json"));
    const { client_secret, client_id, redirect_uris } = credentials.installed;

    const oAuth2Client = new google.auth.OAuth2(
        client_id,
        client_secret,
        redirect_uris[0]
    );

    if (fs.existsSync("token.json")) {
        oAuth2Client.setCredentials(JSON.parse(fs.readFileSync("token.json")));
        return oAuth2Client;
    }

    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: "offline",
        scope: ["https://mail.google.com/"]
    });

    console.log("Authorize this app: ", authUrl);
    process.exit(0);
}

async function getUnreadPaytmEmails(auth) {
    const gmail = google.gmail({ version: "v1", auth });

    const res = await gmail.users.messages.list({
        userId: "me",
        q: 'from:no-reply@paytm.com is:unread',
    });

    return res.data.messages || [];
}

function extractData(body) {
    const text = body.replace(/\r|\n/g, " ");

    return {
        amount: text.match(/₹\s*([\d,]+)/)?.[1] || null,
        orderId: text.match(/Order ID:\s*([A-Z0-9]+)/)?.[1] || null,
        accountOf: text.match(/In Account of\s*(.*?)\s*\d{1,2}/)?.[1]?.trim() || null,
        transactionCount: text.match(/Transaction Count #(\d+)/)?.[1] || null,
        fromUpi: text.match(/From\s*([A-Za-z0-9@]+)/)?.[1] || null,
        datetime: text.match(/(\w+\s\d{1,2},\s\d{4},\s[\d:]+\s[APM]+)/)?.[1] || null
    };
}

async function processPaytmEmail(auth, mailId) {
    const gmail = google.gmail({ version: "v1", auth });

    const mail = await gmail.users.messages.get({
        userId: "me",
        id: mailId,
        format: "full",
    });

    const body = Buffer.from(mail.data.payload.parts?.[0]?.body.data || "", "base64")
        .toString("utf-8");

    const data = extractData(body);

    console.log("Parsed Paytm Email:", data);

    await axios.post(API_URL, data).catch(err => {
        console.error("API Error:", err.response?.data || err.message);
    });

    // await gmail.users.messages.modify({
    //     userId: "me",
    //     id: mailId,
    //     resource: { removeLabelIds: ["UNREAD"] },
    // });
}

// CRON — every 1 minute
cron.schedule("* * * * *", async () => {
    const auth = await authorize();
    const mails = await getUnreadPaytmEmails(auth);

    for (const m of mails) {
        await processPaytmEmail(auth, m.id);
    }
});
