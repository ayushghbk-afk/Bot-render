const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage
} = require("@whiskeysockets/baileys");

const { Boom } = require("@hapi/boom");
const { createClient } = require("@supabase/supabase-js");
const pino = require("pino");
const QRCode = require("qrcode");
const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const FormData = require("form-data");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const { create, all } = require("mathjs");

const math = create(all);
math.import({
  import: function () { throw new Error('Function import is disabled'); },
  createUnit: function () { throw new Error('Function createUnit is disabled'); },
  evaluate: function () { throw new Error('Function evaluate is disabled'); },
  parse: function () { throw new Error('Function parse is disabled'); },
  compile: function () { throw new Error('Function compile is disabled'); }
}, { override: true });

const logger = pino({ level: "silent" });

/* =========================================================
   CONFIG
========================================================= */

const CONFIG = {
  PORT: Number(process.env.PORT || 3000),
  SESSION_DIR: process.env.SESSION_DIR || "./auth_session",
  SUPABASE_URL: process.env.SUPABASE_URL || "",
  SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY || "",
  AI_PROXY_URL: process.env.AI_PROXY_URL || "https://groq-proxy.mr-hackerdon808.workers.dev/",
  AI_MODEL: process.env.AI_MODEL || "openai/gpt-oss-120b",
  AI_NAME: process.env.AI_NAME || "Ayush AI",
  MAX_HISTORY: Number(process.env.MAX_HISTORY || 10),
  TEMP_DIR: process.env.TEMP_DIR || "./temp",
  MAX_IMAGE_SIZE: Number(process.env.MAX_IMAGE_SIZE || 10 * 1024 * 1024),
  MAX_VIDEO_SIZE: Number(process.env.MAX_VIDEO_SIZE || 50 * 1024 * 1024),
  MAX_DOCUMENT_SIZE: Number(process.env.MAX_DOCUMENT_SIZE || 20 * 1024 * 1024),
  SIGHTENGINE_API_USER: process.env.SIGHTENGINE_API_USER || "",
  SIGHTENGINE_API_SECRET: process.env.SIGHTENGINE_API_SECRET || "",
  AI_RATE_LIMIT: Number(process.env.AI_RATE_LIMIT || 10),
  MEDIA_RATE_LIMIT: Number(process.env.MEDIA_RATE_LIMIT || 3),
};

/* =========================================================
   REQUIRED ENVIRONMENT VARIABLES
========================================================= */

if (!CONFIG.SUPABASE_URL) {
  console.error("❌ SUPABASE_URL is missing");
  process.exit(1);
}

if (!CONFIG.SUPABASE_SECRET_KEY) {
  console.error("❌ SUPABASE_SECRET_KEY is missing");
  process.exit(1);
}

/* =========================================================
   SUPABASE
========================================================= */

const supabase = createClient(
  CONFIG.SUPABASE_URL,
  CONFIG.SUPABASE_SECRET_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

console.log("✅ Supabase initialized");

/* =========================================================
   WHATSAPP STATE
========================================================= */

fs.mkdirSync(CONFIG.SESSION_DIR, { recursive: true });
fs.mkdirSync(CONFIG.TEMP_DIR, { recursive: true });

let sock = null;
let latestQR = null;
let botConnected = false;
let reconnecting = false;
let reconnectAttempts = 0;

// Message processing
const processedMessages = new Map();
const userQueues = new Map();
const pendingLinks = new Map();

// Rate limiting
const aiRateLimit = new Map();
const mediaRateLimit = new Map();

/* =========================================================
   HELPERS
========================================================= */

function sendJSON(res, status, data) {
  if (res.headersSent) return;
  
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  
  res.end(JSON.stringify(data));
}

function generateTempFileName(extension = ".jpg") {
  const randomName = crypto.randomBytes(16).toString("hex");
  return path.join(CONFIG.TEMP_DIR, `${randomName}${extension}`);
}

function cleanupTempFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error("Failed to cleanup temp file:", error);
  }
}

function extractURL(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const matches = text.match(urlRegex);
  return matches ? matches[0] : null;
}

function isYouTubeUrl(url) {
  return url.includes("youtube.com") || url.includes("youtu.be");
}

function isInstagramUrl(url) {
  return url.includes("instagram.com");
}

function isTikTokUrl(url) {
  return url.includes("tiktok.com");
}

