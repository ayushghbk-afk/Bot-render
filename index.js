const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const { Boom } = require("@hapi/boom");
const pino = require("pino");
const QRCode = require("qrcode");
const http = require("http");

const { createClient } = require("@supabase/supabase-js");

const logger = pino({ level: "silent" });

/* ============================================================
   CONFIG
============================================================ */

const CONFIG = {
  PORT: Number(process.env.PORT || 3000),

  SESSION_DIR:
    process.env.SESSION_DIR || "./auth_session",

  ADMIN_KEY:
    process.env.ADMIN_KEY || "",

  WHITELIST_ONLY:
    process.env.WHITELIST_ONLY !== "false",

  ALLOWED_USERS:
    (process.env.ALLOWED_USERS || "")
      .split(",")
      .map(x => x.trim())
      .filter(Boolean),

  AI_PROXY_URL:
    process.env.AI_PROXY_URL ||
    "https://groq-proxy.mr-hackerdon808.workers.dev/",

  AI_MODEL:
    process.env.AI_MODEL ||
    "openai/gpt-oss-120b",

  AI_NAME:
    process.env.AI_NAME ||
    "v1 of ayush",

  MAX_OUTPUT_TOKENS:
    Number(process.env.MAX_OUTPUT_TOKENS || 2048),

  TEMPERATURE:
    Number(process.env.TEMPERATURE || 0.7)
};


/* ============================================================
   SUPABASE
============================================================ */

const SUPABASE_URL =
  process.env.SUPABASE_URL;

const SUPABASE_SECRET_KEY =
  process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL) {
  console.error("❌ SUPABASE_URL is missing");
  process.exit(1);
}

if (!SUPABASE_SECRET_KEY) {
  console.error("❌ SUPABASE_SECRET_KEY is missing");
  process.exit(1);
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SECRET_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
);


/* ============================================================
   GLOBAL STATE
============================================================ */

let sock = null;
let latestQR = null;
let botConnected = false;
let reconnecting = false;


/* ============================================================
   JID
============================================================ */

function normalizeJid(value) {
  let v = String(value || "").trim();

  if (!v) return "";

  if (v.includes("@s.whatsapp.net")) {
    return v;
  }

  v = v.replace(/[^\d]/g, "");

  return v
    ? `${v}@s.whatsapp.net`
    : "";
}


/* ============================================================
   USERS
============================================================ */

async function getUser(jid) {
  const { data, error } =
    await supabase
      .from("users")
      .select("*")
      .eq("phone", jid)
      .maybeSingle();

  if (error) {
    console.error(
      "Supabase getUser error:",
      error.message
    );

    return null;
  }

  return data;
}


async function ensureUser(jid) {
  const existing =
    await getUser(jid);

  if (existing) {
    await supabase
      .from("users")
      .update({
        last_seen_at:
          new Date().toISOString()
      })
      .eq("phone", jid);

    return existing;
  }

  const envAllowed =
    CONFIG.ALLOWED_USERS
      .map(normalizeJid)
      .includes(jid);

  const { data, error } =
    await supabase
      .from("users")
      .insert({
        phone: jid,
        is_allowed: envAllowed,
        last_seen_at:
          new Date().toISOString()
      })
      .select()
      .single();

  if (error) {
    console.error(
      "Supabase create user error:",
      error.message
    );

    return null;
  }

  return data;
}


async function isAllowed(jid) {
  if (!CONFIG.WHITELIST_ONLY) {
    return true;
  }

  const user =
    await ensureUser(jid);

  if (!user) {
    return false;
  }

  const envAllowed =
    CONFIG.ALLOWED_USERS
      .map(normalizeJid)
      .includes(jid);

  return Boolean(
    user.is_allowed ||
    user.is_admin ||
    envAllowed
  );
}


/* ============================================================
   WHITELIST
============================================================ */

