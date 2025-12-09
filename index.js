const fs = require("fs");
const axios = require("axios");
const { google } = require("googleapis");

// --- CONFIGURATION ---
const API_URL = "https://kite-pay-api-v1.onrender.com/paytm/payment-sync";
const TIMESTAMP_API_URL = "https://kite-pay-api-v1.onrender.com/paytm/last-timestamp";
const UPDATE_TIMESTAMP_API_URL = "https://kite-pay-api-v1.onrender.com/paytm/update-last-timestamp";
const LABEL_NAME = "PROCESSED"; 
const POLLING_INTERVAL_MS = 30000; // 30 Seconds check interval
const MAIL_INTERVAL_MS = 4000;     // 4 Seconds wait between emails (Throttle)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// --- MIDDLEWARE ---
// Allows the server to accept JSON data (like your payment sync script sends)
app.use(express.json());
// Allows requests from other domains (e.g., your frontend)
app.use(cors());

// --- ROUTES ---

// 1. Health Check (GET request)
app.get('/', (req, res) => {
    res.send({ status: 'Online', message: 'Server is running successfully!' });
});

// --- START SERVER ---
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});

async function authorize() {
    try {
        const credentials = JSON.parse(fs.readFileSync("credentials.json"));
        const { client_secret, client_id, redirect_uris } = credentials.installed;
        const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

        if (fs.existsSync("token.json")) {
            oAuth2Client.setCredentials(JSON.parse(fs.readFileSync("token.json")));
            return oAuth2Client;
        }
        console.log("Token missing. Run your local auth script first to generate token.json.");
        process.exit(1);
    } catch (error) {
        console.error("Authorization Error:", error.message);
        process.exit(1);
    }
}

// --- 1. STATE MANAGEMENT (Server Timestamp) ---

async function getInitialServerTimestamp() {
    try {
        console.log("Initializing: Fetching last timestamp from server...");
        const response = await axios.get(TIMESTAMP_API_URL);
        const timeData = response.data?.last_mail_timestamp;

        if (!timeData) {
            console.log("No timestamp from server. Defaulting to 24h ago.");
            return Math.floor(Date.now() / 1000) - 86400; 
        }

        console.log(`Server raw response: ${timeData}`);

        // CHECK 1: Is it numeric?
        if (!isNaN(timeData)) {
            const timestamp = Number(timeData);
            // Convert Milliseconds to Seconds if needed
            if (timestamp > 9999999999) {
                return Math.floor(timestamp / 1000);
            } else {
                return timestamp;
            }
        }

        // CHECK 2: Is it a Date String?
        const dateObj = new Date(timeData);
        if (isNaN(dateObj.getTime())) {
            console.log("Invalid date format from server. Defaulting to 24h ago.");
            return Math.floor(Date.now() / 1000) - 86400;
        }

        return Math.floor(dateObj.getTime() / 1000);

    } catch (error) {
        console.error("Initialization Failed (Server might be down). Defaulting to 1h ago.");
        return Math.floor(Date.now() / 1000) - 3600; 
    }
}

async function updateServerTimestamp(timestamp) {
    try {
        await axios.post(UPDATE_TIMESTAMP_API_URL, {
            last_mail_timestamp: timestamp
        });
        console.log(`[Sync] Server timestamp updated to: ${timestamp}`);
    } catch (error) {
        console.error(`[Sync] Failed to update server timestamp: ${error.message}`);
    }
}

// --- 2. GMAIL UTILITIES ---

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

async function markAsProcessed(gmail, msgId, labelId) {
    await gmail.users.messages.modify({
        userId: "me",
        id: msgId,
        requestBody: { addLabelIds: [labelId] }
    });
    console.log(`[${msgId}] Labeled as processed.`);
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

// --- 3. PARSING LOGIC ---

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
        accountOf: text.match(/In Account of\s*(.*?)\s*(?:Transaction|Nov|Dec|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct)/i)?.[1]?.trim() || null,
        // Robust "From" capture: gets everything between "From" and "In Account of"
        fromUpi: text.match(/From\s*(.*?)\s*In Account of/i)?.[1]?.trim() || null,
        
        // Matches standard date format in email body
        datetimeString: text.match(/([A-Z][a-z]{2}\s\d{1,2},\s\d{4},\s\d{1,2}:\d{2}\s[APM]{2})/)?.[1] || null
    };
}

// --- 4. CORE PROCESSING LOOP ---