function isFacebookUrl(url) {
  return url.includes("facebook.com") || url.includes("fb.watch");
}

function isTwitterUrl(url) {
  return url.includes("twitter.com") || url.includes("x.com");
}

function isSupportedPlatform(url) {
  return isYouTubeUrl(url) || isInstagramUrl(url) || isTikTokUrl(url) || isFacebookUrl(url) || isTwitterUrl(url);
}

function checkRateLimit(map, jid, limit) {
  const now = Date.now();
  const userLimit = map.get(jid);
  
  if (!userLimit || now > userLimit.resetTime) {
    map.set(jid, { count: 1, resetTime: now + 60000 });
    return true;
  }
  
  if (userLimit.count >= limit) {
    return false;
  }
  
  userLimit.count++;
  return true;
}

function isSafeUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function cleanOldProcessedMessages() {
  const now = Date.now();
  const thirtyMinutes = 30 * 60 * 1000;
  
  for (const [id, timestamp] of processedMessages.entries()) {
    if (now - timestamp > thirtyMinutes) {
      processedMessages.delete(id);
    }
  }
}

function cleanOldTempFiles() {
  try {
    const files = fs.readdirSync(CONFIG.TEMP_DIR);
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    
    files.forEach(file => {
      const filePath = path.join(CONFIG.TEMP_DIR, file);
      const stats = fs.statSync(filePath);
      
      if (now - stats.mtimeMs > oneHour) {
        cleanupTempFile(filePath);
      }
    });
  } catch (error) {
    console.error("Temp cleanup error:", error);
  }
}

/* =========================================================
   DOCUMENT PROCESSING
========================================================= */

async function extractTextFromDocument(documentData) {
  try {
    const { buffer, mimetype, filename } = documentData;
    
    if (mimetype.includes("pdf") || filename.endsWith(".pdf")) {
      const data = await pdfParse(buffer);
      return data.text.slice(0, 5000);
    }
    
    if (mimetype.includes("docx") || filename.endsWith(".docx")) {
      const result = await mammoth.extractRawText({ buffer });
      return result.value.slice(0, 5000);
    }
    
    if (mimetype.includes("text") || filename.endsWith(".txt")) {
      return buffer.toString("utf8").slice(0, 5000);
    }
    
    if (mimetype.includes("json") || filename.endsWith(".json")) {
      try {
        const parsed = JSON.parse(buffer.toString("utf8"));
        return JSON.stringify(parsed, null, 2).slice(0, 5000);
      } catch {
        return buffer.toString("utf8").slice(0, 5000);
      }
    }
    
    if (mimetype.includes("csv") || filename.endsWith(".csv")) {
      return buffer.toString("utf8").slice(0, 5000);
    }
    
    return buffer.toString("utf8").slice(0, 5000);
  } catch (error) {
    console.error("Text extraction error:", error);
    return null;
  }
}

async function downloadAndProcessDocument(message) {
  try {
    const documentMessage = message.message?.documentMessage;

    if (!documentMessage) {
      return null;
    }

    const fileSize = documentMessage.fileLength || 0;
    if (fileSize > CONFIG.MAX_DOCUMENT_SIZE) {
      throw new Error(`Document too large. Maximum size is ${CONFIG.MAX_DOCUMENT_SIZE / (1024 * 1024)}MB`);
    }

    const filename = documentMessage.fileName || "document";
    const mimetype = documentMessage.mimetype || "";
    
    const buffer = await downloadMediaMessage(
      message,
      "buffer",
      {},
      {
        logger,
        reuploadRequest: sock.updateMediaMessage
      }
    );

    if (!buffer) {
      throw new Error("Failed to download document");
    }

    if (buffer.length > CONFIG.MAX_DOCUMENT_SIZE) {
      throw new Error(`Document too large. Maximum size is ${CONFIG.MAX_DOCUMENT_SIZE / (1024 * 1024)}MB`);
    }

    const extension = path.extname(filename) || ".txt";
    const tempFilePath = generateTempFileName(extension);
    fs.writeFileSync(tempFilePath, buffer);

    return {
      buffer,
      tempFilePath,
      mimetype,
      filename,
      fileSize: buffer.length
    };
  } catch (error) {
    console.error("Document download error:", error);
    throw error;
  }
}

