const axios = require("axios");
const { google } = require("googleapis");

const API_URL = "https://kite-pay-api-v1.onrender.com/paytm/payment-sync";

const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"]
});

async function getMessageById(id) {
    const client = await auth.getClient();
    const gmail = google.gmail({ version: "v1", auth: client });

    const msg = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "full",
    });

    const parts = msg.data.payload.parts || [];
    const body = Buffer.from(parts[0]?.body?.data || "", "base64").toString("utf8");
    return body;
}

function extractPaytmData(text) {
    text = text.replace(/\r|\n/g, " ");

    return {
        amount: text.match(/₹\s*([\d,]+)/)?.[1] ?? null,
        orderId: text.match(/Order ID:\s*([A-Z0-9]+)/)?.[1] ?? null,
        accountOf: text.match(/In Account of\s*(.*?)\s*\d{1,2}/)?.[1]?.trim() ?? null,
        fromUpi: text.match(/From\s*([A-Za-z0-9@]+)/)?.[1] ?? null,
        transactionCount: text.match(/Transaction Count #(\d+)/)?.[1] ?? null,
        datetime: text.match(/(\w+\s\d{1,2},\s\d{4},\s[\d:]+\s[APM]+)/)?.[1] ?? null
    };
}

exports.gmailPaytmSync = async (event) => {
    try {
        const message = event.data
            ? Buffer.from(event.data, "base64").toString("utf8")
            : null;

        if (!message) return;

        const msgObj = JSON.parse(message);

        const msgId = msgObj.emailMessageId;
        if (!msgId) return;

        const body = await getMessageById(msgId);

        if (!body.includes("Payment Received") || !body.includes("no-reply@paytm.com")) {
            console.log("Not a Paytm payment mail, ignoring.");
            return;
        }

        const parsed = extractPaytmData(body);
        console.log("Parsed Data:", parsed);

        await axios.post(API_URL, parsed);
        console.log("Synced with API");

    } catch (err) {
        console.error("ERROR:", err);
    }
};
