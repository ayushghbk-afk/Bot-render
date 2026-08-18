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
  WHITELIST_ONLY: process.env.WHITELIST_ONLY !== "false",
  MAX_HISTORY: Number(process.env.MAX_HISTORY || 10),
  TEMP_DIR: process.env.TEMP_DIR || "./temp",
  MAX_IMAGE_SIZE: Number(process.env.MAX_IMAGE_SIZE || 10 * 1024 * 1024), // 10MB default
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

/* =========================================================
   HELPERS
========================================================= */

function normalizeJid(value) {
  let v = String(value || "").trim();
  
  if (!v) return "";
  
  // If already a JID, return as-is
  if (v.endsWith("@s.whatsapp.net") || v.endsWith("@g.us")) {
    return v;
  }
  
  // Remove all non-digit characters
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
      // Limit body size to prevent abuse
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

/* =========================================================
   IMAGE PROCESSING
========================================================= */

async function downloadAndProcessImage(message) {
  try {
    // Check if message contains an image
    const imageMessage = 
      message.message?.imageMessage ||
      message.message?.documentMessage ||
      message.message?.videoMessage;

    if (!imageMessage) {
      return null;
    }

    // Check file size
    const fileSize = imageMessage.fileLength || 0;
    if (fileSize > CONFIG.MAX_IMAGE_SIZE) {
      throw new Error(`Image too large. Maximum size is ${CONFIG.MAX_IMAGE_SIZE / (1024 * 1024)}MB`);
    }

    // Determine file extension based on mimetype
    let extension = ".jpg";
    const mimetype = imageMessage.mimetype || "";
    
    if (mimetype.includes("png")) {
      extension = ".png";
    } else if (mimetype.includes("webp")) {
      extension = ".webp";
    } else if (mimetype.includes("gif")) {
      extension = ".gif";
    } else if (mimetype.includes("pdf")) {
      extension = ".pdf";
    }

    // Download the media
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

    // Save to temp file
    const tempFilePath = generateTempFileName(extension);
    fs.writeFileSync(tempFilePath, buffer);

    return {
      buffer,
      tempFilePath,
      mimetype,
      fileSize
    };
  } catch (error) {
    console.error("Image download error:", error);
    throw error;
  }
}

async function summarizeImage(imageBuffer, mimetype) {
  try {
    // Convert image to base64
    const base64Image = imageBuffer.toString("base64");
    
    // Prepare the AI request for image summarization
    const response = await fetch(CONFIG.AI_PROXY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: CONFIG.AI_MODEL,
        instructions: `You are ${CONFIG.AI_NAME}, a helpful WhatsApp AI assistant. Analyze the provided image and create a detailed summary of what you see. Include key elements, text if any, objects, people, actions, and overall context. Be specific and descriptive.`,
        input: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Please analyze and summarize this image:"
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:${mimetype};base64,${base64Image}`
                }
              }
            ]
          }
        ],
        max_output_tokens: 2048,
        temperature: 0.7
      })
    });

    const raw = await response.text();
    
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`AI returned invalid JSON: ${raw.slice(0, 500)}`);
    }

    if (!response.ok) {
      throw new Error(
        data?.error?.message ||
        data?.error ||
        `AI HTTP ${response.status}`
      );
    }

    // Extract the summary from the response
    let summary = data?.output_text || "";
    
    // Fallback for normal chat-completion responses
    if (!summary) {
      summary = data?.choices?.[0]?.message?.content || "";
    }
    
    // Fallback for Responses-style output
    if (!summary && Array.isArray(data?.output)) {
      for (const item of data.output) {
        if (item?.type === "message" && Array.isArray(item.content)) {
          for (const part of item.content) {
            if (part?.type === "output_text" && typeof part.text === "string") {
              summary += part.text;
            }
          }
        }
      }
    }

    summary = String(summary || "").trim();
    
    if (!summary) {
      throw new Error("AI returned an empty response for image summary");
    }

    return summary;
  } catch (error) {
    console.error("Image summarization error:", error);
    throw error;
  }
}

/* =========================================================
   ADMIN AUTH
========================================================= */

function adminAuthorized(req) {
  const key = req.headers["x-admin-key"];
  
  return Boolean(
    CONFIG.ADMIN_KEY &&
    key &&
    key === CONFIG.ADMIN_KEY
  );
}

/* =========================================================
   SUPABASE WHITELIST
========================================================= */

async function getWhitelist() {
  try {
    const { data, error } = await supabase
      .from("bot_users")
      .select("jid,allowed")
      .eq("allowed", true);
    
    if (error) {
      console.error("Whitelist read error:", error);
      throw error;
    }
    
    return (data || []).map(row => row.jid);
  } catch (error) {
    console.error("Failed to get whitelist:", error);
    return [];
  }
}

async function isAllowed(jid) {
  if (!CONFIG.WHITELIST_ONLY) {
    return true;
  }
  
  try {
    const { data, error } = await supabase
      .from("bot_users")
      .select("allowed")
      .eq("jid", jid)
      .maybeSingle();
    
    if (error) {
      console.error("Whitelist check error:", error);
      return false;
    }
    
    return Boolean(data && data.allowed === true);
  } catch (error) {
    console.error("Failed to check whitelist:", error);
    return false;
  }
}

async function addWhitelist(jid) {
  const { error } = await supabase
    .from("bot_users")
    .upsert(
      { jid, allowed: true },
      { onConflict: "jid" }
    );
  
  if (error) {
    console.error("Failed to add whitelist:", error);
    throw error;
  }
}

async function removeWhitelist(jid) {
  const { error } = await supabase
    .from("bot_users")
    .update({ allowed: false })
    .eq("jid", jid);
  
  if (error) {
    console.error("Failed to remove whitelist:", error);
    throw error;
  }
}

/* =========================================================
   LOGGING
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

/* =========================================================
   MESSAGE HISTORY
========================================================= */

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
    
    if (error) {
      console.error("History read error:", error);
      return [];
    }
    
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
  
  if (error) {
    console.error("Failed to clear history:", error);
    throw error;
  }
}

/* =========================================================
   AI
========================================================= */

async function askAI(jid, text, imageContext = null) {
  try {
    const history = await getHistory(jid);
    
    let input;
    
    if (imageContext) {
      // If we have image context, include it in the message
      input = [
        ...history,
        {
          role: "user",
          content: `[Image Summary]: ${imageContext}\n\n[User Message]: ${text}`
        }
      ];
    } else {
      input = [
        ...history,
        { role: "user", content: text }
      ];
    }
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30 second timeout
    
    try {
      const response = await fetch(
        CONFIG.AI_PROXY_URL,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: CONFIG.AI_MODEL,
            instructions: `You are ${CONFIG.AI_NAME}, a helpful WhatsApp AI assistant. Reply naturally and concisely for WhatsApp. Do not mention internal systems, API keys, Supabase, or proxy details. If an image summary is provided, use that context to answer questions about the image.`,
            input,
            max_output_tokens: 2048,
            temperature: 0.7
          }),
          signal: controller.signal
        }
      );
      
      const raw = await response.text();
      
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(`AI returned invalid JSON: ${raw.slice(0, 500)}`);
      }
      
      if (!response.ok) {
        throw new Error(
          data?.error?.message ||
          data?.error ||
          `AI HTTP ${response.status}`
        );
      }
      
      let answer = data?.output_text || "";
      
      // Fallback for normal chat-completion responses
      if (!answer) {
        answer = data?.choices?.[0]?.message?.content || "";
      }
      
      // Fallback for Responses-style output
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
      
      if (!answer) {
        throw new Error("AI returned an empty response");
      }
      
      await saveHistory(jid, "user", text);
      await saveHistory(jid, "assistant", answer);
      
      return answer;
      
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    console.error("AI request failed:", error);
    throw error;
  }
}

/* =========================================================
   DASHBOARD
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
.error{background:#fee;color:#c00;padding:10px;border-radius:8px;margin-top:10px;}
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
  
  if (!value) {
    document.getElementById("loginStatus").textContent = "Enter ADMIN_KEY.";
    return;
  }
  
  ADMIN_KEY = value;
  localStorage.setItem("adminKey", value);
  testAuth();
}

async function api(url, options = {}) {
  options.headers = {
    ...(options.headers || {}),
    "X-Admin-Key": ADMIN_KEY,
    "Content-Type": "application/json"
  };
  
  const response = await fetch(url, options);
  const text = await response.text();
  
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Server returned invalid response.");
  }
  
  if (response.status === 401) {
    localStorage.removeItem("adminKey");
    ADMIN_KEY = "";
    document.getElementById("login").classList.remove("hidden");
    document.getElementById("panel").classList.add("hidden");
    throw new Error("Wrong ADMIN_KEY.");
  }
  
  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }
  
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
          '<div class="user">' +
          '<span>' + user + '</span>' +
          ' <button class="danger" onclick="removeUser(\'' + user + '\')">Remove</button>' +
          '</div>'
        ).join("")
      : "<p>No users.</p>";
    
    document.getElementById("status").textContent = "Whitelist mode: " + data.whitelistOnly;
    
    const health = await fetch("/health").then(r => r.json());
    
    document.getElementById("botStatus").textContent = health.connected
      ? "🟢 WhatsApp connected"
      : "🟡 WhatsApp not connected";
  } catch (error) {
    document.getElementById("status").textContent = error.message;
  }
}

async function addUser() {
  const number = document.getElementById("number").value.trim();
  
  if (!number) {
    document.getElementById("status").textContent = "Please enter a number.";
    return;
  }
  
  try {
    const data = await api("/api/whitelist", {
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
  if (!confirm("Remove " + number + "?")) {
    return;
  }
  
  try {
    const data = await api("/api/whitelist", {
      method: "DELETE",
      body: JSON.stringify({ number })
    });
    
    document.getElementById("status").textContent = data.message;
    refresh();
  } catch (error) {
    document.getElementById("status").textContent = error.message;
  }
}

if (ADMIN_KEY) {
  testAuth();
}
</script>
</body>
</html>`;
}

/* =========================================================
   PAIR PAGE
========================================================= */

function pairHTML() {
  if (botConnected) {
    return `
    <!doctype html>
    <meta name="viewport" content="width=device-width">
    <div style="font-family:Arial;text-align:center;padding:30px">
    <h2>✅ WhatsApp Connected</h2>
    <p>No QR scan required.</p>
    </div>
    `;
  }
  
  if (!latestQR) {
    return `
    <!doctype html>
    <meta name="viewport" content="width=device-width">
    <div style="font-family:Arial;text-align:center;padding:30px">
    <h2>📱 Waiting for QR...</h2>
    <p>Refreshing...</p>
    <script>setTimeout(()=>location.reload(), 3000);</script>
    </div>
    `;
  }
  
  return `
  <!doctype html>
  <html>
  <head>
  <meta name="viewport" content="width=device-width">
  <meta http-equiv="refresh" content="4">
  <title>WhatsApp Pairing</title>
  </head>
  <body style="font-family:Arial;text-align:center;padding:20px">
  <h2>📱 Scan QR</h2>
  <img style="max-width:90%;width:400px" src="/qr.png?t=${Date.now()}">
  <p>WhatsApp → Linked devices → Link a device</p>
  <p>QR refreshes automatically.</p>
  </body>
  </html>
  `;
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
        pair: "/pair"
      });
    }
    
    // DASHBOARD - NO AUTH HERE
    if (url.pathname === "/dashboard") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      });
      return res.end(dashboardHTML());
    }
    
    // PROTECTED WHITELIST API
    if (url.pathname === "/api/whitelist") {
      if (!adminAuthorized(req)) {
        return sendJSON(res, 401, { error: "Unauthorized" });
      }
      
      if (req.method === "GET") {
        try {
          const users = await getWhitelist();
          return sendJSON(res, 200, {
            users,
            whitelistOnly: CONFIG.WHITELIST_ONLY
          });
        } catch (error) {
          return sendJSON(res, 500, { error: "Failed to fetch whitelist" });
        }
      }
      
      if (req.method === "POST" || req.method === "DELETE") {
        try {
          const body = await readRequestBody(req);
          const data = JSON.parse(body || "{}");
          const jid = normalizeJid(data.number);
          
          if (!jid) {
            return sendJSON(res, 400, { error: "Enter a valid WhatsApp number." });
          }
          
          if (req.method === "POST") {
            await addWhitelist(jid);
            return sendJSON(res, 200, {
              ok: true,
              message: `Added ${jid}`
            });
          }
          
          if (req.method === "DELETE") {
            await removeWhitelist(jid);
            return sendJSON(res, 200, {
              ok: true,
              message: `Removed ${jid}`
            });
          }
        } catch (error) {
          console.error("Whitelist API error:", error);
          return sendJSON(res, 400, { error: "Invalid request" });
        }
      }
      
      return sendJSON(res, 405, { error: "Method not allowed" });
    }
    
    // PAIR
    if (url.pathname === "/pair") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      });
      return res.end(pairHTML());
    }
    
    // QR
    if (url.pathname === "/qr.png") {
      if (!latestQR) {
        res.writeHead(404);
        return res.end("QR not ready");
      }
      
      try {
        const png = await QRCode.toBuffer(latestQR, {
          width: 500,
          margin: 2
        });
        
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
   START HTTP SERVER
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
    
    // Get latest WhatsApp version
    const { version } = await fetchLatestBaileysVersion();
    
    sock = makeWASocket({
      version,
      auth: state,
      logger,
      browser: ["Ayush AI", "Chrome", "1.0.0"],
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      markOnlineOnConnect: true
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
        console.log("✅ WhatsApp connected");
      }
      
      if (connection === "close") {
        botConnected = false;
        
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.error("WhatsApp connection closed:", statusCode);
        
        // Don't reconnect if logged out
        if (statusCode === DisconnectReason.loggedOut) {
          console.log("Logged out. Please re-scan QR code.");
          return;
        }
        
        // Reconnect with delay
        if (!reconnecting) {
          reconnecting = true;
          console.log("Reconnecting in 3 seconds...");
          
          setTimeout(() => {
            reconnecting = false;
            startBot().catch(error => {
              console.error("Reconnection failed:", error);
            });
          }, 3000);
        }
      }
    });
    
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      
      try {
        const msg = messages[0];
        
        if (!msg || msg.key.fromMe) {
          return;
        }
        
        const jid = msg.key.remoteJid;
        
        if (!jid || jid.endsWith("@g.us")) {
          return;
        }
        
        // Check if message contains an image
        const hasImage = 
          msg.message?.imageMessage ||
          msg.message?.documentMessage ||
          msg.message?.videoMessage;
        
        // Extract text from various message types
        const text = (
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          msg.message?.documentMessage?.caption ||
          ""
        ).trim();
        
        if (!text && !hasImage) {
          return;
        }
        
        console.log(`📩 ${jid}: ${text || "[Image/Media]"}`);
        
        await logMessage(jid, "incoming", text || "[Image/Media]");
        
        // START command
        if (/^(start|\/start)$/i.test(text)) {
          await addWhitelist(jid);
          
          const reply = "✅ You are opted in again.";
          
          await sock.sendMessage(jid, { text: reply });
          await logMessage(jid, "outgoing", reply);
          
          return;
        }
        
        // STOP command
        if (/^(stop|\/stop)$/i.test(text)) {
          await removeWhitelist(jid);
          
          const reply = "🛑 You have been opted out. Send START to enable the bot again.";
          
          await sock.sendMessage(jid, { text: reply });
          await logMessage(jid, "outgoing", reply);
          
          return;
        }
        
        // HELP command
        if (/^(help|\/help)$/i.test(text)) {
          const reply = `🤖 ${CONFIG.AI_NAME}\n\nCommands:\n\n/start or START\nEnable the bot.\n\nSTOP\nDisable the bot.\n\nHELP\nShow this help.\n\nCLEAR\nClear your AI memory.\n\n📸 Image Support:\nSend any image and I'll analyze and describe it!`;
          
          await sock.sendMessage(jid, { text: reply });
          await logMessage(jid, "outgoing", reply);
          
          return;
        }
        
        // WHITELIST CHECK
        if (!(await isAllowed(jid))) {
          console.log(`🚫 Blocked: ${jid}`);
          return;
        }
        
        // CLEAR command
        if (/^(clear|\/clear)$/i.test(text)) {
          await clearHistory(jid);
          
          const reply = "🧹 Your AI memory has been cleared.";
          
          await sock.sendMessage(jid, { text: reply });
          await logMessage(jid, "outgoing", reply);
          
          return;
        }
        
        // IMAGE PROCESSING
        if (hasImage) {
          try {
            // Send "processing" message
            await sock.sendMessage(jid, { text: "🖼️ Processing your image..." });
            
            // Download and process the image
            const imageData = await downloadAndProcessImage(msg);
            
            if (imageData) {
              // Summarize the image
              const imageSummary = await summarizeImage(imageData.buffer, imageData.mimetype);
              
              // Clean up temp file
              cleanupTempFile(imageData.tempFilePath);
              
              // Prepare the response
              let finalResponse;
              
              if (text) {
                // If there's text with the image, combine both
                finalResponse = await askAI(jid, text, imageSummary);
              } else {
                // Just send the image summary
                finalResponse = `📸 **Image Analysis:**\n\n${imageSummary}`;
              }
              
              await sock.sendMessage(jid, { text: finalResponse });
              await logMessage(jid, "outgoing", finalResponse);
              
              console.log(`🤖 ${jid}: ${finalResponse.slice(0, 100)}...`);
            }
          } catch (error) {
            console.error("Image processing error:", error);
            
            const reply = "⚠️ Failed to process image. Please try again with a smaller image.";
            
            await sock.sendMessage(jid, { text: reply });
            await logMessage(jid, "outgoing", reply);
          }
          
          return;
        }
        
        // AI RESPONSE for text messages
        try {
          await sock.sendMessage(jid, { text: "⏳ Thinking..." });
          
          const reply = await askAI(jid, text);
          
          await sock.sendMessage(jid, { text: reply });
          await logMessage(jid, "outgoing", reply);
          
          console.log(`🤖 ${jid}: ${reply.slice(0, 100)}...`);
        } catch (error) {
          console.error("AI error:", error);
          
          const reply = "⚠️ AI is temporarily unavailable. Please try again.";
          
          await sock.sendMessage(jid, { text: reply });
          await logMessage(jid, "outgoing", reply);
        }
      } catch (error) {
        console.error("Message handler error:", error);
      }
    });
    
  } catch (error) {
    console.error("Failed to start bot:", error);
    throw error;
  }
}

/* =========================================================
   START
========================================================= */

startBot().catch(error => {
  console.error("Fatal WhatsApp error:", error);
  // Don't exit, try to keep HTTP server running
  console.log("HTTP server will continue running for dashboard access");
});

// Handle process errors
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});

// Cleanup temp files on exit
process.on("SIGINT", () => {
  console.log("Cleaning up...");
  try {
    if (fs.existsSync(CONFIG.TEMP_DIR)) {
      fs.readdirSync(CONFIG.TEMP_DIR).forEach(file => {
        const filePath = path.join(CONFIG.TEMP_DIR, file);
        try {
          fs.unlinkSync(filePath);
        } catch (error) {
          console.error("Failed to delete temp file:", error);
        }
      });
    }
  } catch (error) {
    console.error("Cleanup error:", error);
  }
  process.exit(0);
});