async function getWhitelist() {
  const { data, error } =
    await supabase
      .from("users")
      .select("phone")
      .eq("is_allowed", true);

  if (error) {
    console.error(
      "Whitelist error:",
      error.message
    );

    return [];
  }

  const databaseUsers =
    (data || []).map(x => x.phone);

  const environmentUsers =
    CONFIG.ALLOWED_USERS
      .map(normalizeJid)
      .filter(Boolean);

  return [
    ...new Set([
      ...databaseUsers,
      ...environmentUsers
    ])
  ];
}


async function addWhitelist(jid) {
  const { error } =
    await supabase
      .from("users")
      .upsert(
        {
          phone: jid,
          is_allowed: true,
          last_seen_at:
            new Date().toISOString()
        },
        {
          onConflict: "phone"
        }
      );

  return !error;
}


async function removeWhitelist(jid) {
  const { error } =
    await supabase
      .from("users")
      .update({
        is_allowed: false
      })
      .eq("phone", jid);

  return !error;
}


/* ============================================================
   MESSAGE STORAGE
============================================================ */

async function saveMessage(
  jid,
  role,
  content
) {
  const { error } =
    await supabase
      .from("messages")
      .insert({
        phone: jid,
        role,
        content
      });

  if (error) {
    console.error(
      "Message save error:",
      error.message
    );
  }
}


async function getConversation(jid) {
  const { data, error } =
    await supabase
      .from("messages")
      .select("role,content")
      .eq("phone", jid)
      .order("created_at", {
        ascending: false
      })
      .limit(20);

  if (error) {
    console.error(
      "Conversation load error:",
      error.message
    );

    return [];
  }

  return (data || [])
    .reverse()
    .filter(
      x =>
        x.content &&
        ["user", "assistant", "system"]
          .includes(x.role)
    );
}


async function clearConversation(jid) {
  const { error } =
    await supabase
      .from("messages")
      .delete()
      .eq("phone", jid);

  return !error;
}


/* ============================================================
   LOGGING
============================================================ */

async function logEvent(
  level,
  event,
  phone = null,
  details = null
) {
  const { error } =
    await supabase
      .from("bot_logs")
      .insert({
        level,
        event,
        phone,
        details
      });

  if (error) {
    console.error(
      "Log error:",
      error.message
    );
  }
}


/* ============================================================
   AI
============================================================ */

async function askAI(
  jid,
  userText
) {
  const history =
    await getConversation(jid);

  const instructions = `
You are ${CONFIG.AI_NAME}, a WhatsApp AI assistant.

Be helpful, concise and friendly.

You are running inside a WhatsApp bot.

Do not claim that you performed an action unless you actually did it.

Current user:
${jid}
`;

  const messages = [
    ...history,
    {
      role: "user",
      content: userText
    }
  ];

  const response =
    await fetch(
      CONFIG.AI_PROXY_URL,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          model:
            CONFIG.AI_MODEL,

          instructions,

          messages,

          max_output_tokens:
            CONFIG.MAX_OUTPUT_TOKENS,

          temperature:
            CONFIG.TEMPERATURE
        })
      }
    );

  let data = null;

  try {
    data =
      await response.json();
  } catch {
    throw new Error(
      `AI returned invalid JSON (${response.status})`
    );
  }

  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
      data?.message ||
      `AI request failed (${response.status})`
    );
  }

  /*
    Your Worker converts the Groq Chat Completions
    response into a Responses-style object.

    Prefer output_text.
  */

  let answer =
    data?.output_text || "";

  if (!answer && Array.isArray(data?.output)) {
    for (const item of data.output) {
      if (
        item?.type === "message" &&
        Array.isArray(item.content)
      ) {
        for (const part of item.content) {
          if (
            part?.type === "output_text" &&
            typeof part.text === "string"
          ) {
            answer += part.text;
          }
        }
      }
    }
  }

  /*
    Fallback in case the Worker returns the original
    Chat Completions response.
  */

  if (
    !answer &&
    data?.choices?.[0]?.message?.content
  ) {
    answer =
      data.choices[0].message.content;
  }

  answer = String(answer || "").trim();

  if (!answer) {
    throw new Error(
      "AI returned an empty response."
    );
  }

  return {
    text: answer,
    usage: data?.usage || null,
    model:
      data?.model ||
      CONFIG.AI_MODEL
  };
}


