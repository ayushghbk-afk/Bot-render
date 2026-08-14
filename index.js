
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const pino = require("pino");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");
const http = require("http");

const logger = pino({ level: "silent" });

const CONFIG = {
  PORT: Number(process.env.PORT || 3000),
  SESSION_DIR: process.env.SESSION_DIR || "./auth_session",
  ADMIN_KEY: process.env.ADMIN_KEY || "",
  WHITELIST_ONLY: process.env.WHITELIST_ONLY !== "false",
  ALLOWED_USERS: (process.env.ALLOWED_USERS || "")
    .split(",").map(x => x.trim()).filter(Boolean)
};

fs.mkdirSync(CONFIG.SESSION_DIR, { recursive: true });

let sock = null;
let latestQR = null;
let botConnected = false;
let reconnecting = false;

const DATA_FILE = path.join(CONFIG.SESSION_DIR, "whitelist.json");

function loadWhitelist() {
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveWhitelist(list) {
  fs.writeFileSync(DATA_FILE, JSON.stringify([...new Set(list)], null, 2));
}

function normalizeJid(value) {
  let v = String(value || "").trim();
  if (!v) return "";
  if (v.includes("@s.whatsapp.net")) return v;
  v = v.replace(/[^\d]/g, "");
  return v ? `${v}@s.whatsapp.net` : "";
}

function getWhitelist() {
  const stored = loadWhitelist();
  const envUsers = CONFIG.ALLOWED_USERS.map(normalizeJid).filter(Boolean);
  return [...new Set([...envUsers, ...stored])];
}

function isAllowed(jid) {
  if (!CONFIG.WHITELIST_ONLY) return true;
  return getWhitelist().includes(jid);
}

function adminAuthorized(req) {
  if (!CONFIG.ADMIN_KEY) return false;
  return req.headers["x-admin-key"] === CONFIG.ADMIN_KEY;
}

function sendJSON(res, code, data) {
  res.writeHead(code, {"Content-Type":"application/json; charset=utf-8"});
  res.end(JSON.stringify(data));
}

function dashboardHTML() {
  return `<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp Bot Admin</title>
<style>
body{font-family:Arial;margin:0;background:#f4f6f8;color:#222}
main{max-width:650px;margin:auto;padding:20px}
.card{background:#fff;border-radius:14px;padding:18px;margin:12px 0;box-shadow:0 2px 10px #0001}
input,button{font-size:16px;padding:12px;border-radius:9px;border:1px solid #ccc;box-sizing:border-box}
input{width:100%;margin:6px 0 10px}
button{cursor:pointer;background:#111;color:#fff;border:0;margin:4px 2px}
button.danger{background:#b00020}
.row{display:flex;gap:6px}.row input{flex:1}
li{margin:9px 0;word-break:break-all}
small{color:#666}
#status{padding:10px;background:#eef}
</style></head>
<body><main>
<h2>🤖 WhatsApp Bot Admin</h2>
<div class="card"><b>Whitelist</b><p><small>Add a WhatsApp number. Example: +91 9876543210</small></p>
<div class="row"><input id="number" placeholder="+91 9876543210"><button onclick="addUser()">Add</button></div>
<p id="status"></p></div>
<div class="card"><b>Allowed users</b><ul id="users"><li>Loading...</li></ul></div>
<div class="card"><button onclick="loadUsers()">🔄 Refresh</button> <button onclick="location.href='/pair'">📱 Pair WhatsApp</button></div>
<script>
function key(){return localStorage.getItem("adminKey")||prompt("Enter ADMIN_KEY");}
async function api(url,opt={}){
  const k=key(); if(k) localStorage.setItem("adminKey",k);
  opt.headers=Object.assign({},opt.headers,{"X-Admin-Key":k||""});
  const r=await fetch(url,opt); const d=await r.json();
  if(r.status===401) throw Error("Unauthorized. Check ADMIN_KEY.");
  return d;
}
async function loadUsers(){
  try{
    const d=await api("/api/whitelist");
    document.getElementById("users").innerHTML=d.users.length
      ? d.users.map(u=>"<li>"+u+" <button class='danger' onclick='removeUser("+JSON.stringify(u)+")'>Remove</button></li>").join("")
      : "<li>No dashboard-added users.</li>";
    document.getElementById("status").textContent="Whitelist mode: "+d.whitelistOnly;
  }catch(e){document.getElementById("status").textContent=e.message}
}
async function addUser(){
  const n=document.getElementById("number").value;
  try{
    const d=await api("/api/whitelist",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({number:n})});
    document.getElementById("number").value="";
    document.getElementById("status").textContent=d.message;
    loadUsers();
  }catch(e){document.getElementById("status").textContent=e.message}
}
async function removeUser(n){
  if(!confirm("Remove "+n+" from whitelist?")) return;
  try{
    const d=await api("/api/whitelist",{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({number:n})});
    document.getElementById("status").textContent=d.message;
    loadUsers();
  }catch(e){document.getElementById("status").textContent=e.message}
}
loadUsers();
</script></main></body></html>`;
}

function pairHTML() {
  if (botConnected) return `<!doctype html><meta name="viewport" content="width=device-width"><div style="font-family:Arial;text-align:center;padding:30px"><h2>✅ WhatsApp Connected</h2><p>No QR scan needed.</p></div>`;
  if (!latestQR) return `<!doctype html><meta name="viewport" content="width=device-width"><div style="font-family:Arial;text-align:center;padding:30px"><h2>📱 Waiting for QR...</h2><p>Auto-refreshing...</p><script>setTimeout(()=>location.reload(),3000)</script></div>`;
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="4"><title>WhatsApp Pairing</title></head><body style="font-family:Arial;text-align:center;padding:20px;background:#f4f4f4"><h2>📱 Scan with WhatsApp</h2><div style="background:#fff;padding:15px;display:inline-block;border-radius:15px"><img style="max-width:90vw;width:400px" src="/qr.png?t=${Date.now()}"></div><p>WhatsApp → Linked devices → Link a device</p><p>QR automatically refreshes every few seconds.</p></body></html>`;
}

const server = http.createServer(async (req,res)=>{
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if(url.pathname === "/health")
    return sendJSON(res,200,{ok:true,connected:botConnected,uptime:process.uptime()});

  if(url.pathname === "/")
    return sendJSON(res,200,{ok:true,service:"whatsapp-ai-bot",dashboard:"/dashboard",pair:"/pair"});

  if(url.pathname === "/dashboard") {
    if(!adminAuthorized(req)) return sendJSON(res,401,{error:"Unauthorized. Set X-Admin-Key."});
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
    return res.end(dashboardHTML());
  }

  if(url.pathname === "/api/whitelist") {
    if(!adminAuthorized(req)) return sendJSON(res,401,{error:"Unauthorized. Set X-Admin-Key."});
    const list=loadWhitelist();
    if(req.method==="GET") return sendJSON(res,200,{users:list,whitelistOnly:CONFIG.WHITELIST_ONLY});
    let body="";
    req.on("data",c=>body+=c);
    req.on("end",()=>{
      try{
        const data=JSON.parse(body||"{}");
        const jid=normalizeJid(data.number);
        if(!jid) return sendJSON(res,400,{error:"Enter a valid WhatsApp number."});
        let next=loadWhitelist();
        if(req.method==="DELETE") {
          next=next.filter(x=>x!==jid);
          saveWhitelist(next);
          return sendJSON(res,200,{ok:true,message:`Removed ${jid}`,users:next});
        }
        if(req.method!=="POST") return sendJSON(res,405,{error:"Method not allowed"});
        if(!next.includes(jid)) next.push(jid);
        saveWhitelist(next);
        return sendJSON(res,200,{ok:true,message:`Added ${jid}`,users:next});
      }catch(e){return sendJSON(res,400,{error:"Invalid JSON."});}
    });
    return;
  }

  if(url.pathname === "/pair") {
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
    return res.end(pairHTML());
  }

  if(url.pathname === "/qr.png") {
    if(!latestQR) {res.writeHead(404);return res.end("QR not ready");}
    try {
      const png=await QRCode.toBuffer(latestQR,{width:500,margin:2});
      res.writeHead(200,{"Content-Type":"image/png","Cache-Control":"no-store"});
      return res.end(png);
    } catch(e){res.writeHead(500);return res.end("QR error");}
  }

  res.writeHead(404); res.end("Not found");
});

server.listen(CONFIG.PORT,"0.0.0.0",()=>console.log(`🌐 HTTP server listening on ${CONFIG.PORT}`));

async function startBot() {
  const {state,saveCreds}=await useMultiFileAuthState(CONFIG.SESSION_DIR);
  sock=makeWASocket({
    auth:state,
    logger,
    browser:["Online AI Bot","Chrome","1.0.0"],
    syncFullHistory:false
  });

  sock.ev.on("creds.update",saveCreds);

  sock.ev.on("connection.update",async ({connection,lastDisconnect,qr})=>{
    if(qr){latestQR=qr;botConnected=false;console.log("📱 New QR generated");}
    if(connection==="open"){botConnected=true;latestQR=null;console.log("✅ WhatsApp connected");}
    if(connection==="close"){
      botConnected=false;
      const code=new Boom(lastDisconnect?.error)?.output?.statusCode;
      if(code!==DisconnectReason.loggedOut && !reconnecting){
        reconnecting=true;
        setTimeout(()=>{reconnecting=false;startBot().catch(console.error)},3000);
      }
    }
  });

  sock.ev.on("messages.upsert",async ({messages})=>{
    const msg=messages?.[0];
    if(!msg || msg.key.fromMe) return;
    const jid=msg.key.remoteJid;
    if(!jid || jid.endsWith("@g.us")) return;

    if(!isAllowed(jid)){
      console.log(`🚫 Whitelist blocked: ${jid}`);
      return;
    }

    const text=(msg.message?.conversation || msg.message?.extendedTextMessage?.text || "").trim();
    if(!text) return;

    if(/^stop$/i.test(text)){
      const list=getWhitelist().filter(x=>x!==jid);
      saveWhitelist(list.filter(x=>!CONFIG.ALLOWED_USERS.map(normalizeJid).includes(x)));
      await sock.sendMessage(jid,{text:"🛑 Opt-out received. You will no longer receive bot replies."});
      return;
    }

    if(/^start$/i.test(text)){
      const list=loadWhitelist();
      if(!list.includes(jid)) list.push(jid);
      saveWhitelist(list);
      await sock.sendMessage(jid,{text:"✅ You are opted in again."});
      return;
    }

    // Simple automatic reply; replace with your AI function if desired.
    await sock.sendMessage(jid,{text:"🤖 Message received! Your number is whitelisted."});
  });
}

startBot().catch(err=>{console.error("Fatal:",err);process.exit(1);});
