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
  return `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp AI Bot v2</title>
<style>
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;margin:0;background:#f4f6f8;color:#17202a}
main{max-width:1000px;margin:auto;padding:16px}
.card{background:#fff;padding:18px;margin:12px 0;border-radius:16px;box-shadow:0 2px 10px #0001}
h1,h2{margin-top:0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}
button{padding:12px 14px;border:0;border-radius:10px;background:#111827;color:#fff;font-weight:600;cursor:pointer}
button.secondary{background:#e8edf2;color:#17202a}
button.danger{background:#b42318}
input,textarea,select{width:100%;padding:11px;margin:5px 0;border:1px solid #ccd3da;border-radius:9px;font:inherit}
textarea{min-height:90px;resize:vertical}
.row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.hidden{display:none}
.muted{color:#667085;font-size:14px}
.ok{color:#087f3f;font-weight:700}
.bad{color:#b42318;font-weight:700}
.item{padding:10px;border:1px solid #e5e7eb;border-radius:10px;margin:7px 0}
pre{white-space:pre-wrap;word-break:break-word;max-height:420px;overflow:auto}
#toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:#111827;color:white;padding:11px 16px;border-radius:10px;display:none;z-index:9}
</style>
</head>
<body>
<main>
<h1>🤖 WhatsApp AI Bot</h1>

<div id="login" class="card">
  <h2>🔐 Admin Login</h2>
  <p class="muted">Enter the ADMIN_KEY you configured in Render.</p>
  <input id="adminKey" type="password" placeholder="Admin key">
  <button onclick="login()">Login</button>
</div>

<div id="app" class="hidden">
  <div class="card">
    <div class="grid">
      <button onclick="show('send')">💬 Send Message</button>
      <button onclick="show('contacts')">👥 Contacts</button>
      <button onclick="show('schedule')">⏰ Schedule</button>
      <button onclick="show('templates')">📝 Templates</button>
      <button onclick="show('ai')">🤖 AI Controls</button>
      <button onclick="show('logs')">📜 Logs</button>
      <button class="secondary" onclick="window.open('/pair','_blank')">📱 Pair WhatsApp</button>
      <button class="secondary" onclick="refreshAll()">🔄 Refresh</button>
      <button class="danger" onclick="logout()">Logout</button>
    </div>
  </div>

  <div id="status" class="card"></div>

  <section id="send" class="card panel">
    <h2>💬 Send Message</h2>
    <input id="sendJid" placeholder="WhatsApp number e.g. 919876543210">
    <textarea id="sendText" placeholder="Type your message..."></textarea>
    <button onclick="sendMessage()">🚀 Send</button>
  </section>

  <section id="contacts" class="card panel hidden">
    <h2>👥 Contacts</h2>
    <div class="row">
      <div><input id="contactJid" placeholder="919876543210"></div>
      <div><input id="contactName" placeholder="Name"></div>
    </div>
    <label><input id="contactOpt" type="checkbox" checked> Opted in</label>
    <button onclick="saveContact()">➕ Add / Update Contact</button>
    <div id="contactList"></div>
  </section>

  <section id="schedule" class="card panel hidden">
    <h2>⏰ Schedule Message</h2>
    <input id="scheduleJid" placeholder="919876543210">
    <input id="scheduleAt" type="datetime-local">
    <textarea id="scheduleText" placeholder="Message to send later..."></textarea>
    <button onclick="scheduleMessage()">📅 Schedule</button>
    <div id="scheduleList"></div>
  </section>

  <section id="templates" class="card panel hidden">
    <h2>📝 Templates</h2>
    <label>Welcome message</label>
    <textarea id="welcome"></textarea>
    <label>Away message</label>
    <textarea id="away"></textarea>
    <button onclick="saveTemplates()">💾 Save Templates</button>
  </section>

  <section id="ai" class="card panel hidden">
    <h2>🤖 AI Controls</h2>
    <p><b>Model:</b> ${AI_MODEL}</p>
    <p><b>Temperature:</b> ${TEMPERATURE}</p>
    <p><b>Max output:</b> ${MAX_OUTPUT_TOKENS}</p>
    <p><b>Working hours:</b> ${process.env.WORK_START || "09:00"} – ${process.env.WORK_END || "21:00"}</p>
    <p class="muted">These values are controlled by Render environment variables.</p>
  </section>

  <section id="logs" class="card panel hidden">
    <h2>📜 Recent Logs</h2>
    <pre id="logsBox">Loading...</pre>
  </section>
</div>
</main>
<div id="toast"></div>

<script>
let KEY = sessionStorage.getItem("adminKey") || "";

function toast(msg) {
  const t=document.getElementById("toast");
  t.textContent=msg;t.style.display="block";
  setTimeout(()=>t.style.display="none",2500);
}

async function api(path, options={}) {
  options.headers = Object.assign(
    {"Content-Type":"application/json","X-Admin-Key":KEY},
    options.headers || {}
  );
  const r=await fetch(path,options);
  const data=await r.json().catch(()=>({}));
  if(r.status===401){logout();throw new Error("Unauthorized");}
  if(!r.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function login(){
  KEY=document.getElementById("adminKey").value.trim();
  if(!KEY) return toast("Enter your admin key");
  sessionStorage.setItem("adminKey",KEY);
  try{
    await api("/api/contacts");
    document.getElementById("login").classList.add("hidden");
    document.getElementById("app").classList.remove("hidden");
    refreshAll();
    toast("✅ Logged in");
  }catch(e){
    sessionStorage.removeItem("adminKey"); KEY="";
    toast("❌ Wrong admin key");
  }
}

function logout(){
  sessionStorage.removeItem("adminKey"); KEY="";
  document.getElementById("app").classList.add("hidden");
  document.getElementById("login").classList.remove("hidden");
}

function show(id){
  document.querySelectorAll(".panel").forEach(x=>x.classList.add("hidden"));
  document.getElementById(id).classList.remove("hidden");
}

async function refreshStatus(){
  const d=await fetch("/health?x="+Date.now(),{cache:"no-store"}).then(r=>r.json());
  document.getElementById("status").innerHTML =
    "<b>Status:</b> <span class='"+(d.connected?"ok":"bad")+"'>"+
    (d.connected?"🟢 WhatsApp Connected":"🔴 WhatsApp Offline")+
    "</span><br><span class='muted'>Uptime: "+Math.floor(d.uptime/60)+" minutes</span>";
}

async function sendMessage(){
  const jid=document.getElementById("sendJid").value;
  const text=document.getElementById("sendText").value;
  if(!jid||!text) return toast("Enter recipient and message");
  try{await api("/api/send",{method:"POST",body:JSON.stringify({jid,text})});
      document.getElementById("sendText").value="";toast("✅ Message sent");}
  catch(e){toast("❌ "+e.message);}
}

async function saveContact(){
  const jid=document.getElementById("contactJid").value;
  const name=document.getElementById("contactName").value;
  const optedIn=document.getElementById("contactOpt").checked;
  try{await api("/api/contact",{method:"POST",body:JSON.stringify({jid,name,optedIn})});
      toast("✅ Contact saved");loadContacts();}
  catch(e){toast("❌ "+e.message);}
}

async function loadContacts(){
  const c=await api("/api/contacts");
  const arr=Object.values(c);
  document.getElementById("contactList").innerHTML=arr.length?arr.map(x=>
    "<div class='item'><b>"+escapeHtml(x.name||"Unnamed")+"</b><br>"+
    escapeHtml(x.jid)+"<br>"+
    (x.optedIn&&!x.blocked?"✅ Opted in":"🛑 Opted out")+"</div>").join("")
    :"<p class='muted'>No contacts yet.</p>";
}

async function scheduleMessage(){
  const jid=document.getElementById("scheduleJid").value;
  const at=document.getElementById("scheduleAt").value;
  const text=document.getElementById("scheduleText").value;
  if(!jid||!at||!text) return toast("Fill all fields");
  try{await api("/api/schedule",{method:"POST",body:JSON.stringify({jid,at,text})});
      toast("⏰ Message scheduled");loadSchedules();}
  catch(e){toast("❌ "+e.message);}
}

async function loadSchedules(){
  const d=await api("/api/schedules");
  document.getElementById("scheduleList").innerHTML=d.map(x=>
    "<div class='item'>"+escapeHtml(x.at)+" → "+escapeHtml(x.jid)+"<br>"+
    escapeHtml(x.text)+"<br>"+(x.sent?"✅ Sent":"⏳ Pending")+"</div>").join("") ||
    "<p class='muted'>No scheduled messages.</p>";
}

async function loadTemplates(){
  const t=await api("/api/templates");
  document.getElementById("welcome").value=t.welcome||"";
  document.getElementById("away").value=t.away||"";
}

async function saveTemplates(){
  try{await api("/api/templates",{method:"POST",body:JSON.stringify({
    welcome:document.getElementById("welcome").value,
    away:document.getElementById("away").value
  })});toast("✅ Templates saved");}
  catch(e){toast("❌ "+e.message);}
}

async function loadLogs(){
  const l=await api("/api/logs");
  document.getElementById("logsBox").textContent=JSON.stringify(l,null,2);
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));
}

async function refreshAll(){
  try{
    await refreshStatus();
    await loadContacts();
    await loadSchedules();
    await loadTemplates();
    await loadLogs();
  }catch(e){toast("❌ "+e.message);}
}

if(KEY){
  document.getElementById("adminKey").value=KEY;
  login();
}
</script>
</body>
</html>`;
}
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "OPTIONS") { res.writeHead(204, {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type,X-Admin-Key"}); return res.end(); }
    if (u.pathname === "/health") return json(res, 200, { ok:true, connected:botConnected, uptime:process.uptime() });
    if (u.pathname === "/pair/qr") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        "Pragma": "no-cache",
        "Expires": "0"
      });

      if (botConnected) {
        return res.end(JSON.stringify({ connected: true, qr: null }));
      }

      if (!latestQR) {
        return res.end(JSON.stringify({ connected: false, qr: null }));
      }

      try {
        const qrDataUrl = await QRCode.toDataURL(latestQR, {
          width: 400,
          margin: 2,
          type: "image/png"
        });

        return res.end(JSON.stringify({
          connected: false,
          qr: qrDataUrl,
          generatedAt: Date.now()
        }));
      } catch (err) {
        console.error("[QR API ERROR]", err);
        return res.end(JSON.stringify({
          connected: false,
          qr: null
        }));
      }
    }

    if (u.pathname === "/pair") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        "Pragma": "no-cache",
        "Expires": "0"
      });

      return res.end(`<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Cache-Control" content="no-store">
<title>WhatsApp Pairing</title>
<style>
body{font-family:Arial,sans-serif;text-align:center;background:#f5f5f5;padding:20px;margin:0}
.card{background:#fff;display:inline-block;padding:20px;border-radius:16px;
box-shadow:0 2px 12px #0002;max-width:460px;width:calc(100% - 40px)}
#qr{width:min(400px,90vw);height:a