/* ============================================================
   ADMIN
============================================================ */

function adminAuthorized(req) {
  if (!CONFIG.ADMIN_KEY) {
    return false;
  }

  return (
    req.headers["x-admin-key"] ===
    CONFIG.ADMIN_KEY
  );
}


function sendJSON(
  res,
  code,
  data
) {
  res.writeHead(
    code,
    {
      "Content-Type":
        "application/json; charset=utf-8"
    }
  );

  res.end(
    JSON.stringify(data)
  );
}


/* ============================================================
   DASHBOARD
============================================================ */

function dashboardHTML() {
  return `<!doctype html>
<html>
<head>
<meta name="viewport"
content="width=device-width,initial-scale=1">

<title>WhatsApp AI Bot Admin</title>

<style>
body{
font-family:Arial;
margin:0;
background:#f4f6f8;
color:#222
}

main{
max-width:650px;
margin:auto;
padding:20px
}

.card{
background:#fff;
border-radius:14px;
padding:18px;
margin:12px 0;
box-shadow:0 2px 10px #0001
}

input,button{
font-size:16px;
padding:12px;
border-radius:9px;
border:1px solid #ccc;
box-sizing:border-box
}

input{
width:100%;
margin:6px 0 10px
}

button{
cursor:pointer;
background:#111;
color:#fff;
border:0;
margin:4px 2px
}

button.danger{
background:#b00020
}

.row{
display:flex;
gap:6px
}

.row input{
flex:1
}

li{
margin:9px 0;
word-break:break-all
}

small{
color:#666
}

#status{
padding:10px;
background:#eef
}
</style>
</head>

<body>
<main>

<h2>🤖 WhatsApp AI Bot Admin</h2>

<div class="card">

<b>Whitelist</b>

<p>
<small>
Add a WhatsApp number.
Example: +91 9876543210
</small>
</p>

<div class="row">
<input id="number"
placeholder="+91 9876543210">

<button onclick="addUser()">
Add
</button>
</div>

<p id="status"></p>

</div>

<div class="card">

<b>Allowed users</b>

<ul id="users">
<li>Loading...</li>
</ul>

</div>

<div class="card">

<button onclick="loadUsers()">
🔄 Refresh
</button>

<button onclick="location.href='/pair'">
📱 Pair WhatsApp
</button>

</div>

<script>

function key(){
  return localStorage.getItem("adminKey")
    || prompt("Enter ADMIN_KEY");
}

async function api(url,opt={}){
  const k=key();

  if(k)
    localStorage.setItem("adminKey",k);

  opt.headers=Object.assign(
    {},
    opt.headers,
    {"X-Admin-Key":k||""}
  );

  const r=await fetch(url,opt);
  const d=await r.json();

  if(r.status===401)
    throw Error(
      "Unauthorized. Check ADMIN_KEY."
    );

  return d;
}

async function loadUsers(){

  try{

    const d=await api(
      "/api/whitelist"
    );

    document.getElementById("users")
      .innerHTML=d.users.length

      ? d.users.map(
          u =>
            "<li>"+
            u+
            " <button class='danger' onclick='removeUser("+
            JSON.stringify(u)+
            ")'>Remove</button></li>"
        ).join("")

      : "<li>No allowed users.</li>";

    document.getElementById("status")
      .textContent =
        "Whitelist mode: "+
        d.whitelistOnly;

  }catch(e){

    document.getElementById("status")
      .textContent=e.message;

  }
}

async function addUser(){

  const n=
    document.getElementById("number")
      .value;

  try{

    const d=await api(
      "/api/whitelist",
      {
        method:"POST",

        headers:{
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            number:n
          })
      }
    );

    document.getElementById("number")
      .value="";

    document.getElementById("status")
      .textContent=d.message;

    loadUsers();

  }catch(e){

    document.getElementById("status")
      .textContent=e.message;

  }
}

async function removeUser(n){

  if(!confirm(
    "Remove "+n+
    " from whitelist?"
  ))
    return;

  try{

    const d=await api(
      "/api/whitelist",
      {
        method:"DELETE",

        headers:{
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            number:n
          })
      }
    );

    document.getElementById("status")
      .textContent=d.message;

    loadUsers();

  }catch(e){

    document.getElementById("status")
      .textContent=e.message;

  }
}

loadUsers();

</script>

</main>
</body>
</html>`;
}


