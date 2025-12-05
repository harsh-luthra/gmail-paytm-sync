const fs = require('fs');
const { google } = require('googleapis');

async function main() {
    const credentials = JSON.parse(fs.readFileSync('credentials.json'));
    const token = JSON.parse(fs.readFileSync('token.json'));

    const { client_secret, client_id, redirect_uris } = credentials.installed;

    const oAuth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    oAuth.setCredentials(token);

    const gmail = google.gmail({ version: "v1", auth: oAuth });

    const res = await gmail.users.watch({
        userId: "me",
        requestBody: {
            topicName: "projects/gmail-realtime-sync-paytm/topics/gmail-paytm-sync",
            labelIds: ["INBOX"],
        },
    });

    console.log("Watch started:", res.data);
}

main();



