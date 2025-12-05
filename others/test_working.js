const fs = require("fs");
const axios = require("axios");
const { google } = require("googleapis");

const API_URL = "https://kite-pay-api-v1.onrender.com/paytm/payment-sync";

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

// --- HELPER: Recursively find text/html part ---
function findHtmlBody(parts) {
    if (!parts) return null;
    
    for (const part of parts) {
        // If we found the HTML immediately
        if (part.mimeType === 'text/html' && part.body && part.body.data) {
            return part.body.data;
        }
        // If this part has sub-parts (nested), dig deeper
        if (part.parts) {
            const found = findHtmlBody(part.parts);
            if (found) return found;
        }
    }
    return null;
}

// --- HELPER: Clean HTML to Plain Text ---
function cleanHtmlText(htmlBase64) {
    // 1. Decode Base64
    const html = Buffer.from(htmlBase64, "base64").toString("utf-8");

    // 2. Replace HTML breaks/rows with newlines to preserve structure
    let text = html
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/tr>/gi, "\n")
        .replace(/<\/p>/gi, "\n")
        .replace(/<\/div>/gi, "\n");

    // 3. Strip all HTML tags
    text = text.replace(/<[^>]+>/g, " ");

    // 4. Decode HTML Entities (specifically Rupee and spaces)
    text = text
        .replace(/&#8377;/g, "₹")  // Rupee symbol
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")      // Collapse multiple spaces
        .trim();

    return text;
}

function extractData(text) {
    // Updated Regex to be more flexible with the cleaned HTML text
    return {
        amount: text.match(/₹\s*([\d,]+(?:\.\d{1,2})?)/)?.[1] || null, // Added decimal support
        orderId: text.match(/Order ID:\s*([A-Z0-9]+)/i)?.[1] || null,
        accountOf: text.match(/In Account of\s*(.*?)\s*(?:Transaction|Nov|Dec|Jan)/i)?.[1]?.trim() || null,
        transactionCount: text.match(/Transaction Count #(\d+)/i)?.[1] || null,
        fromUpi: text.match(/From\s*([A-Za-z0-9@.]+)/i)?.[1] || null, // Added . support for UPI IDs
        // Matches standard format: "Nov 26, 2025, 10:31 AM"
        datetime: text.match(/([A-Z][a-z]{2}\s\d{1,2},\s\d{4},\s\d{1,2}:\d{2}\s[APM]{2})/)?.[1] || null
    };
}

async function processLatestEmail(auth) {
    const gmail = google.gmail({ version: "v1", auth });

    console.log("Checking for the latest unread Paytm email...");

    // 1. Get List
    const res = await gmail.users.messages.list({
        userId: "me",
        q: 'from:no-reply@paytm.com is:unread',
        maxResults: 1 
    });

    const messages = res.data.messages || [];

    if (messages.length === 0) {
        console.log("No unread emails found.");
        return;
    }

    const mailId = messages[0].id;
    console.log(`Fetching content for email ID: ${mailId}`);

    // 2. Fetch Content
    const mail = await gmail.users.messages.get({
        userId: "me",
        id: mailId,
        format: "full",
    });

    // 3. Find Body (Recursive)
    let encodedBody = mail.data.payload.body.data; // Check top level
    if (!encodedBody) {
        // Check nested levels
        encodedBody = findHtmlBody(mail.data.payload.parts);
    }

    if (!encodedBody) {
        console.log("CRITICAL: Could not find HTML body in this email.");
        return;
    }

    // 4. Clean and Parse
    const cleanText = cleanHtmlText(encodedBody);
    console.log("\n--- Cleaned Text Preview ---\n", cleanText.substring(0, 200) + "...", "\n----------------------------\n");

    const data = extractData(cleanText);
    console.log("Parsed Data Object:", data);

    // 5. Send to API
    if (data.amount) {
        console.log("Sending to API...");
        await axios.post(API_URL, data).catch(err => {
            console.error("API Error:", err.response?.data || err.message);
        });
        console.log("Success.");
    } else {
        console.log("Skipping API call: Could not parse amount.");
    }
}

// Run
(async () => {
    const auth = await authorize();
    await processLatestEmail(auth);
})();