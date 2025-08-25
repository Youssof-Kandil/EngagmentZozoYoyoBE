// get-refresh-token.js
import express from "express";
import open from "open";
import { google } from "googleapis";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = "http://localhost:3000/oauth2callback"; // must match console

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars.");
  process.exit(1);
}

const app = express();
const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const SCOPES = ["https://www.googleapis.com/auth/drive.file"];
// drive.file lets you create/manage files you create/upload

app.get("/oauth2callback", async (req, res) => {
  try {
    const { code } = req.query;
    const { tokens } = await oauth2.getToken(String(code));
    // tokens.refresh_token is what we need long-term
    console.log("\n=== OAuth Tokens ===\n", tokens, "\n====================\n");
    res.send(
      "All set! Copy your refresh_token from the terminal and add it to .env"
    );
    process.exit(0);
  } catch (e) {
    console.error(e);
    res.status(500).send(String(e));
    process.exit(1);
  }
});

app.listen(3000, async () => {
  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });
  console.log("Open this URL in your browser to authorize:\n\n", url, "\n");
  await open(url);
});
