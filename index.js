const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const QRCode = require("qrcode");
const pino = require("pino");
const http = require("http");
const fs = require("fs");
const path = require("path");

const CONFIG = {
  PORT: Number(process.env.PORT || 3000),
  ADMIN_KEY: process.env.ADMIN_KEY || "",
  AI_PROXY_URL: process.env.AI_PROXY_URL || "",
  AI_PROXY_SECRET: process.env.AI_PROXY_SECRET || "",
  AI_MODEL: process.env.AI_MODEL || "openai/gpt-oss-120b",
  AI_NAME: process.env.AI_NAME || "v1 of ayush",
  ORGANIZATION_NAME: process.env.ORGANIZATION_NAME || "ayush development labs",
  ENGINE_NAME: process.env.ENGINE_NAME || "v1 engine",
  MAX_OUTPUT_TOKENS: Number(process.env.MAX_OUTPUT_TOKENS || 500),
  TEMPERATURE: Number(process.env.TEMPERATURE || 0.7),
  WHITELIST_ONLY: process.env.WHITELIST_ONLY !== "false",
  ALLOWED_USERS: (process.env.ALLOWED_USERS || "").split(",").map(s => s.trim()).filter(Boolean),
  SESSION_DIR: process.env.SESSION_DIR || "./auth_session",
  DATA_DIR: process.env.DATA_DIR || "./data"
};

for (const d of [CONFIG.SESSION_DIR, CONFIG.DATA_DIR]) fs.mkdirSync(d, { recursive: true });

const files = {
  contacts: path.join(CONFIG.DATA_DIR, "contacts.json"),
  templates: path.join(CONFIG.DATA_DIR, "templates.json"),
  schedules: path.join(CONFIG.DATA_DIR, "schedules.json"),
  logs: path.join(CONFIG.DATA_DIR, "logs.json"),
  settings: path.join(CONFIG.DATA_DIR, "settings.json")
};

