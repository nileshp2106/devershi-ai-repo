require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ✅ Node < 18 compatibility
const fetch = require("node-fetch");

const app = express();
app.use(cors());

// NOTE: JSON only for non-multipart routes
app.use(express.json({ limit: "2mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB per file
});

function parseCardText(text) {
  if (!text) return {};

  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let firstName = "";
  let lastName = "";
  let company = "";
  let phone = "";
  let email = "";
  let website = "";

  email = lines.find((l) => /\S+@\S+\.\S+/.test(l)) || "";
  phone = lines.find((l) => /(\+?\d[\d\s\-()]{6,})/.test(l)) || "";
  website = lines.find((l) => /(www\.|https?:\/\/)/i.test(l)) || "";

  const filteredForName = lines
    .filter((l) => !/\S+@\S+\.\S+/.test(l))
    .filter((l) => !/(www\.|https?:\/\/)/i.test(l))
    .filter((l) => !/(\+?\d[\d\s\-()]{6,})/.test(l))
    .filter(
      (l) =>
        !/(geschäftsführer|ceo|manager|director|founder|owner|sales|marketing)/i.test(
          l
        )
    );

  const nameLine = filteredForName[0] || "";
  const parts = nameLine.split(/\s+/).filter(Boolean);

  if (parts.length >= 2) {
    firstName = parts[0];
    lastName = parts.slice(1).join(" ");
  } else {
    firstName = filteredForName[0] || "";
    lastName = filteredForName[1] || "";
  }

  const COMPANY_BLACKLIST = [
    "geschäftsführer",
    "ceo",
    "manager",
    "director",
    "founder",
    "owner",
    "sales",
    "marketing",
  ];

  company =
    lines.find((l) => {
      const low = l.toLowerCase();
      if (!l) return false;
      if (firstName && l.includes(firstName)) return false;
      if (/\S+@\S+\.\S+/.test(l)) return false;
      if (/(www\.|https?:\/\/)/i.test(l)) return false;
      if (/(\+?\d[\d\s\-()]{6,})/.test(l)) return false;
      if (COMPANY_BLACKLIST.some((b) => low.includes(b))) return false;
      if (
        /(straße|str\.|platz|road|street|ave|blvd|münster|berlin|deutschland|germany)/i.test(
          l
        )
      )
        return false;
      return true;
    }) || "";

  return {
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    company: company.trim(),
    phone: phone.trim(),
    email: email.trim(),
    website: website.trim(),
  };
}

// -------------------------
// Google Vision OCR (AWS safe)
// -------------------------
let visionClient = null;

function getVisionClient() {
  if (visionClient) return visionClient;

  const vision = require("@google-cloud/vision");

  // ✅ Preferred for AWS: base64 JSON stored in env var
  if (process.env.GOOGLE_VISION_JSON_BASE64) {
    const keyFilePath = path.join(os.tmpdir(), "vision-key.json");

    if (!fs.existsSync(keyFilePath)) {
      const decoded = Buffer.from(
        process.env.GOOGLE_VISION_JSON_BASE64,
        "base64"
      ).toString("utf8");

      fs.writeFileSync(keyFilePath, decoded, "utf8");
    }

    console.log("Vision keyfile (tmp):", keyFilePath);

    visionClient = new vision.ImageAnnotatorClient({
      keyFilename: keyFilePath,
    });

    return visionClient;
  }

  // ✅ Local dev fallback: file path via env vars
  const keyPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    process.env.VISION_KEYFILE ||
    path.resolve(process.cwd(), "vision-key.json");

  console.log("Vision keyfile:", keyPath);

  visionClient = new vision.ImageAnnotatorClient({
    keyFilename: keyPath,
  });

  return visionClient;
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.post(
  "/api/extract-business-card",
  upload.single("cardImage"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No cardImage uploaded." });
      }

      const client = getVisionClient();
      const [result] = await client.textDetection(req.file.buffer);

      const text = result?.fullTextAnnotation?.text || "";
      console.log("OCR text length:", text.length);

      const parsed = parseCardText(text);

      return res.json({
        success: true,
        text,
        parsed,
        ...parsed,
      });
    } catch (err) {
      console.error("OCR error FULL:", err);
      return res.status(500).json({ error: err?.message || "OCR failed" });
    }
  }
);

// -------------------------
// SUBMIT -> N8N WEBHOOK
// -------------------------
app.post(
  "/api/submit-inquiry",
  upload.fields([
    { name: "cardImage", maxCount: 1 },
    { name: "attachments", maxCount: 25 },
  ]),
  async (req, res) => {
    try {
      const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
      const N8N_SECRET = process.env.N8N_SECRET;

      if (!N8N_WEBHOOK_URL) {
        return res
          .status(500)
          .json({ error: "Missing N8N_WEBHOOK_URL in backend/.env" });
      }
      if (!N8N_SECRET) {
        return res
          .status(500)
          .json({ error: "Missing N8N_SECRET in backend/.env" });
      }

      const payloadRaw = req.body?.payload || "{}";
      const payload = JSON.parse(payloadRaw);

      const attachments = (req.files?.attachments || []).map((f) => ({
        name: f.originalname,
        type: f.mimetype,
        size: f.size,
      }));

      // ✅ Send everything to n8n (payload + attachments)
      const n8nBody = {
        ...payload,
        attachments,
        uploads: attachments.map((a) => a.name).join("; "), // helpful for sheet
        submittedAt: payload.submittedAt || new Date().toISOString(),
      };

      const n8nRes = await fetch(N8N_WEBHOOK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-hb-secret": N8N_SECRET,
        },
        body: JSON.stringify(n8nBody),
      });

      const n8nText = await n8nRes.text();

      if (!n8nRes.ok) {
        console.error("n8n error:", n8nText);
        return res.status(500).json({
          error: "n8n failed",
          details: n8nText,
        });
      }

      return res.json({
        ok: true,
        attachmentsCount: attachments.length,
        n8nResponse: n8nText,
      });
    } catch (err) {
      console.error("submit error:", err);
      return res.status(500).json({ error: err?.message || "Submit failed" });
    }
  }
);

console.log("N8N_WEBHOOK_URL:", process.env.N8N_WEBHOOK_URL || "(not set)");

const PORT = process.env.PORT || 5001;
app.listen(PORT, () =>
  console.log(`Backend running on http://localhost:${PORT}`)
);