/* ============================================================
   PAIR PAGE
============================================================ */

function pairHTML() {

  if (botConnected) {
    return `
<!doctype html>
<meta name="viewport"
content="width=device-width">

<div style="
font-family:Arial;
text-align:center;
padding:30px">

<h2>✅ WhatsApp Connected</h2>

<p>No QR scan needed.</p>

</div>`;
  }

  if (!latestQR) {
    return `
<!doctype html>
<meta name="viewport"
content="width=device-width">

<div style="
font-family:Arial;
text-align:center;
padding:30px">

<h2>📱 Waiting for QR...</h2>

<p>Auto-refreshing...</p>

<script>
setTimeout(
()=>location.reload(),
3000
);
</script>

</div>`;
  }

  return `
<!doctype html>

<html>

<head>

<meta name="viewport"
content="width=device-width">

<meta http-equiv="refresh"
content="4">

<title>
WhatsApp Pairing
</title>

</head>

<body style="
font-family:Arial;
text-align:center;
padding:20px;
background:#f4f4f4">

<h2>
📱 Scan with WhatsApp
</h2>

<div style="
background:#fff;
padding:15px;
display:inline-block;
border-radius:15px">

<img
style="max-width:90vw;width:400px"
src="/qr.png?t=${Date.now()}">

</div>

<p>
WhatsApp → Linked devices →
Link a device
</p>

<p>
QR automatically refreshes.
</p>

</body>
</html>`;
}


/* ============================================================
   HTTP SERVER
============================================================ */

