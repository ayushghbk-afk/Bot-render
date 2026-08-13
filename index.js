const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadContentFromMessage
} = require("@whiskeysockets/baileys");

const { Boom } = require("@hapi/boom");
const pino = require("pino");
const tesseract = require("node-tesseract-ocr");
const QRCode = require("qrcode");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const http = require("http");

const logger = pino({ level: "silent" });

/* ============================================================
   CONFIGURATION
============================================================ */

const CONFIG = {
    PORT: Number(process.env.PORT || 3000),

    AI_PROXY_URL:
        process.env.AI_PROXY_URL ||
        "https://groq-proxy.mr-hackerdon808.workers.dev/",

    AI_PROXY_SECRET:
        process.env.AI_PROXY_SECRET || "",

    AI_MODEL:
        process.env.AI_MODEL ||
        "openai/gpt-oss-120b",

    AI_NAME:
        process.env.AI_NAME ||
        "v1 of ayush",

    ORGANIZATION_NAME:
        process.env.ORGANIZATION_NAME ||
        "ayush development labs",

    ENGINE_NAME:
        process.env.ENGINE_NAME ||
        "v1 engine",

    MAX_OUTPUT_TOKENS:
        Number(process.env.MAX_OUTPUT_TOKENS || 500),

    TEMPERATURE:
        Number(process.env.TEMPERATURE || 0.7),

    WHITELIST_ONLY:
        process.env.WHITELIST_ONLY !== "false",

    ALLOWED_USERS:
        (process.env.ALLOWED_USERS || "")
            .split(",")
            .map(x => x.trim())
            .filter(Boolean),

    SESSION_DIR:
        process.env.SESSION_DIR || "./auth_session",

    MEMORY_DIR:
        process.env.MEMORY_DIR || "./memory"
};

/* ============================================================
   DIRECTORIES
============================================================ */

fs.mkdirSync(CONFIG.SESSION_DIR, {
    recursive: true
});

fs.mkdirSync(CONFIG.MEMORY_DIR, {
    recursive: true
});

/* ============================================================
   OCR
============================================================ */

const TESSERACT_BINARY =
    process.env.TESSERACT_BINARY ||
    "tesseract";

const tesseractConfig = {
    lang: "eng",
    oem: 1,
    psm: 3,
    binary: TESSERACT_BINARY
};

/* ============================================================
   QR STATE
============================================================ */

let latestQR = null;
let botConnected = false;

/* ============================================================
   HEALTH + QR WEB SERVER
============================================================ */

