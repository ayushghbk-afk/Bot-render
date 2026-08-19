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
  ADMIN_KEY: process.env.ADMIN_KEY || "",
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
  WHITELIST_ONLY: process.env.WHITELIST_ONLY !== "false",
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

if (!CONFIG.ADMIN_KEY) {
  console.error("❌ ADMIN_KEY is missing");
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
const processedMessages = new Map(); // messageId -> timestamp
const userQueues = new Map(); // jid -> Promise
const pendingLinks = new Map(); // jid -> { url, timestamp }

// Rate limiting
const aiRateLimit = new Map(); // jid -> { count, resetTime }
const mediaRateLimit = new Map(); // jid -> { count, resetTime }

/* =========================================================
   HELPERS
========================================================= */

function normalizeJid(value) {
  let v = String(value || "").trim();
  
  if (!v) return "";
  
  if (v.endsWith("@s.whatsapp.net") || v.endsWith("@g.us")) {
    return v;
  }
  
  v = v.replace(/[^\d]/g, "");
  
  if (!v) return "";
  
  return `${v}@s.whatsapp.net`;
}

function sendJSON(res, status, data) {
  if (res.headersSent) return;
  
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  
  res.end(JSON.stringify(data));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1e6) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    
    req.on("end", () => {
      resolve(body);
    });
    
    req.on("error", reject);
  });
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
   TOOL SYSTEM
========================================================= */

const tools = {
  calculator: {
    name: "calculator",
    description: "Perform mathematical calculations",
    parameters: {
      expression: "string"
    },
    execute: async (expression) => {
      try {
        const result = math.evaluate(expression);
        return String(result);
      } catch (error) {
        return "Invalid expression";
      }
    }
  },
  
  getTime: {
    name: "getTime",
    description: "Get current time",
    parameters: {},
    execute: async () => {
      return new Date().toISOString();
    }
  }
};

async function routeToAgent(jid, text, history) {
  try {
    const lowerText = text.toLowerCase();
    
    // Calculator
    if (/^[\d\s\+\-\*\/\(\)\.\%\^]+$/.test(text) && /[\d]/.test(text)) {
      const result = await tools.calculator.execute(text);
      const response = `🧮 Result: ${result}`;
      
      await saveHistory(jid, "user", text);
      await saveHistory(jid, "assistant", response);
      
      return response;
    }
    
    // Time query
    if (/what.*time|current time|time now/i.test(text)) {
      const time = await tools.getTime.execute();
      const response = `🕐 Current time: ${time}`;
      
      await saveHistory(jid, "user", text);
      await saveHistory(jid, "assistant", response);
      
      return response;
    }
    
    return null;
  } catch (error) {
    console.error("Agent routing error:", error);
    return null;
  }
}

/* =========================================================
   DOCUMENT PROCESSING
========================================================= */

