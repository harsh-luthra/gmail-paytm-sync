const fs = require("fs");
const readline = require("readline");
const { google } = require("googleapis");

// Load client secrets
const credentials = JSON.parse(fs.readFileSync("credentials.json"));
const { client_secret, client_id, redirect_uris } = credentials.installed;

// Create OAuth2 client
const oAuth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  redirect_uris[0]
);

async function getAccessToken() {
  // Generate the URL users use to authorize this app
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://mail.google.com/"],
  });

  console.log("\n==============================================");
  console.log("  👉 AUTHORIZATION REQUIRED");
  console.log("==============================================\n");
  console.log("Open this link in your browser:\n");
  console.log(authUrl + "\n");

  console.log(
    "After allowing access, Google will redirect to a URL like:\n" +
    "http://localhost/?code=XXXX&scope=...\n"
  );
  console.log("Copy ONLY the 'code' value and paste below.\n");

  // Ask for code
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.question("Enter the authorization code: ", async (code) => {
    rl.close();

    try {
      const { tokens } = await oAuth2Client.getToken(code.trim());
      oAuth2Client.setCredentials(tokens);

      fs.writeFileSync("token.json", JSON.stringify(tokens, null, 2));
      console.log("\n🎉 SUCCESS: token.json file created!");
    } catch (err) {
      console.error("\n❌ ERROR retrieving access token:", err);
    }
  });
}

getAccessToken();
