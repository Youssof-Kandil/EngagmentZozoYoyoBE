import "dotenv/config";
import express from "express";
import multer from "multer";
import { google } from "googleapis";
import { PassThrough } from "stream";
import cors from "cors";

const CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || "").trim();
const CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || "").trim();
const REFRESH_TOKEN = (process.env.GOOGLE_REFRESH_TOKEN || "").trim();
const DRIVE_FOLDER_ID = (process.env.DRIVE_FOLDER_ID || "").trim();
const PORT = Number(process.env.PORT || 8080);
if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !DRIVE_FOLDER_ID) {
  console.error("Missing required env vars. Check .env");
  process.exit(1);
}
const app = express();

app.use(
  cors({
    origin: [
      "http://localhost:5173", // Vite dev
      "https://engagment-zozo-yoyo.vercel.app", // <-- replace with your real URL
    ],
    methods: ["POST", "GET", "OPTIONS"],
  })
);

console.log("[CFG] client_id:", CLIENT_ID);
console.log("[CFG] secret?", !!CLIENT_SECRET, "refresh?", !!REFRESH_TOKEN);

const upload = multer({ storage: multer.memoryStorage() });

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
oauth2.setCredentials({ refresh_token: REFRESH_TOKEN });

const drive = google.drive({ version: "v3", auth: oauth2 });
(async () => {
  try {
    const { token } = await oauth2.getAccessToken();
    console.log("[AUTH] access token ok:", !!token);
  } catch (e) {
    console.error("[AUTH] refresh failed:", e.response?.data || e.message);
    process.exit(1);
  }
})();
// health
app.get("/", (_, res) => res.send("Drive uploader is running."));
app.use(cors());

// POST /upload  (multipart/form-data)
app.post("/upload", upload.array("files", 50), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ ok: false, error: "No files uploaded" });
    }

    // Optional subfolder name under DRIVE_FOLDER_ID
    const subfolderName = (req.body.subfolderName || "").trim();
    let parentId = DRIVE_FOLDER_ID;
    if (subfolderName) {
      parentId = await ensureSubfolder(DRIVE_FOLDER_ID, subfolderName);
    }

    const results = [];
    for (const f of req.files) {
      const fileMetadata = { name: f.originalname, parents: [parentId] };
      const media = {
        mimeType: f.mimetype || "application/octet-stream",
        body: bufferToStream(f.buffer),
      };

      const resp = await drive.files.create({
        requestBody: fileMetadata,
        media,
        fields: "id, name, webViewLink, webContentLink",
        supportsAllDrives: true, // harmless for My Drive; needed if parent is a Shared Drive
      });

      results.push({
        id: resp.data.id,
        name: resp.data.name,
        webViewLink: resp.data.webViewLink,
        webContentLink: resp.data.webContentLink,
      });
    }

    res.json({ ok: true, count: results.length, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

function bufferToStream(buffer) {
  const pt = new PassThrough();
  pt.end(buffer);
  return pt;
}

async function ensureSubfolder(parentId, name) {
  const q = [
    `'${parentId}' in parents`,
    `name = '${name.replace(/'/g, "\\'")}'`,
    "mimeType = 'application/vnd.google-apps.folder'",
    "trashed = false",
  ].join(" and ");

  const { data } = await drive.files.list({
    q,
    fields: "files(id, name)",
    spaces: "drive",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  if (data.files && data.files.length) return data.files[0].id;

  const folderMeta = {
    name,
    mimeType: "application/vnd.google-apps.folder",
    parents: [parentId],
  };
  const created = await drive.files.create({
    requestBody: folderMeta,
    fields: "id, name",
    supportsAllDrives: true,
  });
  return created.data.id;
}

app.listen(PORT, () => console.log(`http://localhost:${PORT}`));
