const fs = require('fs');
const http = require('http');
const url = require('url');
const { google } = require('googleapis');
const open = require('open'); // Optional: helps open browser automatically
const destroyer = require('server-destroy'); // Optional: helps close server cleanly

// If you don't want to install 'open' or 'server-destroy', 
// you can manually open the link and Ctrl+C the script after success.
// Run: npm install open server-destroy

const SCOPES = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.modify'
];
const TOKEN_PATH = 'token.json';
const REDIRECT_URI = 'http://localhost:3000/oauth2callback';

async function main() {
    const content = fs.readFileSync('credentials.json');
    const credentials = JSON.parse(content);
    const { client_secret, client_id } = credentials.installed;

    // CRITICAL: We force the Redirect URI to match what you put in Cloud Console
    const oAuth2Client = new google.auth.OAuth2(
        client_id, 
        client_secret, 
        REDIRECT_URI
    );

    // Create a temporary local server to catch the callback
    const server = http.createServer(async (req, res) => {
        try {
            if (req.url.indexOf('/oauth2callback') > -1) {
                const qs = new url.URL(req.url, 'http://localhost:3000').searchParams;
                const code = qs.get('code');
                
                res.end('Authentication successful! You can close this tab.');
                server.destroy(); // Stop the server
                
                console.log('Code received. Fetching token...');
                const { tokens } = await oAuth2Client.getToken(code);
                oAuth2Client.setCredentials(tokens);
                
                fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
                console.log(`\n>>> SUCCESS! Token saved to ${TOKEN_PATH}`);
                console.log('You can now run "node index.js"');
                process.exit(0);
            }
        } catch (e) {
            console.error(e);
            res.end('Error during authentication');
            server.destroy();
        }
    }).listen(3000, () => {
        // Open the browser to the authorize URL
        const authUrl = oAuth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: SCOPES,
        });
        
        console.log('Listening on port 3000...');
        console.log('Please visit this URL to authorize:', authUrl);
        
        // Try to open automatically (requires 'npm install open')
        // import('open').then(open => open.default(authUrl)).catch(() => {});
    });
    
    destroyer(server);
}

main().catch(console.error);
