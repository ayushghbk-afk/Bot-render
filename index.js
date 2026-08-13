const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const pino = require("pino");
const QRCode = require("qrcode");
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const AI_PROXY_URL = process.env.AI_PROXY_URL || "https://groq-proxy.mr-hackerdon808.workers.dev/";
const AI_MODEL = process.env.AI_MODEL || "openai/gpt-oss-120b";
const AI_NAME = process.env.AI_NAME || "v1 of ayush";
const ORGANIZATION_NAME = process.env.ORGANIZATION_NAME || "ayush development labs";
const ENGINE_NAME = process.env.ENGINE_NAME || "v1 engine";
const MAX_OUTPUT_TOKENS = Math.min(3072, Math.max(256, Number(process.env.MAX_OUTPUT_TOKENS || 700)));
const TEMPERATURE = Math.max(0, Math.min(2, Number(process.env.TEMPERATURE || 0.7)));
const WHITELIST_ONLY = process.env.WHITELIST_ONLY !== "false";
const ALLOWED_USERS = (process.env.ALLOWED_USERS || "").split(",").map(x => x.trim()).filter(Boolean);
const ADMIN_KEY = process.env.ADMIN_KEY || "change-me";
const SESSION_DIR = process.env.SESSION_DIR || "./auth_session";
const DATA_DIR = process.env.DATA_DIR || "./data";

fs.mkdirSync(SESSION_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const files = {
  contacts: path.join(DATA_DIR, "contacts.json"),
  templates: path.join(DATA_DIR, "templates.json"),
  schedules: path.join(DATA_DIR, "schedules.json"),
  logs: path.join(DATA_DIR, "logs.json")
};
const defaults = {
  contacts: {},
  templates: {
    welcome: "Hi! 👋 Thanks for messaging. How can I help?",
    away: "Thanks for your message. We're currently outside working hours."
  },
  schedules: [],
  logs: []
};

function read(name) {
  try {
    if (!fs.existsSync(files[name])) fs.writeFileSync(files[name], JSON.stringify(defaults[name], null, 2));
    return JSON.parse(fs.readFileSync(files[name], "utf8"));
  } catch { return structuredClone(defaults[name]); }
}
function write(name, data) {
  fs.writeFileSync(files[name], JSON.stringify(data, null, 2));
}
function log(type, data = {}) {
  const logs = read("logs");
  logs.push({ time: new Date().toISOString(), type, ...data });
  write("logs", logs.slice(-1000));
}

let latestQR = null;
let botConnected = false;
let sock = null;
let reconnectTimer = null;

function jidFromInput(v) {
  if (!v) return "";
  if (v.includes("@")) return v;
  const digits = v.replace(/\D/g, "");
  return digits ? `${digits}@s.whatsapp.net` : "";
}
function contact(jid) {
  const c = read("contacts");
  return c[jid] || null;
}
function setContact(jid, patch) {
  const c = read("contacts");
  c[jid] = { ...(c[jid] || { jid, optedIn: false, blocked: false, name: "" }), ...patch, updatedAt: new Date().toISOString() };
  write("contacts", c);
  return c[jid];
}
function isAllowed(jid) {
  if (!WHITELIST_ONLY) return true;
  return ALLOWED_USERS.includes(jid) || !!contact(jid)?.optedIn;
}
function withinHours() {
  const start = process.env.WORK_START || "09:00";
  const end = process.env.WORK_END || "21:00";
  const enabled = process.env.WORKING_HOURS_ENABLED !== "false";
  if (!enabled) return true;
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  return mins >= sh * 60 + sm && mins <= eh * 60 + em;
}

async function askAI(jid, text) {
  const c = contact(jid);
  const history = (c?.memory || []).slice(-10);
  history.push({ role: "user", content: text });
  const instructions = `You are ${AI_NAME}, an AI assistant replying through WhatsApp for ${ORGANIZATION_NAME}. Engine: ${ENGINE_NAME}. Be concise, helpful and natural. Never claim to be human.`;
  const r = await fetch(AI_PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: AI_MODEL, instructions, messages: history, max_output_tokens: MAX_OUTPUT_TOKENS, temperature: TEMPERATURE })
  });
  const raw = await r.text();
  if (!r.ok) throw new Error(`AI proxy ${r.status}: ${raw.slice(0, 300)}`);
  let data; try { data = JSON.parse(raw); } catch { throw new Error("AI proxy returned invalid JSON"); }
  let reply = data.output_text || data.choices?.[0]?.message?.content || "";
  if (!reply && Array.isArray(data.output)) {
    reply = data.output.flatMap(x => x.content || []).map(x => x.text || "").join("");
  }
  reply = String(reply || "").trim();
  if (!reply) throw new Error("AI returned an empty response");
  history.push({ role: "assistant", content: reply });
  setContact(jid, { memory: history.slice(-10) });
  return reply;
}