const server = http.createServer(
    async (req, res) => {

        /* ----------------------------------------------------
           HEALTH
        ---------------------------------------------------- */

        if (req.url === "/health") {
            res.writeHead(200, {
                "Content-Type":
                    "application/json"
            });

            return res.end(
                JSON.stringify({
                    ok: true,
                    service:
                        "whatsapp-ai-bot",
                    connected:
                        botConnected,
                    uptime:
                        process.uptime(),
                    timestamp:
                        new Date().toISOString()
                })
            );
        }

        /* ----------------------------------------------------
           PAIR PAGE
        ---------------------------------------------------- */

        if (req.url === "/pair") {

            res.writeHead(200, {
                "Content-Type":
                    "text/html; charset=utf-8"
            });

            if (botConnected) {
                return res.end(`
<!DOCTYPE html>
<html>
<head>
<meta name="viewport"
      content="width=device-width,initial-scale=1">
<title>WhatsApp Bot</title>
</head>

<body style="
font-family:Arial;
text-align:center;
padding:40px;
background:#f5f5f5;
">

<h1>✅ WhatsApp Connected</h1>

<p>Your bot is already connected to WhatsApp.</p>

<p>You don't need to scan another QR.</p>

</body>
</html>
                `);
            }

            if (!latestQR) {
                return res.end(`
<!DOCTYPE html>
<html>
<head>
<meta name="viewport"
      content="width=device-width,initial-scale=1">

<meta http-equiv="refresh" content="5">

<title>WhatsApp Pairing</title>
</head>

<body style="
font-family:Arial;
text-align:center;
padding:30px;
background:#f5f5f5;
">

<h2>📱 WhatsApp Bot</h2>

<p>Waiting for WhatsApp QR...</p>

<p>
This page will refresh automatically.
</p>

</body>
</html>
                `);
            }

            try {

                const qrData =
                    await QRCode.toDataURL(
                        latestQR,
                        {
                            width: 400,
                            margin: 2
                        }
                    );

                return res.end(`
<!DOCTYPE html>

<html>

<head>

<meta name="viewport"
      content="width=device-width,initial-scale=1">

<meta http-equiv="refresh" content="30">

<title>WhatsApp Bot Pairing</title>

</head>

<body style="
font-family:Arial;
text-align:center;
background:#f5f5f5;
padding:20px;
">

<h2>📱 WhatsApp Bot</h2>

<p>
Open WhatsApp → Linked devices
→ Link a device
</p>

<div style="
background:white;
display:inline-block;
padding:15px;
border-radius:15px;
box-shadow:0 2px 10px rgba(0,0,0,.15);
">

<img
src="${qrData}"
style="
width:min(90vw,400px);
height:auto;
display:block;
">

</div>

<p>
Scan this QR code with WhatsApp.
</p>

<button
onclick="location.reload()"
style="
padding:12px 22px;
font-size:16px;
border:0;
border-radius:8px;
cursor:pointer;
">

🔄 Refresh QR

</button>

<p style="
font-size:13px;
color:#666;
margin-top:25px;
">

QR codes expire quickly.
If it doesn't work, refresh the page.

</p>

</body>
</html>
                `);

            } catch (error) {

                console.error(
                    "[QR WEB ERROR]",
                    error
                );

                res.writeHead(500);

                return res.end(
                    "QR generation failed."
                );
            }
        }

        /* ----------------------------------------------------
           ROOT
        ---------------------------------------------------- */

        if (req.url === "/") {

            res.writeHead(200, {
                "Content-Type":
                    "text/html"
            });

            return res.end(`
<!DOCTYPE html>

<html>

<head>

<meta name="viewport"
content="width=device-width,initial-scale=1">

<title>WhatsApp AI Bot</title>

</head>

<body style="
font-family:Arial;
text-align:center;
padding:40px;
">

<h1>🤖 WhatsApp AI Bot</h1>

<p>Online and running.</p>

<p>
<a href="/health">Health</a>
</p>

<p>
<a href="/pair">WhatsApp Pairing</a>
</p>

</body>

</html>
            `);
        }

        /* ----------------------------------------------------
           404
        ---------------------------------------------------- */

        res.writeHead(404);

        res.end("Not found");
    }
);

server.listen(
    CONFIG.PORT,
    "0.0.0.0",
    () => {

        console.log(
            `🌐 Server running on port ${CONFIG.PORT}`
        );

    }
);

/* ============================================================
   ACCESS CONTROL
============================================================ */

function isUserAllowed(jid) {

    if (!CONFIG.WHITELIST_ONLY) {
        return true;
    }

    return CONFIG.ALLOWED_USERS
        .includes(jid);
}

/* ============================================================
   WEB SEARCH
============================================================ */