async function processEmails(auth, currentCursorTime) {
    const gmail = google.gmail({ version: "v1", auth });
    const processedLabelId = await getOrCreateLabelId(gmail);
    let maxInternalTimeInBatch = currentCursorTime; 

    // Fetch emails newer than our cursor
    const res = await gmail.users.messages.list({
        userId: "me",
        q: `from:no-reply@paytm.com after:${currentCursorTime} -label:${LABEL_NAME}`, 
    });

    const messages = res.data.messages || [];
    if (messages.length === 0) {
        console.log("No new emails found.");
        return maxInternalTimeInBatch; 
    }

    // Process Oldest -> Newest (So if we crash, we resume from the specific failed time)
    messages.reverse(); 

    console.log(`Found ${messages.length} new emails. Processing...`);

    for (const message of messages) {
        try {
            const mail = await gmail.users.messages.get({
                userId: "me",
                id: message.id,
                format: "full",
            });

            // 1. Get Email Timestamp (Internal Date)
            const internalDateMs = parseInt(mail.data.internalDate);
            const internalDateSec = Math.floor(internalDateMs / 1000);
            
            // 2. Parse Body
            let encodedBody = mail.data.payload.body.data;
            if (!encodedBody) encodedBody = findHtmlBody(mail.data.payload.parts);

            if (!encodedBody) {
                console.log(`[${message.id}] Body missing. Marking processed (skip).`);
                await markAsProcessed(gmail, message.id, processedLabelId);
                // Safe to advance cursor because this is a data error, not a network error
                if (internalDateSec > maxInternalTimeInBatch) maxInternalTimeInBatch = internalDateSec;
                continue;
            }

            const cleanText = cleanHtmlText(encodedBody);
            const extracted = extractData(cleanText);

            // 3. Parse Transaction Time (from body text)
            let txnTimestamp = null;
            if (extracted.datetimeString) {
                const fullDateStr = extracted.datetimeString + " GMT+0530"; // Force IST
                const txnDateObj = new Date(fullDateStr);
                if (!isNaN(txnDateObj.getTime())) {
                    txnTimestamp = Math.floor(txnDateObj.getTime() / 1000);
                }
            }

            // Fallback for timestamp
            const finalTimestamp = txnTimestamp || internalDateSec;

            const finalData = { 
                amount: extracted.amount,
                orderId: extracted.orderId,
                accountOf: extracted.accountOf,
                fromUpi: extracted.fromUpi,
                timestamp: internalDateSec, // The email receive time
                txn_time: finalTimestamp    // The actual payment time
            };

            if (finalData.amount) {
                console.log(`[${message.id}] Processing ₹${finalData.amount} | ID: ${finalData.orderId}`);
                
                // --- STEP A: SEND TO API ---
                await axios.post(API_URL, finalData);
                
                // --- STEP B: MARK PROCESSED (Only if Step A succeeds) ---
                await markAsProcessed(gmail, message.id, processedLabelId);
                
                // --- STEP C: UPDATE CURSOR ---
                if (internalDateSec > maxInternalTimeInBatch) {
                    maxInternalTimeInBatch = internalDateSec;
                }

                // Throttle
                await sleep(MAIL_INTERVAL_MS);

            } else {
                console.log(`[${message.id}] Failed to parse amount. Marking processed to skip.`);
                await markAsProcessed(gmail, message.id, processedLabelId);
                if (internalDateSec > maxInternalTimeInBatch) maxInternalTimeInBatch = internalDateSec;
            }

        } catch (err) {
            console.error(`[${message.id}] CRITICAL ERROR (Network/API): ${err.message}`);
            
            // !!! SAFETY BREAK !!!
            // We stop the loop immediately. 
            // We do NOT update maxInternalTimeInBatch.
            // On the next poll, we will fetch this exact same email again and retry.
            break; 
        }
    }

    return maxInternalTimeInBatch; 
}

// --- 5. POLLING LOOP ---

async function startPolling() {
    const auth = await authorize();

    // 1. Get Start Time from API (ONCE)
    let localCursorTime = await getInitialServerTimestamp();
    let lastSavedTime = localCursorTime; 

    console.log(`Starting loop with timestamp: ${localCursorTime}`);

    while (true) {
        try {
            console.log(`\n--- Checking Inbox (after: ${localCursorTime}) ---`);
            
            // 2. Process and get the new cursor position
            const newTime = await processEmails(auth, localCursorTime);

            // 3. If we moved forward, update local cursor
            if (newTime > localCursorTime) {
                console.log(`Local cursor advanced: ${localCursorTime} -> ${newTime}`);
                localCursorTime = newTime;
            }

            // 4. Sync to Server (Save state)
            if (localCursorTime > lastSavedTime) {
                console.log("Syncing new timestamp to server...");
                await updateServerTimestamp(localCursorTime);
                lastSavedTime = localCursorTime;
            }

        } catch (error) {
            console.error("Global Loop Error:", error.message);
        }

        console.log(`Sleeping for ${POLLING_INTERVAL_MS / 1000}s...`);
        await sleep(POLLING_INTERVAL_MS);
    }
}

// Start
startPolling();