async function sendText(jid, text, reason = "manual") {
  if (!sock || !botConnected) throw new Error("WhatsApp is not connected");
  const c = contact(jid);
  if (c?.blocked || c?.optedIn === false) throw new Error("Contact is not opted in");
  await sock.sendMessage(jid, { text });
  log("message_sent", { jid, reason, text: text.slice(0, 500) });
}

async function processMessage(msg) {
  if (!msg?.message || msg.key.fromMe || msg.key.remoteJid === "status@broadcast") return;
  const jid = msg.key.remoteJid;
  const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
  if (!text) return;

  const upper = text.toUpperCase();
  if (["STOP", "UNSUBSCRIBE", "CANCEL", "OPT OUT"].includes(upper)) {
    setContact(jid, { optedIn: false, blocked: true });
    await sock.sendMessage(jid, { text: "You have been opted out. I won't send automated messages. Send START anytime to opt back in." });
    log("opt_out", { jid });
    return;
  }
  if (upper === "START") {
    setContact(jid, { optedIn: true, blocked: false });
    await sock.sendMessage(jid, { text: "You're opted in again. 👍" });
    log("opt_in", { jid });
    return;
  }

  // Incoming replies can establish an opt-in contact after the user initiates.
  if (!contact(jid)?.blocked) setContact(jid, { optedIn: true, name: msg.pushName || contact(jid)?.name || "" });
  if (!isAllowed(jid)) {
    log("ignored_not_allowed", { jid });
    return;
  }

  if (!withinHours()) {
    const templates = read("templates");
    if (process.env.SEND_AWAY_REPLY === "true") {
      await sock.sendMessage(jid, { text: templates.away || "We're currently outside working hours." });
    }
    return;
  }

  try {
    await sock.sendPresenceUpdate("composing", jid);
    const reply = await askAI(jid, text);
    await sock.sendMessage(jid, { text: reply });
    log("ai_reply", { jid, text: text.slice(0, 300), reply: reply.slice(0, 500) });
  } catch (e) {
    log("ai_error", { jid, error: e.message });
    await sock.sendMessage(jid, { text: "⚠️ AI is temporarily unavailable. Please try again later." });
  } finally {
    try { await sock.sendPresenceUpdate("paused", jid); } catch {}
  }
}

