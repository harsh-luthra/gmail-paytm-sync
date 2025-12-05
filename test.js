const fs = require("fs");
const axios = require("axios");
const { google } = require("googleapis");

const API_URL = "https://kite-pay-api-v1.onrender.com/paytm/payment-sync";
const LABEL_NAME = "PROCESSED"; // The name of your custom label

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
    console.log("Token missing. Run local auth script first.");
    process.exit(1);
}

// --- NEW: Helper to find or create the Label ID ---
async function getOrCreateLabelId(gmail) {
    const res = await gmail.users.labels.list({ userId: "me" });
    const labels = res.data.labels;
    
    // 1. Try to find existing label
    const existingLabel = labels.find((l) => l.name === LABEL_NAME);
    if (existingLabel) {
        return existingLabel.id;
    }

    // 2. Create if not found
    console.log(`Label '${LABEL_NAME}' not found. Creating it...`);
    const newLabel = await gmail.users.labels.create({
        userId: "me",
        requestBody: {
            name: LABEL_NAME,
            labelListVisibility: "labelShow",
            messageListVisibility: "show",
            color: { backgroundColor: "#000000", textColor: "#ffffff" } // Optional styling
        },
    });
    return newLabel.data.id;
}

// --- HELPER: Recursively find text/html part ---
function findHtmlBody(parts) {
    if (!parts) return null;
    for (const part of parts) {
        if (part.mimeType === 'text/html' && part.body && part.body.data) {
            return part.body.data;
        }
        if (part.parts) {
            const found = findHtmlBody(part.parts);
            if (found) return found;
        }
    }
    return null;
}

// --- HELPER: Clean HTML to Plain Text ---
function cleanHtmlText(htmlBase64) {
    const html = Buffer.from(htmlBase64, "base64").toString("utf-8");
    let text = html
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/tr>/gi, "\n")
        .replace(/<\/p>/gi, "\n")
        .replace(/<\/div>/gi, "\n");
    text = text.replace(/<[^>]+>/g, " ");
    text = text
        .replace(/&#8377;/g, "₹")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return text;
}

function extractData(text) {
    return {
        amount: text.match(/₹\s*([\d,]+(?:\.\d{1,2})?)/)?.[1] || null,
        orderId: text.match(/Order ID:\s*([A-Z0-9]+)/i)?.[1] || null,
        accountOf: text.match(/In Account of\s*(.*?)\s*(?:Transaction|Nov|Dec|Jan)/i)?.[1]?.trim() || null,
        transactionCount: text.match(/Transaction Count #(\d+)/i)?.[1] || null,
        fromUpi: text.match(/From\s*([A-Za-z0-9@.]+)/i)?.[1] || null,
        datetime: text.match(/([A-Z][a-z]{2}\s\d{1,2},\s\d{4},\s\d{1,2}:\d{2}\s[APM]{2})/)?.[1] || null
    };
}

// --- MAIN LOGIC ---
async function processLatestEmail(auth) {
    const gmail = google.gmail({ version: "v1", auth });

    // 1. Ensure we have the Label ID
    const processedLabelId = await getOrCreateLabelId(gmail);

    console.log(`Checking for Paytm emails without label '${LABEL_NAME}'...`);

    // 2. Updated Search Query: Exclude already processed emails
    // q: 'from:no-reply@paytm.com -label:PROCESSED'
    const res = await gmail.users.messages.list({
        userId: "me",
        q: `from:no-reply@paytm.com -label:${LABEL_NAME}`, 
        maxResults: 1 
    });

    const messages = res.data.messages || [];

    if (messages.length === 0) {
        console.log("No new emails to process.");
        return;
    }

    const mailId = messages[0].id;
    console.log(`Processing email ID: ${mailId}`);

    const mail = await gmail.users.messages.get({
        userId: "me",
        id: mailId,
        format: "full",
    });

    let encodedBody = mail.data.payload.body.data;
    if (!encodedBody) {
        encodedBody = findHtmlBody(mail.data.payload.parts);
    }

    if (!encodedBody) {
        console.log("Error: HTML body not found.");
        return;
    }

    const cleanText = cleanHtmlText(encodedBody);
    const data = extractData(cleanText);
    console.log("Parsed Data:", data);

    if (data.amount) {
        console.log("Sending to API...");
        try {
            await axios.post(API_URL, data);
            console.log("API Success.");
            
            // --- 3. APPLY LABEL ON SUCCESS ---
            await gmail.users.messages.modify({
                userId: "me",
                id: mailId,
                requestBody: {
                    addLabelIds: [processedLabelId], 
                    // removeLabelIds: ["UNREAD"] // Uncomment this if you also want to mark it as read
                }
            });
            console.log(`Labeled email as '${LABEL_NAME}'.`);

        } catch (err) {
            console.error("API Failed. Label NOT applied.", err.response?.data || err.message);
        }
    } else {
        await gmail.users.messages.modify({
                userId: "me",
                id: mailId,
                requestBody: {
                    addLabelIds: [processedLabelId], 
                    // removeLabelIds: ["UNREAD"] // Uncomment this if you also want to mark it as read
                }
            });
        console.log("Not Skipping: Could not parse amount.");
        // Optional: You might want to label this as "ERROR" so you don't retry it forever
    }
}

(async () => {
    const auth = await authorize();
    await processLatestEmail(auth);
})();