const server =
  http.createServer(
    async (req,res) => {

      const url =
        new URL(
          req.url,
          `http://${req.headers.host || "localhost"}`
        );


      /* HEALTH */

      if (
        url.pathname ===
        "/health"
      ) {
        return sendJSON(
          res,
          200,
          {
            ok:true,
            connected:
              botConnected,
            uptime:
              process.uptime()
          }
        );
      }


      /* ROOT */

      if (
        url.pathname === "/"
      ) {
        return sendJSON(
          res,
          200,
          {
            ok:true,
            service:
              "whatsapp-ai-bot",
            dashboard:
              "/dashboard",
            pair:
              "/pair"
          }
        );
      }


      /* DASHBOARD */

      if (
        url.pathname ===
        "/dashboard"
      ) {

        if (
          !adminAuthorized(req)
        ) {
          return sendJSON(
            res,
            401,
            {
              error:
                "Unauthorized"
            }
          );
        }

        res.writeHead(
          200,
          {
            "Content-Type":
              "text/html; charset=utf-8"
          }
        );

        return res.end(
          dashboardHTML()
        );
      }


      /* WHITELIST API */

      if (
        url.pathname ===
        "/api/whitelist"
      ) {

        if (
          !adminAuthorized(req)
        ) {
          return sendJSON(
            res,
            401,
            {
              error:
                "Unauthorized"
            }
          );
        }


        if (
          req.method === "GET"
        ) {

          const users =
            await getWhitelist();

          return sendJSON(
            res,
            200,
            {
              users,
              whitelistOnly:
                CONFIG.WHITELIST_ONLY
            }
          );
        }


        let body = "";

        req.on(
          "data",
          chunk => {
            body += chunk;
          }
        );

        req.on(
          "end",
          async () => {

            try {

              const data =
                JSON.parse(
                  body || "{}"
                );

              const jid =
                normalizeJid(
                  data.number
                );

              if (!jid) {
                return sendJSON(
                  res,
                  400,
                  {
                    error:
                      "Enter a valid WhatsApp number."
                  }
                );
              }


              if (
                req.method ===
                "POST"
              ) {

                const ok =
                  await addWhitelist(
                    jid
                  );

                if (!ok) {
                  return sendJSON(
                    res,
                    500,
                    {
                      error:
                        "Could not add user."
                    }
                  );
                }

                const users =
                  await getWhitelist();

                return sendJSON(
                  res,
                  200,
                  {
                    ok:true,
                    message:
                      `Added ${jid}`,
                    users
                  }
                );
              }


              if (
                req.method ===
                "DELETE"
              ) {

                const ok =
                  await removeWhitelist(
                    jid
                  );

                if (!ok) {
                  return sendJSON(
                    res,
                    500,
                    {
                      error:
                        "Could not remove user."
                    }
                  );
                }

                const users =
                  await getWhitelist();

                return sendJSON(
                  res,
                  200,
                  {
                    ok:true,
                    message:
                      `Removed ${jid}`,
                    users
                  }
                );
              }


              return sendJSON(
                res,
                405,
                {
                  error:
                    "Method not allowed"
                }
              );

            } catch {

              return sendJSON(
                res,
                400,
                {
                  error:
                    "Invalid JSON."
                }
              );
            }

          }
        );

        return;
      }


      /* PAIR */

      if (
        url.pathname ===
        "/pair"
      ) {

        res.writeHead(
          200,
          {
            "Content-Type":
              "text/html; charset=utf-8"
          }
        );

        return res.end(
          pairHTML()
        );
      }


      /* QR */

      if (
        url.pathname ===
        "/qr.png"
      ) {

        if (!latestQR) {
          res.writeHead(404);
          return res.end(
            "QR not ready"
          );
        }

        try {

          const png =
            await QRCode.toBuffer(
              latestQR,
              {
                width:500,
                margin:2
              }
            );

          res.writeHead(
            200,
            {
              "Content-Type":
                "image/png",

              "Cache-Control":
                "no-store"
            }
          );

          return res.end(
            png
          );

        } catch {

          res.writeHead(500);

          return res.end(
            "QR error"
          );
        }
      }


      res.writeHead(404);

      res.end(
        "Not found"
      );

    }
  );


server.listen(
  CONFIG.PORT,
  "0.0.0.0",
  () => {

    console.log(
      `🌐 HTTP server listening on ${CONFIG.PORT}`
    );

  }
);


/* ============================================================
   START WHATSAPP
============================================================ */