async function extractTextFromDocument(documentData) {
  try {
    const { buffer, mimetype, filename } = documentData;
    
    // PDF
    if (mimetype.includes("pdf") || filename.endsWith(".pdf")) {
      const data = await pdfParse(buffer);
      return data.text.slice(0, 5000);
    }
    
    // DOCX
    if (mimetype.includes("docx") || filename.endsWith(".docx")) {
      const result = await mammoth.extractRawText({ buffer });
      return result.value.slice(0, 5000);
    }
    
    // TXT
    if (mimetype.includes("text") || filename.endsWith(".txt")) {
      return buffer.toString("utf8").slice(0, 5000);
    }
    
    // JSON
    if (mimetype.includes("json") || filename.endsWith(".json")) {
      try {
        const parsed = JSON.parse(buffer.toString("utf8"));
        return JSON.stringify(parsed, null, 2).slice(0, 5000);
      } catch {
        return buffer.toString("utf8").slice(0, 5000);
      }
    }
    
    // CSV
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

async function getWhitelist() {
  try {
    const { data, error } = await supabase
      .from("bot_users")
      .select("jid,allowed")
      .eq("allowed", true);
    
    if (error) throw error;
    
    return (data || []).map(row => row.jid);
  } catch (error) {
    console.error("Failed to get whitelist:", error);
    return [];
  }
}

async function isAllowed(jid) {
  if (!CONFIG.WHITELIST_ONLY) return true;
  
  try {
    const { data, error } = await supabase
      .from("bot_users")
      .select("allowed")
      .eq("jid", jid)
      .maybeSingle();
    
    if (error) return false;
    
    return Boolean(data && data.allowed === true);
  } catch (error) {
    console.error("Failed to check whitelist:", error);
    return false;
  }
}

async function addWhitelist(jid) {
  const { error } = await supabase
    .from("bot_users")
    .upsert({ jid, allowed: true }, { onConflict: "jid" });
  
  if (error) throw error;
}

async function removeWhitelist(jid) {
  const { error } = await supabase
    .from("bot_users")
    .update({ allowed: false })
    .eq("jid", jid);
  
  if (error) throw error;
}

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

async function getStats() {
  try {
    const { count: userCount } = await supabase
      .from("bot_users")
      .select("*", { count: "exact", head: true });
    
    const { count: messageCount } = await supabase
      .from("bot_messages")
      .select("*", { count: "exact", head: true });
    
    return {
      users: userCount || 0,
      messages: messageCount || 0,
      uptime: process.uptime(),
      connected: botConnected,
      memory: process.memoryUsage().heapUsed / 1024 / 1024
    };
  } catch (error) {
    return {
      users: 0,
      messages: 0,
      uptime: process.uptime(),
      connected: botConnected,
      memory: 0
    };
  }
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
   ADMIN AUTH
========================================================= */

function adminAuthorized(req) {
  const key = req.headers["x-admin-key"];
  return Boolean(CONFIG.ADMIN_KEY && key && key === CONFIG.ADMIN_KEY);
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
body{font-family:Arial,sans-serif;background:#f3f4f6;margin:0;color:#111;}
main{max-width:700px;margin:auto;padding:20px;}
.card{background:white;padding:18px;margin:12px 0;border-radius:16px;box-shadow:0 2px 10px #0001;}
input,button{width:100%;box-sizing:border-box;padding:13px;margin:6px 0;font-size:16px;border-radius:10px;border:1px solid #ccc;}
button{background:#111;color:white;border:0;cursor:pointer;}
button.danger{background:#c62828;}
.hidden{display:none;}
.user{padding:10px;border-bottom:1px solid #ddd;word-break:break-all;display:flex;justify-content:space-between;align-items:center;}
.status{padding:10px;border-radius:8px;background:#eef2ff;margin-top:10px;}
</style>
</head>
<body>
<main>
<h2>🤖 WhatsApp AI Bot</h2>
<div id="login" class="card">
<h3>🔐 Admin Login</h3>
<input id="adminKey" type="password" placeholder="Enter ADMIN_KEY">
<button onclick="login()">Login</button>
<p id="loginStatus"></p>
</div>
<div id="panel" class="hidden">
<div class="card">
<h3>📊 Status</h3>
<p id="botStatus">Loading...</p>
<button onclick="refresh()">🔄 Refresh</button>
<button onclick="location.href='/pair'">📱 WhatsApp Pairing</button>
</div>
<div class="card">
<h3>👥 Whitelist</h3>
<input id="number" placeholder="+91 9876543210">
<button onclick="addUser()">➕ Add user</button>
<div id="users">Loading...</div>
<p id="status" class="status"></p>
</div>
</div>
</main>
<script>
let ADMIN_KEY = localStorage.getItem("adminKey") || "";

function login() {
  const value = document.getElementById("adminKey").value.trim();
  if (!value) return;
  ADMIN_KEY = value;
  localStorage.setItem("adminKey", value);
  testAuth();
}

async function api(url, options = {}) {
  options.headers = {...(options.headers || {}), "X-Admin-Key": ADMIN_KEY, "Content-Type": "application/json"};
  const response = await fetch(url, options);
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("Invalid response"); }
  if (response.status === 401) {
    localStorage.removeItem("adminKey");
    ADMIN_KEY = "";
    document.getElementById("login").classList.remove("hidden");
    document.getElementById("panel").classList.add("hidden");
    throw new Error("Wrong ADMIN_KEY.");
  }
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

async function testAuth() {
  try {
    await api("/api/whitelist");
    document.getElementById("login").classList.add("hidden");
    document.getElementById("panel").classList.remove("hidden");
    refresh();
  } catch (error) {
    document.getElementById("loginStatus").textContent = error.message;
  }
}

async function refresh() {
  try {
    const data = await api("/api/whitelist");
    document.getElementById("users").innerHTML = data.users.length
      ? data.users.map(user =>
          '<div class="user"><span>' + user + '</span> <button class="danger" onclick="removeUser(\'' + user + '\')">Remove</button></div>'
        ).join("")
      : "<p>No users.</p>";
    
    const health = await fetch("/health").then(r => r.json());
    document.getElementById("botStatus").textContent = health.connected ? "🟢 WhatsApp connected" : "🟡 WhatsApp not connected";
  } catch (error) {
    document.getElementById("status").textContent = error.message;
  }
}

async function addUser() {
  const number = document.getElementById("number").value.trim();
  if (!number) return;
  
  try {
    const data = await api("/api/whitelist/add", {
      method: "POST",
      body: JSON.stringify({ number })
    });
    document.getElementById("number").value = "";
    document.getElementById("status").textContent = data.message;
    refresh();
  } catch (error) {
    document.getElementById("status").textContent = error.message;
  }
}

async function removeUser(number) {
  if (!confirm("Remove " + number + "?")) return;
  
  try {
    const data = await api("/api/whitelist/remove", {
      method: "POST",
      body: JSON.stringify({ number })
    });
    document.getElementById("status").textContent = data.message;
    refresh();
  } catch (error) {
    document.getElementById("status").textContent = error.message;
  }
}

if (ADMIN_KEY) testAuth();
</script>
</body>
</html>`;
}

/* =========================================================
   PAIR PAGE
========================================================= */

function pairHTML() {
  if (botConnected) {
    return `<!doctype html><meta name="viewport" content="width=device-width"><div style="font-family:Arial;text-align:center;padding:30px"><h2>✅ WhatsApp Connected</h2><p>No QR scan required.</p></div>`;
  }
  
  if (!latestQR) {
    return `<!doctype html><meta name="viewport" content="width=device-width"><div style="font-family:Arial;text-align:center;padding:30px"><h2>📱 Waiting for QR...</h2><p>Refreshing...</p><script>setTimeout(()=>location.reload(), 3000);</script></div>`;
  }
  
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="4"><title>WhatsApp Pairing</title></head><body style="font-family:Arial;text-align:center;padding:20px"><h2>📱 Scan QR</h2><img style="max-width:90%;width:400px" src="/qr.png?t=${Date.now()}"><p>WhatsApp → Linked devices → Link a device</p></body></html>`;
}

/* =========================================================
   HTTP SERVER
========================================================= */

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    
    // PUBLIC HEALTH
    if (url.pathname === "/health") {
      return sendJSON(res, 200, {
        ok: true,
        connected: botConnected
      });
    }
    
    // HOME
    if (url.pathname === "/") {
      return sendJSON(res, 200, {
        ok: true,
        service: "whatsapp-ai-bot",
        dashboard: "/dashboard",
        pair: "/pair"
      });
    }
    
    // PROTECTED ROUTES
    if (url.pathname === "/dashboard" || url.pathname === "/pair" || url.pathname === "/qr.png" || url.pathname.startsWith("/api/") || url.pathname === "/status") {
      if (!adminAuthorized(req)) {
        return sendJSON(res, 401, { error: "Unauthorized" });
      }
      
      if (url.pathname === "/dashboard") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(dashboardHTML());
      }
      
      if (url.pathname === "/pair") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(pairHTML());
      }
      
      if (url.pathname === "/qr.png") {
        if (!latestQR) {
          res.writeHead(404);
          return res.end("QR not ready");
        }
        
        const png = await QRCode.toBuffer(latestQR, { width: 500, margin: 2 });
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
        return res.end(png);
      }
      
      if (url.pathname === "/status") {
        const stats = await getStats();
        return sendJSON(res, 200, stats);
      }
      
      // API ROUTES
      if (url.pathname === "/api/whitelist" && req.method === "GET") {
        const users = await getWhitelist();
        return sendJSON(res, 200, { users });
      }
      
      if (url.pathname === "/api/whitelist/add" && req.method === "POST") {
        const body = JSON.parse(await readRequestBody(req) || "{}");
        const jid = normalizeJid(body.number);
        if (!jid) return sendJSON(res, 400, { error: "Invalid number" });
        await addWhitelist(jid);
        return sendJSON(res, 200, { ok: true, message: `Added ${jid}` });
      }
      
      if (url.pathname === "/api/whitelist/remove" && req.method === "POST") {
        const body = JSON.parse(await readRequestBody(req) || "{}");
        const jid = normalizeJid(body.number);
        if (!jid) return sendJSON(res, 400, { error: "Invalid number" });
        await removeWhitelist(jid);
        return sendJSON(res, 200, { ok: true, message: `Removed ${jid}` });
      }
      
      if (url.pathname === "/api/history/clear" && req.method === "POST") {
        const body = JSON.parse(await readRequestBody(req) || "{}");
        const jid = normalizeJid(body.number);
        if (!jid) return sendJSON(res, 400, { error: "Invalid number" });
        await clearHistory(jid);
        return sendJSON(res, 200, { ok: true, message: "History cleared" });
      }
    }
    
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
        
        // Queue processing per user with captured promise
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
    
    // Periodic cleanup
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
    
    // Commands that always work
    if (/^(start|\/start)$/i.test(text)) {
      await addWhitelist(jid);
      const reply = "✅ You are now allowed to use the bot.";
      await sock.sendMessage(jid, { text: reply });
      await logMessage(jid, "outgoing", reply);
      return;
    }
    
    if (/^(stop|\/stop)$/i.test(text)) {
      await removeWhitelist(jid);
      const reply = "🛑 You have been removed from whitelist.";
      await sock.sendMessage(jid, { text: reply });
      await logMessage(jid, "outgoing", reply);
      return;
    }
    
    if (/^(help|\/help)$/i.test(text)) {
      const reply = `🤖 ${CONFIG.AI_NAME}\n\nCommands:\nSTART - Enable bot\nSTOP - Disable bot\nHELP - Show this menu\nCLEAR - Clear AI memory\n\n📸 Send image for analysis\n📄 Send PDF/TXT for reading\n📹 Send YouTube/Instagram link for download`;
      await sock.sendMessage(jid, { text: reply });
      await logMessage(jid, "outgoing", reply);
      return;
    }
    
    // Check whitelist
    if (!(await isAllowed(jid))) {
      console.log(`🚫 Blocked: ${jid}`);
      return;
    }
    
    if (/^(clear|\/clear)$/i.test(text)) {
      await clearHistory(jid);
      const reply = "🧹 Your AI memory has been cleared.";
      await sock.sendMessage(jid, { text: reply });
      await logMessage(jid, "outgoing", reply);
      return;
    }
    
    // Handle pending links
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
    
    // Image processing
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
    
    // Document processing
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
    
    // URL handling
    const url = extractURL(text);
    if (url && isSupportedPlatform(url) && isSafeUrl(url)) {
      pendingLinks.set(jid, { url, timestamp: Date.now() });
      
      const reply = `🔗 **Link Detected!**\n\n1️⃣ Video (Max Quality)\n2️⃣ Audio (MP3)\n\nReply "1" for video or "2" for audio`;
      await sock.sendMessage(jid, { text: reply });
      await logMessage(jid, "outgoing", "Link detected");
      return;
    }
    
    // Agent routing
    const agentResponse = await routeToAgent(jid, text, await getHistory(jid));
    if (agentResponse) {
      await sock.sendMessage(jid, { text: agentResponse });
      await logMessage(jid, "outgoing", agentResponse);
      return;
    }
    
    // AI response
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
    // Cleanup any remaining temp files
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
