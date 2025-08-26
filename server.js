import "dotenv/config";
import express from "express";
import multer from "multer";
import { google } from "googleapis";
import { PassThrough } from "stream";
import cors from "cors";
import https from "https";

// ====== ENV ======
const CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || "").trim();
const CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || "").trim();
const REFRESH_TOKEN = (process.env.GOOGLE_REFRESH_TOKEN || "").trim();
const DRIVE_FOLDER_ID = (process.env.DRIVE_FOLDER_ID || "").trim();
const PORT = Number(process.env.PORT || 8080);
if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !DRIVE_FOLDER_ID) {
  console.error("Missing required env vars. Check .env");
  process.exit(1);
}

// ====== APP & CORS (Express 5 safe) ======
const app = express();

// allow localhost + your prod + vercel previews
const allowed = new Set([
  "http://localhost:5173",
  "https://engagment-zozo-yoyo.vercel.app",
]);
const vercelPreview = /^https:\/\/engagment-zozo-yoyo-.*\.vercel\.app$/;

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (allowed.has(origin) || vercelPreview.test(origin))
        return cb(null, true);
      return cb(null, false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Requested-With", "Authorization"],
    optionsSuccessStatus: 200,
    maxAge: 86400,
  })
);
// Preflight for all paths — Express 5 requires (.*)
app.use(cors());

// ====== GOOGLE CLIENT (keep-alive) ======
const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
oauth2.setCredentials({ refresh_token: REFRESH_TOKEN });

// Keep outbound connections warm to reduce per-file latency
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });
google.options({ agent: keepAliveAgent });

const drive = google.drive({ version: "v3", auth: oauth2 });

// Optional: check auth (do NOT exit on Cloud Run)
(async () => {
  try {
    const { token } = await oauth2.getAccessToken();
    console.log("[AUTH] access token ok:", !!token);
  } catch (e) {
    console.error(
      "[AUTH] refresh failed at startup:",
      e?.response?.data || e.message
    );
  }
})();

// ====== MULTER (memory is fine for images; add limits) ======
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 50,
    fileSize: 25 * 1024 * 1024, // 25 MB/file cap (tune as you like)
  },
});

// Health
app.get("/", (_req, res) => res.send("Drive uploader is running."));

// ====== small helpers ======
function bufferToStream(buffer) {
  const pt = new PassThrough();
  pt.end(buffer);
  return pt;
}

// cache subfolder IDs to avoid repeated Drive .list()
const subfolderCache = new Map(); // key: parentId|lower(name) -> id

async function ensureSubfolder(parentId, name) {
  const key = parentId + "|" + name.toLowerCase();
  const cached = subfolderCache.get(key);
  if (cached) return cached;

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

  let id = data.files?.[0]?.id;
  if (!id) {
    const created = await drive.files.create({
      requestBody: {
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
      },
      fields: "id, name",
      supportsAllDrives: true,
    });
    id = created.data.id;
  }
  subfolderCache.set(key, id);
  return id;
}

// Concurrency limiter (no extra deps)
function createLimiter(max = 5) {
  let running = 0;
  const queue = [];
  const runNext = () => {
    if (running >= max) return;
    const next = queue.shift();
    if (!next) return;
    running++;
    next().finally(() => {
      running--;
      runNext();
    });
  };
  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push(() => fn().then(resolve, reject));
      runNext();
    });
  };
}
const limitDrive = createLimiter(Number(process.env.DRIVE_CONCURRENCY || 5));

// ====== ROUTE: POST /upload ======
app.post("/upload", upload.array("files", 50), async (req, res) => {
  try {
    const files = /** @type {Express.Multer.File[]} */ (req.files || []);
    if (!files.length) {
      return res.status(400).json({ ok: false, error: "No files uploaded" });
    }

    let parentId = DRIVE_FOLDER_ID;
    const subfolderName = (req.body?.subfolderName || "").trim();
    if (subfolderName)
      parentId = await ensureSubfolder(DRIVE_FOLDER_ID, subfolderName);

    // Upload to Drive in parallel with a cap
    const tasks = files.map((f) =>
      limitDrive(async () => {
        const resp = await drive.files.create({
          requestBody: { name: f.originalname, parents: [parentId] },
          media: {
            mimeType: f.mimetype || "application/octet-stream",
            body: bufferToStream(f.buffer),
          },
          fields: "id, name, webViewLink, webContentLink",
          supportsAllDrives: true,
        });
        return {
          id: resp.data.id,
          name: resp.data.name,
          webViewLink: resp.data.webViewLink,
          webContentLink: resp.data.webContentLink,
        };
      })
    );

    const results = await Promise.all(tasks);
    res.json({ ok: true, count: results.length, results });
  } catch (err) {
    console.error("[UPLOAD ERROR]", err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// ====== START ======
app.listen(PORT, "0.0.0.0", () => console.log(`Listening on :${PORT}`));