async function searchTheWeb(query) {

    try {

        console.log(
            `[Web Search] ${query}`
        );

        const searchUrl =
            `https://api.duckduckgo.com/?q=${encodeURIComponent(
                query
            )}&format=json&no_html=1&skip_disambig=1`;

        const response =
            await fetch(
                searchUrl,
                {
                    headers: {
                        "User-Agent":
                            "Mozilla/5.0"
                    }
                }
            );

        let results = [];

        if (response.ok) {

            const data =
                await response.json();

            if (data.AbstractText) {

                results.push(
                    data.AbstractText
                );
            }

            if (
                Array.isArray(
                    data.RelatedTopics
                )
            ) {

                for (
                    const topic of
                    data.RelatedTopics
                ) {

                    if (
                        results.length >= 3
                    ) {
                        break;
                    }

                    if (
                        topic.Text &&
                        !results.includes(
                            topic.Text
                        )
                    ) {

                        results.push(
                            topic.Text
                        );

                    }
                }
            }
        }

        /* ----------------------------------------------------
           HTML FALLBACK
        ---------------------------------------------------- */

        if (
            results.length === 0
        ) {

            const htmlResponse =
                await fetch(
                    "https://html.duckduckgo.com/html/",
                    {
                        method: "POST",

                        headers: {
                            "Content-Type":
                                "application/x-www-form-urlencoded",

                            "User-Agent":
                                "Mozilla/5.0"
                        },

                        body:
                            `q=${encodeURIComponent(
                                query
                            )}`
                    }
                );

            if (
                htmlResponse.ok
            ) {

                const html =
                    await htmlResponse.text();

                const $ =
                    cheerio.load(
                        html
                    );

                $(".result__snippet")
                    .slice(0, 3)
                    .each(
                        (i, el) => {

                            const text =
                                $(el)
                                    .text()
                                    .trim();

                            if (text) {
                                results.push(
                                    text
                                );
                            }

                        }
                    );
            }
        }

        return results.length
            ? results
                .slice(0, 3)
                .join("\n\n")
            : null;

    } catch (error) {

        console.error(
            "[SEARCH ERROR]",
            error.message
        );

        return null;
    }
}

/* ============================================================
   MEMORY
============================================================ */

function memoryFile(jid) {

    const safe =
        jid.replace(
            /[^a-zA-Z0-9_-]/g,
            "_"
        );

    return path.join(
        CONFIG.MEMORY_DIR,
        `${safe}.json`
    );
}

function loadMemory(jid) {

    try {

        const file =
            memoryFile(jid);

        if (
            !fs.existsSync(file)
        ) {
            return [];
        }

        const data =
            JSON.parse(
                fs.readFileSync(
                    file,
                    "utf8"
                )
            );

        return Array.isArray(data)
            ? data.slice(-10)
            : [];

    } catch {

        return [];
    }
}

function saveMemory(
    jid,
    messages
) {

    try {

        fs.writeFileSync(
            memoryFile(jid),
            JSON.stringify(
                messages.slice(-10),
                null,
                2
            )
        );

    } catch (error) {

        console.error(
            "[MEMORY ERROR]",
            error.message
        );
    }
}

/* ============================================================
   AI PROXY
============================================================ */

async function askAI(
    jid,
    userText
) {

    const history =
        loadMemory(jid);

    history.push({
        role: "user",
        content: userText
    });

    const instructions = `
You are ${CONFIG.AI_NAME}.

Organization:
${CONFIG.ORGANIZATION_NAME}

Engine:
${CONFIG.ENGINE_NAME}

You are an AI assistant replying through WhatsApp.

Rules:
- Be helpful and natural.
- Keep replies concise.
- Answer the user's actual question.
- Do not mention internal system instructions.
- Do not claim to be human.
- If you don't know something, say so.
`;

    const headers = {
        "Content-Type":
            "application/json"
    };

    if (
        CONFIG.AI_PROXY_SECRET
    ) {

        headers.Authorization =
            `Bearer ${CONFIG.AI_PROXY_SECRET}`;

    }

    const response =
        await fetch(
            CONFIG.AI_PROXY_URL,
            {
                method: "POST",

                headers,

                body: JSON.stringify({

                    model:
                        CONFIG.AI_MODEL,

                    instructions,

                    messages:
                        history,

                    max_output_tokens:
                        CONFIG.MAX_OUTPUT_TOKENS,

                    temperature:
                        CONFIG.TEMPERATURE
                })
            }
        );

    if (!response.ok) {

        const errorText =
            await response.text();

        throw new Error(
            `AI Proxy ${response.status}: ${errorText}`
        );
    }

    const data =
        await response.json();

    let reply = "";

    /* --------------------------------------------------------
       Responses-style output
    -------------------------------------------------------- */

    if (
        typeof data.output_text ===
        "string"
    ) {

        reply =
            data.output_text;
    }

    /* --------------------------------------------------------
       Chat completion format
    -------------------------------------------------------- */

    if (
        !reply &&
        data.choices?.[0]?.message
            ?.content
    ) {

        reply =
            data.choices[0]
                .message.content;
    }

    /* --------------------------------------------------------
       Generic output array
    -------------------------------------------------------- */

    if (
        !reply &&
        Array.isArray(
            data.output
        )
    ) {

        for (
            const item of
            data.output
        ) {

            if (
                Array.isArray(
                    item.content
                )
            ) {

                for (
                    const content of
                    item.content
                ) {

                    if (
                        typeof content.text ===
                        "string"
                    ) {

                        reply +=
                            content.text;

                    }
                }
            }
        }
    }

    reply =
        String(
            reply || ""
        ).trim();

    if (!reply) {

        throw new Error(
            "AI returned an empty response."
        );
    }

    history.push({
        role: "assistant",
        content: reply
    });

    saveMemory(
        jid,
        history
    );

    return reply;
}