function readJSON(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback; }
  catch { return fallback; }
}
function writeJSON(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}
function logEvent(type, details = {}) {
  const logs = readJSON(files.logs, []);
  logs.push({ time: new Date().toISOString(), type, ...details });
  writeJSON(files.logs, logs.slice(-500));
}
function json(res, code, data) {
  res.writeHead(code, {"Content-Type":"application/json; charset=utf-8"});
  res.end(JSON.stringify(data));
}
function html(res, body) {
  res.writeHead(200, {"Content-Type":"text/html; charset=utf-8"});
  res.end(body);
}
function authorized(req) {
  if (!CONFIG.ADMIN_KEY) return false;
  return req.headers["x-admin-key"] === CONFIG.ADMIN_KEY;
}
async function body(req) {
  return await new Promise((resolve, reject) => {
    let s = "";
    req.on("data", c => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on("end", () => {
      try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

let sock = null;
let latestQR = null;
let connected = false;
let reconnecting = false;

const dashboard = `<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp AI Bot</title>
<style>
body{font-family:Arial;background:#f4f6f8;margin:0;padding:18px;color:#222}
.card{max-width:900px;margin:auto;background:white;border-radius:16px;padding:20px;box-shadow:0 3px 16px #0001}
button{padding:13px 16px;margin:5px;border:0;border-radius:10px;background:#111;color:white;font-size:15px}
input,textarea,select{width:100%;box-sizing:border-box;padding:11px;margin:6px 0;border:1px solid #ddd;border-radius:9px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px}
section{display:none;margin-top:18px;padding-top:12px;border-top:1px solid #eee}
section.active{display:block}
pre{white-space:pre-wrap;background:#111;color:#eee;padding:12px;border-radius:10px;max-height:300px;overflow:auto}
small{color:#666}
</style></head><body><div class="card">
<h1>🤖 WhatsApp AI Bot</h1><p id="status">Checking...</p>
<div class="grid">
<button onclick="show('send')">💬 Send Message</button>
<button onclick="show('contacts')">👥 Contacts</button>
<button onclick="show('schedule')">⏰ Schedule</button>
<button onclick="show('templates')">📝 Templates</button>
<button onclick="show('ai')">🤖 AI Controls</button>
<button onclick="show('logs')">📜 Logs</button>
<button onclick="location.href='/pair'">📱 Pair WhatsApp</button>
<button onclick="location.reload()">🔄 Refresh</button>
</div>
<section id="send" class="active"><h2>💬 Send Message</h2>
<input id="to" placeholder="919876543210@s.whatsapp.net">
<textarea id="msg" rows="4" placeholder="Message"></textarea>
<button onclick="sendMsg()">Send</button><p id="sendout"></p></section>
<section id="contacts"><h2>👥 Contacts / Opt-in</h2>
<input id="phone" placeholder="919876543210@s.whatsapp.net"><input id="cname" placeholder="Name">
<button onclick="contact(true)">✅ Opt in</button><button onclick="contact(false)">🛑 Opt out</button><pre id="contactsout"></pre></section>
<section id="schedule"><h2>⏰ Schedule</h2>
<input id="sto" placeholder="Number/JID"><input id="stime" type="datetime-local">
<textarea id="smsg" rows="3" placeholder="Message"></textarea><button onclick="schedule()">Schedule</button><pre id="scheduleout"></pre></section>
<section id="templates"><h2>📝 Templates</h2>
<input id="tname" placeholder="Template name"><textarea id="tbody" rows="3" placeholder="Template text"></textarea>
<button onclick="template()">Save template</button><pre id="templatesout"></pre></section>
<section id="ai"><h2>🤖 AI Controls</h2><p>Model and AI settings are controlled by Render environment variables.</p>
<pre id="aiout"></pre></section>
<section id="logs"><h2>📜 Logs</h2><button onclick="loadLogs()">Refresh logs</button><pre id="logsout"></pre></section>
</div>
<script>
const key=prompt("Enter ADMIN_KEY")||"";
async function api(url,opt={}){opt.headers=Object.assign({"Content-Type":"application/json","X-Admin-Key":key},opt.headers||{});let r=await fetch(url,opt);let d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||r.status);return d}
function show(id){document.querySelectorAll("section").forEach(x=>x.classList.remove("active"));document.getElementById(id).classList.add("active");if(id==="contacts")loadContacts();if(id==="schedule")loadSchedules();if(id==="templates")loadTemplates();if(id==="ai")loadAI();if(id==="logs")loadLogs()}
async function sendMsg(){try{let d=await api("/api/send",{method:"POST",body:JSON.stringify({to:to.value,text:msg.value})});sendout.textContent=d.message||"Sent"}catch(e){sendout.textContent="❌ "+e.message}}
async function contact(opt){try{let d=await api("/api/contacts",{method:"POST",body:JSON.stringify({jid:phone.value,name:cname.value,optIn:opt})});contactsout.textContent=JSON.stringify(d,null,2);loadContacts()}catch(e){contactsout.textContent="❌ "+e.message}}
async function loadContacts(){try{contactsout.textContent=JSON.stringify(await api("/api/contacts"),null,2)}catch(e){contactsout.textContent="❌ "+e.message}}
async function schedule(){try{let d=await api("/api/schedules",{method:"POST",body:JSON.stringify({to:sto.value,text:smsg.value,at:stime.value})});scheduleout.textContent=JSON.stringify(d,null,2)}catch(e){scheduleout.textContent="❌ "+e.message}}
async function loadSchedules(){try{scheduleout.textContent=JSON.stringify(await api("/api/schedules"),null,2)}catch(e){scheduleout.textContent="❌ "+e.message}}
async function template(){try{let d=await api("/api/templates",{method:"POST",body:JSON.stringify({name:tname.value,text:tbody.value})});templatesout.textContent=JSON.stringify(d,null,2)}catch(e){templatesout.textContent="❌ "+e.message}}
async function loadTemplates(){try{templatesout.textContent=JSON.stringify(await api("/api/templates"),null,2)}catch(e){templatesout.textContent="❌ "+e.message}}
async function loadAI(){try{aiout.textContent=JSON.stringify(await api("/api/ai"),null,2)}catch(e){aiout.textContent="❌ "+e.message}}
async function loadLogs(){try{logsout.textContent=JSON.stringify(await api("/api/logs"),null,2)}catch(e){logsout.textContent="❌ "+e.message}}
async function status(){try{let d=await fetch("/health").then(r=>r.json());document.getElementById("status").textContent=(d.connected?"🟢 Connected":"🟡 Waiting for WhatsApp")+" | uptime "+Math.round(d.uptime)+"s"}catch{}}
status();setInterval(status,5000);
</script></body></html>`;

function pairPage() {
  if (connected) return `<!doctype html><html><body style="font-family:Arial;text-align:center;padding:40px"><h2>✅ WhatsApp Connected</h2><p>Bot is already paired.</p></body></html>`;
  const image = latestQR ? `<img src="/qr.png?t=${Date.now()}" style="max-width:90%;width:420px">` : `<h2>Waiting for QR...</h2>`;
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5"></head>
<body style="font-family:Arial;text-align:center;background:#f4f6f8;padding:20px"><h2>📱 Scan with WhatsApp</h2>
${image}<p>WhatsApp → Linked devices → Link a device</p><small>QR refreshes automatically every 5 seconds.</small></body></html>`;
}

const server = http.createServer(async (req,res) => {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (u.pathname === "/health") return json(res,200,{ok:true,connected,uptime:process.uptime(),time:new Date().toISOString()});
  if (u.pathname === "/") return html(res, `<meta http-equiv="refresh" content="0;url=/dashboard">`);
  if (u.pathname === "/dashboard") return html(res,dashboard);
  if (u.pathname === "/pair") return html(res,pairPage());
  if (u.pathname === "/qr.png") {
    if (!latestQR) return json(res,404,{error:"QR not ready"});
    res.writeHead(200,{"Content-Type":"image/png","Cache-Control":"no-store"});
    return res.end(await QRCode.toBuffer(latestQR,{width:420,margin:2}));
  }
  if (u.pathname.startsWith("/api/")) {
    if (!authorized(req)) return json(res,401,{error:"Unauthorized. Set X-Admin-Key."});
    try {
      if (u.pathname === "/api/contacts") {
        if(req.method==="POST"){const d=await body(req);if(!d.jid) return json(res,400,{error:"jid required"});let a=readJSON(files.contacts,[]);let x=a.find(c=>c.jid===d.jid);if(x)Object.assign(x,d);else a.push({jid:d.jid,name:d.name||"",optIn:!!d.optIn});writeJSON(files.contacts,a);logEvent("contact_update",{jid:d.jid,optIn:!!d.optIn});}
        return json(res,200,readJSON(files.contacts,[]));
      }
      if (u.pathname === "/api/send" && req.method==="POST") {
        const d=await body(req); if(!sock||!connected)return json(res,503,{error:"WhatsApp not connected"});
        const contacts=readJSON(files.contacts,[]); const c=contacts.find(x=>x.jid===d.to);
        if(!c || !c.optIn)return json(res,403,{error:"Recipient is not opted in"});
        await sock.sendMessage(d.to,{text:String(d.text||"")}); logEvent("message_sent",{to:d.to}); return json(res,200,{ok:true,message:"Message sent"});
      }
      if (u.pathname === "/api/schedules") {
        if(req.method==="POST"){const d=await body(req);if(!d.to||!d.text||!d.at)return json(res,400,{error:"to, text and at required"});let a=readJSON(files.schedules,[]);a.push({id:Date.now().toString(),to:d.to,text:d.text,at:d.at,sent:false});writeJSON(files.schedules,a);return json(res,200,{ok:true});}
        return json(res,200,readJSON(files.schedules,[]));
      }
      if (u.pathname === "/api/templates") {
        if(req.method==="POST"){const d=await body(req);if(!d.name||!d.text)return json(res,400,{error:"name and text required"});let a=readJSON(files.templates,[]);a.push({name:d.name,text:d.text});writeJSON(files.templates,a);return json(res,200,{ok:true});}
        return json(res,200,readJSON(files.templates,[]));
      }
      if (u.pathname === "/api/logs") return json(res,200,readJSON(files.logs,[]).slice(-200));
      if (u.pathname === "/api/ai") return json(res,200,{model:CONFIG.AI_MODEL,name:CONFIG.AI_NAME,maxOutputTokens:CONFIG.MAX_OUTPUT_TOKENS,temperature:CONFIG.TEMPERATURE,proxyConfigured:!!CONFIG.AI_PROXY_URL});
      return json(res,404,{error:"Not found"});
    } catch(e) { console.error(e); return json(res,500,{error:e.message}); }
  }
  json(res,404,{error:"Not found"});
});

server.listen(CONFIG.PORT,"0.0.0.0",()=>console.log(`🌐 HTTP server listening on ${CONFIG.PORT}`));

async function startBot(){
  const {state,saveCreds}=await useMultiFileAuthState(CONFIG.SESSION_DIR);
  sock=makeWASocket({auth:state,logger,browser:["Online AI Bot","Chrome","1.0.0"],syncFullHistory:false});
  sock.ev.on("creds.update",saveCreds);
  sock.ev.on("connection.update", async ({connection,lastDisconnect,qr})=>{
    if(qr){latestQR=qr;connected=false;console.log("📱 New QR available at /pair");}
    if(connection==="open"){connected=true;latestQR=null;console.log("✅ WhatsApp connected");logEvent("whatsapp_connected");}
    if(connection==="close"){
      connected=false;
      const code=lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output?.statusCode : 0;
      if(code!==DisconnectReason.loggedOut && !reconnecting){reconnecting=true;setTimeout(()=>{reconnecting=false;startBot().catch(console.error)},5000);}
      else if(code===DisconnectReason.loggedOut) console.log("❌ WhatsApp logged out; remove auth_session to pair again.");
    }
  });
  sock.ev.on("messages.upsert",async ({messages})=>{
    const msg=messages?.[0]; if(!msg?.message||msg.key.fromMe)return;
    const from=msg.key.remoteJid; if(!from||from==="status@broadcast")return;
    const text=(msg.message.conversation||msg.message.extendedTextMessage?.text||"").trim();
    if(!text)return;
    const contacts=readJSON(files.contacts,[]);
    let c=contacts.find(x=>x.jid===from);
    if(/^(stop|unsubscribe|cancel)$/i.test(text)){if(c)c.optIn=false;else contacts.push({jid:from,optIn:false});writeJSON(files.contacts,contacts);await sock.sendMessage(from,{text:"You have been opted out. Send START to opt in again."});return;}
    if(/^start$/i.test(text)){if(c)c.optIn=true;else contacts.push({jid:from,optIn:true});writeJSON(files.contacts,contacts);await sock.sendMessage(from,{text:"You are opted in again."});return;}
    if(CONFIG.WHITELIST_ONLY&&!CONFIG.ALLOWED_USERS.includes(from))return;
    if(!CONFIG.AI_PROXY_URL)return;
    try{
      const contacts2=readJSON(files.contacts,[]); const contact=contacts2.find(x=>x.jid===from);
      if(!contact?.optIn)return;
      const headers={"Content-Type":"application/json"}; if(CONFIG.AI_PROXY_SECRET)headers.Authorization=`Bearer ${CONFIG.AI_PROXY_SECRET}`;
      const r=await fetch(CONFIG.AI_PROXY_URL,{method:"POST",headers,body:JSON.stringify({model:CONFIG.AI_MODEL,instructions:`You are ${CONFIG.AI_NAME}. Be helpful, concise and natural on WhatsApp.`,messages:[{role:"user",content:text}],max_output_tokens:CONFIG.MAX_OUTPUT_TOKENS,temperature:CONFIG.TEMPERATURE})});
      if(!r.ok)throw new Error(`AI ${r.status}`);
      const d=await r.json();let reply=d.output_text||d.choices?.[0]?.message?.content||"";
      if(reply){await sock.sendMessage(from,{text:String(reply).trim()});logEvent("ai_reply",{to:from});}
    }catch(e){console.error("[AI]",e.message);logEvent("ai_error",{error:e.message});}
  });
}

setInterval(async()=>{
  if(!sock||!connected)return;
  const a=readJSON(files.schedules,[]);let changed=false;const now=Date.now();
  for(const x of a){
    if(x.sent)continue;
    const t=new Date(x.at).getTime(); if(!Number.isFinite(t)||t>now)continue;
    const c=readJSON(files.contacts,[]).find(c=>c.jid===x.to);
    if(!c?.optIn){x.sent=true;changed=true;logEvent("scheduled_skipped",{to:x.to,reason:"not_opted_in"});continue;}
    try{await sock.sendMessage(x.to,{text:x.text});x.sent=true;changed=true;logEvent("scheduled_sent",{to:x.to});}catch(e){logEvent("scheduled_error",{to:x.to,error:e.message});}
  }
  if(changed)writeJSON(files.schedules,a);
},5000);

startBot().catch(e=>{console.error("Fatal:",e);process.exit(1);});
