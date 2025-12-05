const fs = require("fs");
const axios = require("axios");
const { google } = require("googleapis");

const API_URL = "https://kite-pay-api-v1.onrender.com/paytm/payment-sync";
const TIMESTAMP_API_URL = "https://kite-pay-api-v1.onrender.com/paytm/last-timestamp"; 
const LABEL_NAME = "PROCESSED"; 
const POLLING_INTERVAL_MS = 30000; // 30 Seconds

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function authorize() {
    const credentials = JSON.parse(fs.readFileSync("credentials.json"));
    const { client_secret, client_id, redirect_uris } = credentials.installed;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    if (fs.existsSync("token.json")) {
        oAuth2Client.setCredentials(JSON.parse(fs.readFileSync("token.json")));
        return oAuth2Client;
    }
    console.log("Token missing. Run local auth script first.");
    process.exit(1);
}

// --- 1. INITIAL FETCH (Only called once at startup) ---
async function getInitialServerTimestamp() {
    try {
        console.log("Initializing: Fetching last timestamp from server...");
        const response = await axios.get(TIMESTAMP_API_URL);
        const timeString = response.data?.last_mail_timestamp;

        if (!timeString) {
            console.log("No timestamp from server. Defaulting to 24h ago.");
            return Math.floor(Date.now() / 1000) - 86400; 
        }

        const dateObj = new Date(timeString);
        if (isNaN(dateObj.getTime())) {
            return Math.floor(Date.now() / 1000) - 86400;
        }

        console.log(`Server last processed: ${timeString}`);
        return Math.floor(dateObj.getTime() / 1000);
    } catch (error) {
        console.error("Initialization Failed (Server might be down). Defaulting to 3days ago.");
        return Math.floor(Date.now() / 1000) - 259200; 
    }
}

async function getOrCreateLabelId(gmail) {
    const res = await gmail.users.labels.list({ userId: "me" });
    const labels = res.data.labels;
    const existingLabel = labels.find((l) => l.name === LABEL_NAME);
    if (existingLabel) return existingLabel.id;

    const newLabel = await gmail.users.labels.create({
        userId: "me",
        requestBody: {
            name: LABEL_NAME,
            labelListVisibility: "labelShow",
            messageListVisibility: "show",
            color: { backgroundColor: "#000000", textColor: "#ffffff" }
        },
    });
    return newLabel.data.id;
}

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

function cleanHtmlText(htmlBase64) {
    const html = Buffer.from(htmlBase64, "base64").toString("utf-8");
    let text = html
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/tr>/gi, "\n")
        .replace(/<\/p>/gi, "\n")
        .replace(/<\/div>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
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
    };
}

async function markAsProcessed(gmail, msgId, labelId) {
    await gmail.users.messages.modify({
        userId: "me",
        id: msgId,
        requestBody: { addLabelIds: [labelId] }
    });
    console.log(`[${msgId}] Labeled as processed.`);
}

// --- CORE PROCESSING ---
// Now accepts 'currentCursor' and returns the 'newCursor'
async function processEmails(auth, currentCursorTime) {
    const gmail = google.gmail({ version: "v1", auth });
    const processedLabelId = await getOrCreateLabelId(gmail);

    // Track the newest email time found in THIS batch
    let maxTimeInBatch = currentCursorTime; 

    // Query using the local cursor
    const res = await gmail.users.messages.list({
        userId: "me",
        q: `from:no-reply@paytm.com after:${currentCursorTime} -label:${LABEL_NAME}`, 
    });

    const messages = res.data.messages || [];

    if (messages.length === 0) {
        console.log("No new emails found.");
        return maxTimeInBatch; // Return original time (no change)
    }

    console.log(`Found ${messages.length} new emails...`);

    for (const message of messages) {
        try {
            const mail = await gmail.users.messages.get({
                userId: "me",
                id: message.id,
                format: "full",
            });

            // 1. Get Internal Date (Unix MS) for updating our cursor
            const internalDateMs = parseInt(mail.data.internalDate);
            const internalDateSec = Math.floor(internalDateMs / 1000);

            // 2. Get Header Date (String) for API Payload
            const headers = mail.data.payload.headers;
            const dateHeader = headers.find(h => h.name === "Date")?.value;

            let encodedBody = mail.data.payload.body.data;
            if (!encodedBody) { encodedBody = findHtmlBody(mail.data.payload.parts); }

            if (!encodedBody) {
                console.log(`[${message.id}] Body missing. Marking processed.`);
                await markAsProcessed(gmail, message.id, processedLabelId);
                // Even if body missing, we processed it, so update cursor if it's newer
                if (internalDateSec > maxTimeInBatch) maxTimeInBatch = internalDateSec;
                continue;
            }

            const cleanText = cleanHtmlText(encodedBody);
            const extracted = extractData(cleanText);

            const unixTimestamp = Math.floor(new Date(dateHeader).getTime() / 1000);

            const finalData = { ...extracted, timestamp: dateHeader, unixtimestamp: unixTimestamp };

            if (finalData.amount) {
                console.log(`[${message.id}] Sending ₹${finalData.amount} to API...`);
                await axios.post(API_URL, finalData);
                await markAsProcessed(gmail, message.id, processedLabelId);
                
                // SUCCESS: Update our local max time if this email is newer
                if (internalDateSec > maxTimeInBatch) {
                    maxTimeInBatch = internalDateSec;
                }
            } else {
                console.log(`[${message.id}] Amount parse fail. Marking processed.`);
                await markAsProcessed(gmail, message.id, processedLabelId);
                // Still update time to avoid re-fetching
                if (internalDateSec > maxTimeInBatch) maxTimeInBatch = internalDateSec;
            }

        } catch (err) {
            console.error(`[${message.id}] Failed:`, err.message);
        }
    }

    return maxTimeInBatch; // Return the new newest time
}

// --- POLLING LOOP ---
async function startPolling() {
    const auth = await authorize();

    // 1. Get Start Time from API (ONCE)
    let localCursorTime = await getInitialServerTimestamp();
    console.log(`Starting loop with timestamp: ${localCursorTime}`);

    while (true) {
        try {
            console.log(`\n--- Checking Inbox (after: ${localCursorTime}) ---`);
            
            // 2. Process and get the updated time
            const newTime = await processEmails(auth, localCursorTime);

            // 3. Update local cursor if we moved forward
            if (newTime > localCursorTime) {
                console.log(`Updating local timestamp from ${localCursorTime} -> ${newTime}`);
                localCursorTime = newTime;
            }

        } catch (error) {
            console.error("Critical Error in Loop:", error.message);
        }

        console.log(`Waiting ${POLLING_INTERVAL_MS / 1000}s...`);
        await sleep(POLLING_INTERVAL_MS);
    }
}

startPolling();