/* =========================================================
   IMAGE PROCESSING
========================================================= */

async function downloadAndProcessImage(message) {
  try {
    const imageMessage = message.message?.imageMessage;

    if (!imageMessage) {
      return null;
    }

    const fileSize = imageMessage.fileLength || 0;
    if (fileSize > CONFIG.MAX_IMAGE_SIZE) {
      throw new Error(`Image too large. Maximum size is ${CONFIG.MAX_IMAGE_SIZE / (1024 * 1024)}MB`);
    }

    let extension = ".jpg";
    const mimetype = imageMessage.mimetype || "";
    
    if (mimetype.includes("png")) extension = ".png";
    else if (mimetype.includes("webp")) extension = ".webp";
    else if (mimetype.includes("gif")) extension = ".gif";

    const buffer = await downloadMediaMessage(
      message,
      "buffer",
      {},
      {
        logger,
        reuploadRequest: sock.updateMediaMessage
      }
    );

    if (!buffer) {
      throw new Error("Failed to download image");
    }

    if (buffer.length > CONFIG.MAX_IMAGE_SIZE) {
      throw new Error(`Image too large. Maximum size is ${CONFIG.MAX_IMAGE_SIZE / (1024 * 1024)}MB`);
    }

    const tempFilePath = generateTempFileName(extension);
    fs.writeFileSync(tempFilePath, buffer);

    return {
      buffer,
      tempFilePath,
      mimetype,
      fileSize: buffer.length
    };
  } catch (error) {
    console.error("Image download error:", error);
    throw error;
  }
}

async function analyzeImageWithSightengine(imageBuffer, mimetype) {
  if (!CONFIG.SIGHTENGINE_API_USER || !CONFIG.SIGHTENGINE_API_SECRET) {
    return null;
  }
  
  try {
    const form = new FormData();
    
    form.append("media", imageBuffer, {
      filename: `image.${mimetype.split("/")[1] || "jpg"}`,
      contentType: mimetype
    });
    
    form.append("models", "genai,text");
    form.append("api_user", CONFIG.SIGHTENGINE_API_USER);
    form.append("api_secret", CONFIG.SIGHTENGINE_API_SECRET);

    const response = await axios({
      method: "post",
      url: "https://api.sightengine.com/1.0/check.json",
      data: form,
      headers: form.getHeaders(),
      timeout: 30000
    });

    if (response.data) {
      const parts = [];
      
      if (response.data.genai?.description) {
        parts.push(`Description: ${response.data.genai.description}`);
      }
      
      if (response.data.text?.text) {
        parts.push(`Text: ${response.data.text.text}`);
      }
      
      return parts.length > 0 ? parts.join("\n") : null;
    }
    
    return null;
  } catch (error) {
    console.error("Sightengine error:", error.message);
    return null;
  }
}

/* =========================================================
   MEDIA DOWNLOAD
========================================================= */

async function downloadVideoFromURL(url) {
  try {
    const apis = [
      `https://api.vevioz.com/api/button/${encodeURIComponent(url)}`,
      `https://api.davidcyriltech.my.id/download/${encodeURIComponent(url)}`
    ];

    for (const apiUrl of apis) {
      try {
        const response = await axios.get(apiUrl, {
          timeout: 30000,
          maxRedirects: 5
        });

        let videoUrl = null;
        
        if (response.data?.video) videoUrl = response.data.video;
        else if (response.data?.result?.download?.url) videoUrl = response.data.result.download.url;
        else if (response.data?.url) videoUrl = response.data.url;

        if (videoUrl && isSafeUrl(videoUrl)) {
          const videoResponse = await axios({
            method: "get",
            url: videoUrl,
            responseType: "arraybuffer",
            timeout: 120000,
            maxContentLength: CONFIG.MAX_VIDEO_SIZE
          });
          
          const buffer = Buffer.from(videoResponse.data);
          
          if (buffer.length > CONFIG.MAX_VIDEO_SIZE) {
            throw new Error("Video too large");
          }
          
          const tempFilePath = generateTempFileName(".mp4");
          fs.writeFileSync(tempFilePath, buffer);
          
          return { buffer, tempFilePath, mimetype: "video/mp4" };
        }
      } catch (error) {
        continue;
      }
    }
    
    return null;
  } catch (error) {
    console.error("Video download error:", error.message);
    return null;
  }
}

