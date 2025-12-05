const fs = require("fs");
const axios = require("axios");
const { google } = require("googleapis");

const API_URL = "https://kite-pay-api-v1.onrender.com/paytm/payment-sync";
const TIMESTAMP_API_URL = "https://kite-pay-api-v1.onrender.com/paytm/last-timestamp";
const UPDATE_TIMESTAMP_API_URL = "https://kite-pay-api-v1.onrender.com/paytm/update-last-timestamp";
const LABEL_NAME = "PROCESSED"; 
const POLLING_INTERVAL_MS = 30000; // 30 Seconds
const MAIL_INTERVAL_MS = 4000; // 4 Seconds

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
        const timeData = response.data?.last_mail_timestamp;

        if (!timeData) {
            console.log("No timestamp from server. Defaulting to 24h ago.");
            return Math.floor(Date.now() / 1000) - 86400; 
        }

        console.log(`Server raw response: ${timeData}`);

        // CHECK 1: Is it already a Number (Unix Timestamp)?
        // (Checks if input is only digits)
        if (!isNaN(timeData)) {
            const timestamp = Number(timeData);
            
            // Heuristic: Unix Seconds are usually 10 digits (e.g. 1764633600)
            // Unix Milliseconds are 13 digits (e.g. 1764633600000)
            
            if (timestamp > 9999999999) {
                // It is Milliseconds -> Convert to Seconds
                return Math.floor(timestamp / 1000);
            } else {
                // It is ALREADY Seconds -> Return as is
                return timestamp;
            }
        }

        // CHECK 2: It is a Date String (e.g., "Sun, 30 Nov...")
        const dateObj = new Date(timeData);
        if (isNaN(dateObj.getTime())) {
            console.log("Invalid date format. Defaulting to 24h ago.");
            return Math.floor(Date.now() / 1000) - 86400;
        }

        // Convert Date Object to Seconds
        return Math.floor(dateObj.getTime() / 1000);

    } catch (error) {
        console.error("Initialization Failed (Server might be down). Defaulting to 1h ago.");
        return Math.floor(Date.now() / 1000) - 3600; 
    }
}