async function startBot() {

  const {
    state,
    saveCreds
  } =
    await useMultiFileAuthState(
      CONFIG.SESSION_DIR
    );


  sock =
    makeWASocket({
      auth:state,

      logger,

      browser:[
        "Online AI Bot",
        "Chrome",
        "1.0.0"
      ],

      syncFullHistory:false
    });


  sock.ev.on(
    "creds.update",
    saveCreds
  );


  sock.ev.on(
    "connection.update",
    async ({
      connection,
      lastDisconnect,
      qr
    }) => {

      if (qr) {

        latestQR=qr;
        botConnected=false;

        console.log(
          "📱 New QR generated"
        );
      }


      if (
        connection ===
        "open"
      ) {

        botConnected=true;
        latestQR=null;

        console.log(
          "✅ WhatsApp connected"
        );

        await logEvent(
          "info",
          "whatsapp_connected"
        );
      }


      if (
        connection ===
        "close"
      ) {

        botConnected=false;

        const code =
          new Boom(
            lastDisconnect?.error
          )
            ?.output
            ?.statusCode;


        await logEvent(
          "warn",
          "whatsapp_disconnected",
          null,
          {
            code
          }
        );


        if (
          code !==
            DisconnectReason.loggedOut &&
          !reconnecting
        ) {

          reconnecting=true;

          setTimeout(
            () => {

              reconnecting=false;

              startBot()
                .catch(
                  console.error
                );

            },
            3000
          );
        }
      }

    }
  );


  /* ==========================================================
     MESSAGES
  ========================================================== */

  sock.ev.on(
    "messages.upsert",
    async ({
      messages
    }) => {

      try {

        const msg =
          messages?.[0];

        if (
          !msg ||
          msg.key.fromMe
        ) {
          return;
        }


        const jid =
          msg.key.remoteJid;


        if (
          !jid ||
          jid.endsWith("@g.us")
        ) {
          return;
        }


        const text =
          (
            msg.message
              ?.conversation ||

            msg.message
              ?.extendedTextMessage
              ?.text ||

            ""
          ).trim();


        if (!text) {
          return;
        }


        /* START */

        if (
          /^start$/i.test(
            text
          )
        ) {

          await addWhitelist(
            jid
          );

          await sock.sendMessage(
            jid,
            {
              text:
                "✅ You are opted in again."
            }
          );

          return;
        }


        /* STOP */

        if (
          /^stop$/i.test(
            text
          )
        ) {

          await removeWhitelist(
            jid
          );

          await sock.sendMessage(
            jid,
            {
              text:
                "🛑 Opt-out received. You will no longer receive bot replies."
            }
          );

          return;
        }


        /* CHECK ACCESS */

        if (
          !(await isAllowed(jid))
        ) {

          console.log(
            `🚫 Whitelist blocked: ${jid}`
          );

          return;
        }


        /* CLEAR */

        if (
          /^\/clear$/i.test(
            text
          )
        ) {

          await clearConversation(
            jid
          );

          await sock.sendMessage(
            jid,
            {
              text:
                "🧹 Conversation history cleared."
            }
          );

          return;
        }


        /* HELP */

        if (
          /^\/help$/i.test(
            text
          )
        ) {

          await sock.sendMessage(
            jid,
            {
              text:
`🤖 ${CONFIG.AI_NAME}

Commands:

/help
/clear
/start
/stop

Send any normal message to chat with the AI.`
            }
          );

          return;
        }


        /* SAVE USER MESSAGE */

        await saveMessage(
          jid,
          "user",
          text
        );


        /* TYPING */

        try {
          await sock.sendPresenceUpdate(
            "composing",
            jid
          );
        } catch {}


        /* AI */

        let result;

        try {

          result =
            await askAI(
              jid,
              text
            );

        } catch (error) {

          console.error(
            "AI error:",
            error
          );

          await logEvent(
            "error",
            "ai_request_failed",
            jid,
            {
              message:
                error.message
            }
          );

          await sock.sendMessage(
            jid,
            {
              text:
                "⚠️ Sorry, the AI is temporarily unavailable. Please try again."
            }
          );

          return;
        }


        /* SAVE AI RESPONSE */

        await saveMessage(
          jid,
          "assistant",
          result.text
        );


        /* STOP TYPING */

        try {
          await sock.sendPresenceUpdate(
            "paused",
            jid
          );
        } catch {}


        /* SEND */

        await sock.sendMessage(
          jid,
          {
            text:
              result.text
          }
        );


        await logEvent(
          "info",
          "ai_message",
          jid,
          {
            model:
              result.model,
            usage:
              result.usage
          }
        );

      } catch (error) {

        console.error(
          "Message handler error:",
          error
        );

      }

    }
  );
}


startBot()
  .catch(error => {

    console.error(
      "Fatal:",
      error
    );

    process.exit(1);

  });