async function downloadAudioFromURL(url) {
  try {
    const apis = [
      `https://api.vevioz.com/api/button/${encodeURIComponent(url)}`,
      `https://api.davidcyriltech.my.id/download/${encodeURIComponent(url)}`
    ];

    for (const apiUrl of apis) {
      try {
        const response = await axios.get(apiUrl, {
          timeout: 30000,
          maxRedirects: 5
        });

        let audioUrl = null;
        
        if (response.data?.audio) audioUrl = response.data.audio;
        else if (response.data?.result?.download?.url) audioUrl = response.data.result.download.url;

        if (audioUrl && isSafeUrl(audioUrl)) {
          const audioResponse = await axios({
            method: "get",
            url: audioUrl,
            responseType: "arraybuffer",
            timeout: 120000,
            maxContentLength: CONFIG.MAX_VIDEO_SIZE
          });
          
          const buffer = Buffer.from(audioResponse.data);
          
          if (buffer.length > CONFIG.MAX_VIDEO_SIZE) {
            throw new Error("Audio too large");
          }
          
          const tempFilePath = generateTempFileName(".mp3");
          fs.writeFileSync(tempFilePath, buffer);
          
          return { buffer, tempFilePath, mimetype: "audio/mpeg" };
        }
      } catch (error) {
        continue;
      }
    }
    
    return null;
  } catch (error) {
    console.error("Audio download error:", error.message);
    return null;
  }
}

/* =========================================================
   SUPABASE FUNCTIONS
========================================================= */

async function logMessage(jid, direction, message) {
  try {
    await supabase
      .from("bot_logs")
      .insert({
        jid,
        direction,
        message: String(message).slice(0, 12000)
      });
  } catch (error) {
    console.error("Log error:", error.message);
  }
}

async function saveHistory(jid, role, content) {
  try {
    await supabase
      .from("bot_messages")
      .insert({
        jid,
        role,
        content: String(content).slice(0, 12000)
      });
  } catch (error) {
    console.error("History save error:", error.message);
  }
}

async function getHistory(jid) {
  try {
    const { data, error } = await supabase
      .from("bot_messages")
      .select("role,content,created_at")
      .eq("jid", jid)
      .order("created_at", { ascending: false })
      .limit(CONFIG.MAX_HISTORY);
    
    if (error) throw error;
    
    return (data || [])
      .reverse()
      .map(row => ({
        role: row.role,
        content: row.content
      }));
  } catch (error) {
    console.error("Failed to get history:", error);
    return [];
  }
}

async function clearHistory(jid) {
  const { error } = await supabase
    .from("bot_messages")
    .delete()
    .eq("jid", jid);
  
  if (error) throw error;
}

/* =========================================================
   AI WITH RETRY
========================================================= */

async function askAI(jid, text, imageContext = null) {
  try {
    const history = await getHistory(jid);
    
    let input;
    
    if (imageContext) {
      input = [
        ...history,
        {
          role: "user",
          content: `[Image Analysis]: ${imageContext}\n\n[User Question]: ${text || "Tell me about this image"}`
        }
      ];
    } else {
      input = [
        ...history,
        { role: "user", content: text }
      ];
    }
    
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        
        const response = await fetch(
          CONFIG.AI_PROXY_URL,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              model: CONFIG.AI_MODEL,
              instructions: `You are ${CONFIG.AI_NAME}, a helpful WhatsApp AI assistant.`,
              input,
              max_output_tokens: 2048,
              temperature: 0.7
            }),
            signal: controller.signal
          }
        );
        
        clearTimeout(timeout);
        
        const raw = await response.text();
        
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          throw new Error("Invalid JSON response");
        }
        
        if (!response.ok) {
          if ([429, 502, 503, 504].includes(response.status) && attempt < 3) {
            await new Promise(resolve => setTimeout(resolve, attempt * 1000));
            continue;
          }
          throw new Error(data?.error?.message || `HTTP ${response.status}`);
        }
        
        let answer = data?.output_text || data?.choices?.[0]?.message?.content || "";
        
        if (!answer && Array.isArray(data?.output)) {
          for (const item of data.output) {
            if (item?.type === "message" && Array.isArray(item.content)) {
              for (const part of item.content) {
                if (part?.type === "output_text" && typeof part.text === "string") {
                  answer += part.text;
                }
              }
            }
          }
        }
        
        answer = String(answer || "").trim();
        
        if (!answer) throw new Error("Empty response");
        
        await saveHistory(jid, "user", text || "Image sent");
        await saveHistory(jid, "assistant", answer);
        
        return answer;
      } catch (error) {
        if (attempt === 3) throw error;
        await new Promise(resolve => setTimeout(resolve, attempt * 1000));
      }
    }
  } catch (error) {
    console.error("AI request failed:", error);
    throw error;
  }
}