async function updateServerTimestamp(timestamp) {
    try {
        // We convert the numeric timestamp to a string or keep it number 
        // depending on what your backend expects. Sending JSON is standard.
        await axios.post(UPDATE_TIMESTAMP_API_URL, {
            last_mail_timestamp: timestamp
        });
        console.log(`[Sync] Server timestamp updated to: ${timestamp}`);
    } catch (error) {
        console.error(`[Sync] Failed to update server timestamp: ${error.message}`);
        // We don't throw error here because we don't want to stop the polling loop 
        // just because the update failed.
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

        // Matches: "Nov 26, 2025, 10:31 AM"
        // Explanation: [A-Z][a-z]{2} matches "Nov", \d{1,2} matches "26", etc.
        datetimeString: text.match(/([A-Z][a-z]{2}\s\d{1,2},\s\d{4},\s\d{1,2}:\d{2}\s[APM]{2})/)?.[1] || null
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
    let maxInternalTimeInBatch = currentCursorTime; 

    const res = await gmail.users.messages.list({
        userId: "me",
        q: `from:no-reply@paytm.com after:${currentCursorTime} -label:${LABEL_NAME}`, 
    });

    const messages = res.data.messages || [];
    if (messages.length === 0) {
        console.log("No new emails found.");
        return maxInternalTimeInBatch; 
    }

    // --- FIX: REVERSE ORDER (Oldest First -> Newest Last) ---
    messages.reverse(); 
    // --------------------------------------------------------

    console.log(`Found ${messages.length} new emails...`);

    for (const message of messages) {
        try {
            const mail = await gmail.users.messages.get({
                userId: "me",
                id: message.id,
                format: "full",
            });

            // 1. TIMESTAMPS FOR SYNCING
            const internalDateMs = parseInt(mail.data.internalDate);
            const internalDateSec = Math.floor(internalDateMs / 1000);
            const headers = mail.data.payload.headers;
            const dateHeader = headers.find(h => h.name === "Date")?.value;

            // 2. PARSE BODY
            let encodedBody = mail.data.payload.body.data;
            if (!encodedBody) encodedBody = findHtmlBody(mail.data.payload.parts);

            if (!encodedBody) {
                console.log(`[${message.id}] Body missing. Marking processed.`);
                await markAsProcessed(gmail, message.id, processedLabelId);
                if (internalDateSec > maxInternalTimeInBatch) maxInternalTimeInBatch = internalDateSec;
                continue;
            }

            const cleanText = cleanHtmlText(encodedBody);
            const extracted = extractData(cleanText);

            // 3. PARSE TRANSACTION TIME (From Body)
            let txnTimestamp = null;
            if (extracted.datetimeString) {
                // Input: "Nov 26, 2025, 10:31 AM"
                // We add " GMT+0530" to force India Standard Time
                const fullDateStr = extracted.datetimeString + " GMT+0530";
                const txnDateObj = new Date(fullDateStr);
                
                if (!isNaN(txnDateObj.getTime())) {
                    txnTimestamp = Math.floor(txnDateObj.getTime() / 1000);
                }
            }

            // 4. PREPARE API TIMESTAMP (From Header - for syncing logic)
            let emailHeaderTimestamp = internalDateSec; 
            if (dateHeader) {
                const parsedHeaderTime = Math.floor(new Date(dateHeader).getTime() / 1000);
                if (!isNaN(parsedHeaderTime)) emailHeaderTimestamp = parsedHeaderTime;
            }

            // 5. CONSTRUCT FINAL PAYLOAD
            const finalData = { 
                amount: extracted.amount,
                orderId: extracted.orderId,
                accountOf: extracted.accountOf,
                fromUpi: extracted.fromUpi,
                
                // "timestamp" = The Email Date (Used for your internal server syncing)
                timestamp: emailHeaderTimestamp,
                
                // "txn_time" = The Actual Payment Date (From body text)
                txn_time: txnTimestamp || emailHeaderTimestamp // Fallback to email time if body parse fails
            };

            if (finalData.amount) {
                console.log(`[${message.id}] ₹${finalData.amount} | Email Time: ${finalData.timestamp} | Txn Time: ${finalData.txn_time}`);
                
                await axios.post(API_URL, finalData);
                await markAsProcessed(gmail, message.id, processedLabelId);
                
                if (internalDateSec > maxInternalTimeInBatch) {
                    maxInternalTimeInBatch = internalDateSec;
                }

                // --- 2. ADD WAIT HERE (Throttle) ---
                // Wait MAIL_INTERVAL_MS seconds before touching the next email
                await sleep(MAIL_INTERVAL_MS);

            } else {
                console.log(`[${message.id}] Amount parse fail.`);
                await markAsProcessed(gmail, message.id, processedLabelId);
                if (internalDateSec > maxInternalTimeInBatch) maxInternalTimeInBatch = internalDateSec;
            }

        } catch (err) {
            console.error(`[${message.id}] Failed:`, err.message);
        }
    }

    return maxInternalTimeInBatch; 
}

// --- POLLING LOOP ---
async function startPolling() {
    const auth = await authorize();

    // 1. Get Start Time from API (ONCE)
    let localCursorTime = await getInitialServerTimestamp();
    let lastSavedTime = localCursorTime; // Track what we last sent to server

    console.log(`Starting loop with timestamp: ${localCursorTime}`);

    while (true) {
        try {
            console.log(`\n--- Checking Inbox (after: ${localCursorTime}) ---`);
            
            // 2. Process and get the updated time
            const newTime = await processEmails(auth, localCursorTime);

            // 3. Update local cursor if we moved forward
            if (newTime > localCursorTime) {
                console.log(`Local timestamp advanced: ${localCursorTime} -> ${newTime}`);
                localCursorTime = newTime;
            }

        } catch (error) {
            console.error("Critical Error in Loop:", error.message);
        }

        // --- NEW: UPDATE SERVER IF TIME CHANGED ---
        if (localCursorTime > lastSavedTime) {
            console.log("New emails were processed. Syncing timestamp to server...");
            await updateServerTimestamp(localCursorTime);
            lastSavedTime = localCursorTime; // Update our tracker
        }

        console.log(`Waiting ${POLLING_INTERVAL_MS / 1000}s...`);
        await sleep(POLLING_INTERVAL_MS);
    }
}

startPolling();