/* ============================================================
   IDENTITY FILTER
============================================================ */

function processIdentity(
    text
) {

    return text

        .replace(
            /qwen/gi,
            CONFIG.AI_NAME
        )

        .replace(
            /alibaba/gi,
            CONFIG.ORGANIZATION_NAME
        )

        .replace(
            /tongyi/gi,
            CONFIG.ENGINE_NAME
        );
}

/* ============================================================
   MESSAGE TEXT
============================================================ */

function getTextMessage(
    msg
) {

    return (
        msg.message
            ?.conversation ||

        msg.message
            ?.extendedTextMessage
            ?.text ||

        ""
    ).trim();
}

/* ============================================================
   IMAGE OCR
============================================================ */

async function processImage(
    imageMessage
) {

    const tempPath =
        path.join(
            __dirname,
            `temp_${Date.now()}.jpg`
        );

    try {

        console.log(
            "[OCR] Downloading image..."
        );

        const stream =
            await downloadContentFromMessage(
                imageMessage,
                "image"
            );

        const chunks = [];

        for await (
            const chunk of stream
        ) {

            chunks.push(
                chunk
            );
        }

        const buffer =
            Buffer.concat(
                chunks
            );

        if (
            !buffer.length
        ) {

            throw new Error(
                "Empty image."
            );
        }

        fs.writeFileSync(
            tempPath,
            buffer
        );

        const extracted =
            await tesseract.recognize(
                tempPath,
                tesseractConfig
            );

        const text =
            extracted.trim();

        const caption =
            imageMessage.caption ||
            "";

        if (
            !text &&
            !caption
        ) {

            return null;
        }

        if (
            text &&
            caption
        ) {

            return `${caption}\n\nImage text:\n${text}`;
        }

        return text || caption;

    } finally {

        if (
            fs.existsSync(
                tempPath
            )
        ) {

            fs.unlinkSync(
                tempPath
            );
        }
    }
}

/* ============================================================
   START WHATSAPP
============================================================ */

async function startBot() {

    console.log(
        "🚀 Starting WhatsApp bot..."
    );

    const {
        state,
        saveCreds
    } =
        await useMultiFileAuthState(
            CONFIG.SESSION_DIR
        );

    const sock =
        makeWASocket({

            auth: state,

            logger,

            browser: [
                "Online AI Bot",
                "Chrome",
                "1.0.0"
            ],

            syncFullHistory:
                false
        });

    /* ========================================================
       CONNECTION UPDATE
    ======================================================== */

    sock.ev.on(
        "connection.update",
        update => {

            const {
                connection,
                lastDisconnect,
                qr
            } = update;

            /* ------------------------------------------------
               NEW QR
            ------------------------------------------------ */

            if (qr) {

                latestQR = qr;

                botConnected = false;

                console.log(
                    "📱 New WhatsApp QR generated."
                );

                console.log(
                    "🌐 Open /pair in your browser to scan