/* =========================================================
   DASHBOARD HTML
========================================================= */

function dashboardHTML() {
  return `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp AI Bot</title>
<style>
*{box-sizing:border-box;}
body{font-family:Arial,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);margin:0;min-height:100vh;}
main{max-width:600px;margin:auto;padding:20px;}
.header{text-align:center;color:white;padding:30px 20px;}
.header h1{margin:0;font-size:2em;}
.header p{margin:10px 0 0;opacity:0.9;}
.card{background:white;padding:20px;margin:15px 0;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,0.2);}
button{width:100%;padding:15px;margin:8px 0;font-size:16px;border-radius:10px;border:0;cursor:pointer;font-weight:bold;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white;}
button:hover{opacity:0.9;}
.badge{display:inline-block;padding:8px 15px;border-radius:20px;font-size:14px;font-weight:bold;}
.badge.online{background:#c6f6d5;color:#276749;}
.badge.offline{background:#fed7d7;color:#9b2c2c;}
.info{background:#f7fafc;padding:15px;border-radius:10px;margin:10px 0;border-left:4px solid #667eea;}
</style>
</head>
<body>
<main>
<div class="header">
<h1>🤖 WhatsApp AI Bot</h1>
<p>${CONFIG.AI_NAME}</p>
</div>

<div class="card">
<h2>📊 Bot Status</h2>
<p>Status: <span id="botStatus" class="badge">Loading...</span></p>
<button onclick="refresh()">🔄 Refresh Status</button>
</div>

<div class="card">
<h2>📱 WhatsApp Connection</h2>
<div class="info">
<p>To connect WhatsApp:</p>
<ol style="margin:10px 0;padding-left:20px;">
<li>Click the button below</li>
<li>Open WhatsApp on your phone</li>
<li>Go to Settings → Linked Devices</li>
<li>Scan the QR code</li>
</ol>
</div>
<button onclick="location.href='/pair'" style="background:linear-gradient(135deg,#48bb78 0%,#38a169 100%);">📱 Connect WhatsApp</button>
</div>

<div class="card">
<h2>💡 Bot Features</h2>
<div class="info">
<p>✅ <strong>AI Chat</strong> - Talk to ${CONFIG.AI_NAME}</p>
<p>✅ <strong>Image Analysis</strong> - Send any image</p>
<p>✅ <strong>Document Reading</strong> - Send PDF/TXT/DOCX</p>
<p>✅ <strong>Video Download</strong> - Send YouTube/Instagram link</p>
<p>✅ <strong>Audio Download</strong> - Reply "audio" to link</p>
</div>
</div>
</main>

<script>
async function refresh() {
  try {
    const health = await fetch("/health").then(r => r.json());
    const botStatus = document.getElementById("botStatus");
    
    if (health.connected) {
      botStatus.textContent = "🟢 Connected";
      botStatus.className = "badge online";
    } else {
      botStatus.textContent = "🟡 Not Connected";
      botStatus.className = "badge offline";
    }
  } catch (error) {
    document.getElementById("botStatus").textContent = "❌ Error";
    document.getElementById("botStatus").className = "badge offline";
  }
}

// Auto refresh every 5 seconds
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;
}

/* =========================================================
   PAIR PAGE
========================================================= */

function pairHTML() {
  if (botConnected) {
    return `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp Connected</title>
<style>
body{font-family:Arial,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;}
.card{background:white;padding:40px;border-radius:20px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,0.2);}
h2{color:#276749;margin:0 0 20px;}
p{color:#718096;}
a{color:#667eea;text-decoration:none;font-weight:bold;}
</style>
</head>
<body>
<div class="card">
<h2>✅ WhatsApp Connected</h2>
<p>Your bot is connected and ready to use!</p>
<p><a href="/dashboard">← Back to Dashboard</a></p>
</div>
</body>
</html>`;
  }
  
  if (!latestQR) {
    return `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Waiting for QR</title>
<style>
body{font-family:Arial,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;}
.card{background:white;padding:40px;border-radius:20px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,0.2);}
h2{color:#667eea;margin:0 0 20px;}
</style>
</head>
<body>
<div class="card">
<h2>📱 Waiting for QR Code...</h2>
<p>Refreshing...</p>
<script>setTimeout(()=>location.reload(), 3000);</script>
</div>
</body>
</html>`;
  }
  
  return `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="4">
<title>WhatsApp Pairing</title>
<style>
body{font-family:Arial,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;}
.card{background:white;padding:40px;border-radius:20px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,0.2);max-width:90%;}
h2{color:#667eea;margin:0 0 20px;}
img{max-width:100%;width:400px;border-radius:10px;}
p{color:#718096;margin:20px 0;}
ol{text-align:left;display:inline-block;color:#718096;}
a{color:#667eea;text-decoration:none;font-weight:bold;}
</style>
</head>
<body>
<div class="card">
<h2>📱 Scan QR Code</h2>
<img src="/qr.png?t=${Date.now()}" alt="WhatsApp QR Code">
<p><strong>Steps:</strong></p>
<ol>
<li>Open WhatsApp on your phone</li>
<li>Go to Settings → Linked Devices</li>
<li>Tap "Link a Device"</li>
<li>Scan this QR code</li>
</ol>
<p><a href="/dashboard">← Back to Dashboard</a></p>
</div>
</body>
</html>`;
}

/* =========================================================
   HTTP SERVER
========================================================= */

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    
    // HEALTH
    if (url.pathname === "/health") {
      return sendJSON(res, 200, {
        ok: true,
        connected: botConnected,
        uptime: process.uptime()
      });
    }
    
    // HOME
    if (url.pathname === "/") {
      return sendJSON(res, 200, {
        ok: true,
        service: "whatsapp-ai-bot",
        dashboard: "/dashboard",
        pair: "/pair",
        health: "/health"
      });
    }
    
    // DASHBOARD
    if (url.pathname === "/dashboard") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      });
      return res.end(dashboardHTML());
    }
    
    // PAIR PAGE
    if (url.pathname === "/pair") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      });
      return res.end(pairHTML());
    }
    
    // QR CODE
    if (url.pathname === "/qr.png") {
      if (!latestQR) {
        res.writeHead(404);
        return res.end("QR not ready");
      }
      
      try {
        const png = await QRCode.toBuffer(latestQR, { width: 500, margin: 2 });
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Cache-Control": "no-store"
        });
        return res.end(png);
      } catch (error) {
        console.error("QR generation error:", error);
        res.writeHead(500);
        return res.end("Failed to generate QR");
      }
    }
    
    // 404
    res.writeHead(404);
    res.end("Not found");
    
  } catch (error) {
    console.error("HTTP error:", error);
    
    if (!res.headersSent) {
      sendJSON(res, 500, { error: "Internal server error" });
    }
  }
});

/* =========================================================
   START SERVER
========================================================= */

server.listen(CONFIG.PORT, "0.0.0.0", () => {
  console.log(`🌐 HTTP server listening on ${CONFIG.PORT}`);
});

/* =========================================================
   WHATSAPP
========================================================= */

async function startBot() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(CONFIG.SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();
    
    sock = makeWASocket({
      version,
      auth: state,
      logger,
      browser: ["Ayush AI", "Chrome", "1.0.0"],
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000
    });
    
    sock.ev.on("creds.update", saveCreds);
    
    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        latestQR = qr;
        botConnected = false;
        console.log("📱 New WhatsApp QR generated");
      }
      
      if (connection === "open") {
        botConnected = true;
        latestQR = null;
        reconnecting = false;
        reconnectAttempts = 0;
        console.log("✅ WhatsApp connected");
      }
      
      if (connection === "close") {
        botConnected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.error("WhatsApp connection closed:", statusCode);
        
        if (statusCode === DisconnectReason.loggedOut) {
          console.log("Logged out. Please re-scan QR code.");
          return;
        }
        
        if (!reconnecting) {
          reconnecting = true;
          reconnectAttempts++;
          
          const delays = [3000, 5000, 10000, 20000, 30000, 60000];
          const delay = delays[Math.min(reconnectAttempts - 1, delays.length - 1)];
          
          console.log(`Reconnecting in ${delay / 1000} seconds...`);
          
          setTimeout(() => {
            reconnecting = false;
            startBot().catch(console.error);
          }, delay);
        }
      }
    });
    
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      
      for (const msg of messages) {
        if (!msg || msg.key.fromMe) continue;
        
        const messageId = msg.key.id;
        if (processedMessages.has(messageId)) continue;
        processedMessages.set(messageId, Date.now());
        
        const jid = msg.key.remoteJid;
        if (!jid || jid.endsWith("@g.us")) continue;
        
        const previous = userQueues.get(jid) || Promise.resolve();
        
        const current = previous
          .catch(() => {})
          .then(() => processMessage(msg, jid));
        
        userQueues.set(jid, current);
        
        current.finally(() => {
          if (userQueues.get(jid) === current) {
            userQueues.delete(jid);
          }
        });
      }
    });
    
    setInterval(cleanOldProcessedMessages, 60000);
    setInterval(cleanOldTempFiles, 300000);
    
  } catch (error) {
    console.error("Failed to start bot:", error);
    throw error;
  }
}

async function processMessage(msg, jid) {
  let imageData = null;
  let documentData = null;
  let videoData = null;
  let audioData = null;
  
  try {
    const hasImage = !!msg.message?.imageMessage;
    const hasDocument = !!msg.message?.documentMessage;
    
    const text = (
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      msg.message?.documentMessage?.caption ||
      ""
    ).trim();
    
    if (!text && !hasImage && !hasDocument) return;
    
    console.log(`📩 ${jid}: ${text || "[Media]"}`);
    await logMessage(jid, "incoming", text || "[Media]");
    
    if (/^(help|\/help)$/i.test(text)) {
      const reply = `🤖 ${CONFIG.AI_NAME}\n\nCommands:\nHELP - Show this menu\nCLEAR - Clear AI memory\n\n📸 Send image for analysis\n📄 Send PDF/TXT for reading\n📹 Send YouTube/Instagram link for download`;
      await sock.sendMessage(jid, { text: reply });
      await logMessage(jid, "outgoing", reply);
      return;
    }
    
    if (/^(clear|\/clear)$/i.test(text)) {
      await clearHistory(jid);
      const reply = "🧹 Your AI memory has been cleared.";
      await sock.sendMessage(jid, { text: reply });
      await logMessage(jid, "outgoing", reply);
      return;
    }
    
    if (pendingLinks.has(jid)) {
      const pending = pendingLinks.get(jid);
      
      if (/^(1|video|v)$/i.test(text)) {
        pendingLinks.delete(jid);
        
        if (!checkRateLimit(mediaRateLimit, jid, CONFIG.MEDIA_RATE_LIMIT)) {
          await sock.sendMessage(jid, { text: "⚠️ Media download limit reached. Wait a minute." });
          return;
        }
        
        await sock.sendMessage(jid, { text: "📹 Downloading video..." });
        videoData = await downloadVideoFromURL(pending.url);
        
        if (videoData) {
          await sock.sendMessage(jid, {
            video: videoData.buffer,
            mimetype: "video/mp4",
            fileName: "video.mp4"
          });
          await logMessage(jid, "outgoing", "Video downloaded");
        } else {
          await sock.sendMessage(jid, { text: "⚠️ Failed to download video." });
        }
        return;
      }
      
      if (/^(2|audio|mp3|a)$/i.test(text)) {
        pendingLinks.delete(jid);
        
        if (!checkRateLimit(mediaRateLimit, jid, CONFIG.MEDIA_RATE_LIMIT)) {
          await sock.sendMessage(jid, { text: "⚠️ Media download limit reached. Wait a minute." });
          return;
        }
        
        await sock.sendMessage(jid, { text: "🎵 Downloading audio..." });
        audioData = await downloadAudioFromURL(pending.url);
        
        if (audioData) {
          await sock.sendMessage(jid, {
            audio: audioData.buffer,
            mimetype: "audio/mpeg",
            fileName: "audio.mp3"
          });
          await logMessage(jid, "outgoing", "Audio downloaded");
        } else {
          await sock.sendMessage(jid, { text: "⚠️ Failed to download audio." });
        }
        return;
      }
      
      if (/^(cancel|no)$/i.test(text)) {
        pendingLinks.delete(jid);
        await sock.sendMessage(jid, { text: "❌ Cancelled." });
        return;
      }
    }
    
    if (hasImage) {
      if (!checkRateLimit(mediaRateLimit, jid, CONFIG.MEDIA_RATE_LIMIT)) {
        await sock.sendMessage(jid, { text: "⚠️ Media limit reached. Wait a minute." });
        return;
      }
      
      await sock.sendMessage(jid, { text: "🖼️ Analyzing image..." });
      
      try {
        imageData = await downloadAndProcessImage(msg);
        
        if (imageData) {
          const analysis = await analyzeImageWithSightengine(imageData.buffer, imageData.mimetype);
          
          if (analysis) {
            if (!checkRateLimit(aiRateLimit, jid, CONFIG.AI_RATE_LIMIT)) {
              await sock.sendMessage(jid, { text: "⚠️ AI limit reached. Wait a minute." });
              return;
            }
            
            const reply = await askAI(jid, text || "Describe this image", analysis);
            await sock.sendMessage(jid, { text: reply });
            await logMessage(jid, "outgoing", reply);
          } else {
            await sock.sendMessage(jid, { text: "⚠️ Could not analyze image." });
          }
        }
      } finally {
        if (imageData?.tempFilePath) {
          cleanupTempFile(imageData.tempFilePath);
        }
      }
      return;
    }
    
    if (hasDocument) {
      if (!checkRateLimit(mediaRateLimit, jid, CONFIG.MEDIA_RATE_LIMIT)) {
        await sock.sendMessage(jid, { text: "⚠️ Media limit reached. Wait a minute." });
        return;
      }
      
      await sock.sendMessage(jid, { text: "📄 Reading document..." });
      
      try {
        documentData = await downloadAndProcessDocument(msg);
        
        if (documentData) {
          const extractedText = await extractTextFromDocument(documentData);
          
          if (extractedText) {
            if (!checkRateLimit(aiRateLimit, jid, CONFIG.AI_RATE_LIMIT)) {
              await sock.sendMessage(jid, { text: "⚠️ AI limit reached. Wait a minute." });
              return;
            }
            
            const reply = await askAI(jid, text || `Summarize this document:\n${extractedText.slice(0, 2000)}`);
            await sock.sendMessage(jid, { text: reply });
            await logMessage(jid, "outgoing", reply);
          } else {
            await sock.sendMessage(jid, { text: "⚠️ Could not extract text from document." });
          }
        }
      } finally {
        if (documentData?.tempFilePath) {
          cleanupTempFile(documentData.tempFilePath);
        }
      }
      return;
    }
    
    const url = extractURL(text);
    if (url && isSupportedPlatform(url) && isSafeUrl(url)) {
      pendingLinks.set(jid, { url, timestamp: Date.now() });
      
      const reply = `🔗 **Link Detected!**\n\n1️⃣ Video (Max Quality)\n2️⃣ Audio (MP3)\n\nReply "1" for video or "2" for audio`;
      await sock.sendMessage(jid, { text: reply });
      await logMessage(jid, "outgoing", "Link detected");
      return;
    }
    
    if (!checkRateLimit(aiRateLimit, jid, CONFIG.AI_RATE_LIMIT)) {
      await sock.sendMessage(jid, { text: "⚠️ AI limit reached. Wait a minute." });
      return;
    }
    
    await sock.sendMessage(jid, { text: "⏳ Thinking..." });
    const reply = await askAI(jid, text);
    await sock.sendMessage(jid, { text: reply });
    await logMessage(jid, "outgoing", reply);
    
  } catch (error) {
    console.error("Process message error:", error);
  } finally {
    if (imageData?.tempFilePath) cleanupTempFile(imageData.tempFilePath);
    if (documentData?.tempFilePath) cleanupTempFile(documentData.tempFilePath);
    if (videoData?.tempFilePath) cleanupTempFile(videoData.tempFilePath);
    if (audioData?.tempFilePath) cleanupTempFile(audioData.tempFilePath);
  }
}

/* =========================================================
   START
========================================================= */

startBot().catch(error => {
  console.error("Fatal WhatsApp error:", error);
  console.log("HTTP server will continue running");
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});