async function startBot() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    browser: ["Online AI Bot", "Chrome", "1.0.0"],
    syncFullHistory: false
  });
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) { latestQR = qr; botConnected = false; log("qr_generated"); }
    if (connection === "open") { latestQR = null; botConnected = true; log("connected"); console.log("WhatsApp connected"); }
    if (connection === "close") {
      botConnected = false;
      const code = lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output?.statusCode : 0;
      if (code !== DisconnectReason.loggedOut) reconnectTimer = setTimeout(startBot, 5000);
      else console.log("Logged out. Delete auth_session and pair again.");
    }
  });
  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const m of messages) { try { await processMessage(m); } catch (e) { log("message_error", { error: e.message }); } }
  });
}

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
}
function auth(req) {
  return req.headers["x-admin-key"] === ADMIN_KEY;
}
function body(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", x => { b += x; if (b.length > 1e6) reject(new Error("Body too large")); });
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error("Invalid JSON")); } });
  });
}
function dashboard() {
  const c = read("contacts"), t = read("templates"), s = read("schedules"), l = read("logs");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>WhatsApp AI Bot v2</title>
  <style>body{font-family:system-ui;margin:0;background:#f4f6f8;color:#17202a}main{max-width:1000px;margin:auto;padding:20px}.card{background:white;padding:18px;margin:12px 0;border-radius:14px;box-shadow:0 2px 8px #0001}input,textarea,button{padding:10px;margin:4px;border:1px solid #ccd;border-radius:8px}button{cursor:pointer}.ok{color:#087f3f}.bad{color:#b42318}pre{white-space:pre-wrap}</style></head>
  <body><main><h1>🤖 WhatsApp AI Bot v2</h1><div class="card"><b>Status:</b> <span class="${botConnected?"ok":"bad"}">${botConnected?"Connected":"Offline"}</span><br><a href="/pair">📱 Pairing page</a> · <a href="/health">Health</a></div>
  <div class="card"><h2>Contacts</h2><p>${Object.values(c).length} contacts · ${Object.values(c).filter(x=>x.optedIn&&!x.blocked).length} opted in</p>
  <form method="post" action="/api/contact"><input name="jid" placeholder="919876543210" required><input name="name" placeholder="Name"><label><input type="checkbox" name="optedIn" checked> Opt in</label><button>Save</button></form></div>
  <div class="card"><h2>Send message</h2><form method="post" action="/api/send"><input name="jid" placeholder="919876543210" required><textarea name="text" placeholder="Message" required></textarea><button>Send</button></form></div>
  <div class="card"><h2>Templates</h2><form method="post" action="/api/templates"><textarea name="welcome" rows="3">${(t.welcome||"").replace(/</g,"&lt;")}</textarea><textarea name="away" rows="3">${(t.away||"").replace(/</g,"&lt;")}</textarea><button>Save templates</button></form></div>
  <div class="card"><h2>Schedules</h2><form method="post" action="/api/schedule"><input name="jid" placeholder="919876543210" required><input name="at" type="datetime-local" required><textarea name="text" placeholder="Message" required></textarea><button>Schedule</button></form><pre>${JSON.stringify(s,null,2)}</pre></div>
  <div class="card"><h2>AI controls</h2><p>Model: ${AI_MODEL}<br>Temperature: ${TEMPERATURE}<br>Max output: ${MAX_OUTPUT_TOKENS}<br>Working hours: ${process.env.WORK_START||"09:00"}–${process.env.WORK_END||"21:00"}</p></div>
  <div class="card"><h2>Recent logs</h2><pre>${JSON.stringify(l.slice(-30),null,2)}</pre></div></main></body></html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "OPTIONS") { res.writeHead(204, {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type,X-Admin-Key"}); return res.end(); }
    if (u.pathname === "/health") return json(res, 200, { ok:true, connected:botConnected, uptime:process.uptime() });
    if (u.pathname === "/pair") {
      if (!latestQR) return res.end(`<meta name="viewport" content="width=device-width"><h2>${botConnected?"✅ Already connected":"⏳ Waiting for QR..."}</h2><script>setTimeout(()=>location.reload(),5000)</script>`);
      const data = await QRCode.toDataURL(latestQR, {width:400,margin:2});
      return res.end(`<meta name="viewport" content="width=device-width"><div style="text-align:center;font-family:Arial"><h2>📱 Scan with WhatsApp</h2><img style="max-width:90%" src="${data}"><p>WhatsApp → Linked devices → Link a device</p><button onclick="location.reload()">Refresh</button></div>`);
    }
    if (u.pathname === "/" || u.pathname === "/dashboard") return res.end(dashboard());
    if (!auth(req)) return json(res, 401, {error:"Unauthorized. Set X-Admin-Key."});

    const b = await body(req);
    if (u.pathname === "/api/contact" && req.method === "POST") {
      const jid = jidFromInput(b.jid); if (!jid) return json(res,400,{error:"Invalid JID/number"});
      return json(res,200,setContact(jid,{name:b.name||"",optedIn:Boolean(b.optedIn),blocked:false}));
    }
    if (u.pathname === "/api/contacts" && req.method === "GET") return json(res,200,read("contacts"));
    if (u.pathname === "/api/send" && req.method === "POST") {
      const jid=jidFromInput(b.jid); await sendText(jid,String(b.text||""),"dashboard"); return json(res,200,{ok:true});
    }
    if (u.pathname === "/api/templates" && req.method === "POST") { write("templates",{welcome:String(b.welcome||""),away:String(b.away||"")}); return json(res,200,{ok:true}); }
    if (u.pathname === "/api/schedule" && req.method === "POST") {
      const s=read("schedules"); s.push({id:Date.now().toString(),jid:jidFromInput(b.jid),at:b.at,text:String(b.text||""),sent:false}); write("schedules",s); return json(res,200,{ok:true});
    }
    if (u.pathname === "/api/logs" && req.method === "GET") return json(res,200,read("logs").slice(-100));
    return json(res,404,{error:"Not found"});
  } catch(e) { log("http_error",{error:e.message}); return json(res,500,{error:e.message}); }
});

server.listen(PORT,"0.0.0.0",()=>console.log(`Dashboard listening on ${PORT}`));

setInterval(async () => {
  if (!sock || !botConnected) return;
  const schedules=read("schedules"), now=Date.now();
  let changed=false;
  for (const job of schedules) {
    if (!job.sent && Date.parse(job.at) <= now) {
      try { await sendText(job.jid,job.text,"schedule"); job.sent=true; changed=true; }
      catch(e) { job.error=e.message; job.sent=true; changed=true; log("schedule_error",{jid:job.jid,error:e.message}); }
    }
  }
  if (changed) write("schedules",schedules);
},15000);

startBot().catch(e=>{ console.error(e); log("startup_error",{error:e.message}); });
