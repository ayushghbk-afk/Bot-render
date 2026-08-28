# 🤖 WhatsApp AI Bot & Media Downloader

An intelligent WhatsApp bot built with **Baileys (`@whiskeysockets/baileys`)**, powered by an AI proxy endpoint, Supabase for chat history & logging, document reading (PDF/DOCX/TXT), Sightengine image analysis, and YouTube video/audio downloaders. Includes a web dashboard and QR pairing interface.

---

## 🚀 Features

- 💬 **AI Conversational Assistant**: Context-aware conversations with persistent Supabase chat history.
- 📹 **YouTube Downloader**:
  - Download MP4 Video: `.ytmp4 <YouTube-URL>`
  - Download MP3 Audio: `.ytmp3 <YouTube-URL>`
- 🖼️ **Image Recognition / Analysis**: Send an image with a prompt or question.
- 📄 **Document Reader**: Upload PDF, Word (`.docx`), TXT, JSON, or CSV documents for automatic AI summarization.
- 📊 **Web Dashboard & QR Pairing**:
  - Web UI at `/dashboard` to view bot status.
  - Interactive QR scanner page at `/pair` for easy device linking.
- 🛡️ **Rate Limiting & Queueing**: Per-user queueing and request throttling to prevent bans and spam.

---

## 📋 Prerequisites

1. **Node.js**: Version `18.0.0` or higher.
2. **Supabase Account**: Free account at [supabase.com](https://supabase.com).
3. **WhatsApp Account**: Active WhatsApp on your mobile phone to scan the pairing QR code.
4. **Sightengine Account** *(Optional)*: Free account at [sightengine.com](https://sightengine.com) for image analysis.

---

## 🛠️ Step 1: Set Up Supabase Database

Create a new project on [Supabase](https://supabase.com). Go to the **SQL Editor** in your Supabase dashboard and run the following SQL script:

```sql
-- 1. Create bot_logs table
CREATE TABLE IF NOT EXISTS bot_logs (
  id BIGSERIAL PRIMARY KEY,
  jid TEXT NOT NULL,
  direction TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Create bot_messages table (for conversation memory)
CREATE TABLE IF NOT EXISTS bot_messages (
  id BIGSERIAL PRIMARY KEY,
  jid TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Create indices for faster history lookups
CREATE INDEX IF NOT EXISTS idx_bot_messages_jid_created ON bot_messages(jid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_logs_jid ON bot_logs(jid);
```

Get your **Project URL** and **API Key (service_role or anon key)**:
- Navigate to **Project Settings** ➔ **API**.
- Copy the **Project URL** (`SUPABASE_URL`) and **Service Role / Anon Key** (`SUPABASE_SECRET_KEY`).

---

## 💻 Step 2: Local Installation & Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/ayushghbk-afk/Bot-render.git
   cd Bot-render
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure environment variables:**
   Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
   Open `.env` and fill in your Supabase details:
   ```env
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_SECRET_KEY=your-supabase-key
   PORT=3000
   AI_NAME=Ayush AI
   ```

4. **Start the bot:**
   ```bash
   npm start
   ```

5. **Link WhatsApp:**
   - Open your browser at `http://localhost:3000/pair` (or `http://localhost:3000/dashboard`).
   - Open WhatsApp on your phone: **Settings** ➔ **Linked Devices** ➔ **Link a Device**.
   - Scan the QR code displayed on the screen.
   - Once connected, the page will confirm connection status.

---

## ☁️ Step 3: Deployment on Render.com

1. Push your code to GitHub.
2. Sign in to [Render.com](https://render.com) and click **New +** ➔ **Web Service**.
3. Connect your GitHub repository.
4. Fill in the service configuration:
   - **Name**: `whatsapp-ai-bot`
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: `Free` (or `Starter` if adding persistent disk)
5. Under **Environment Variables**, add:
   - `SUPABASE_URL`: `https://your-project.supabase.co`
   - `SUPABASE_SECRET_KEY`: `your-supabase-secret-key`
   - `AI_PROXY_URL`: `https://groq-proxy.mr-hackerdon808.workers.dev/` (or your custom proxy)
   - `AI_MODEL`: `openai/gpt-oss-120b`
   - `AI_NAME`: `Ayush AI`
   - *(Optional)* `SIGHTENGINE_API_USER`: `your_user_id`
   - *(Optional)* `SIGHTENGINE_API_SECRET`: `your_secret_key`
6. Click **Create Web Service**.
7. Once deployed, open `https://<your-render-app-name>.onrender.com/pair` and scan the QR code using WhatsApp.

> 💡 **Tip for Render**: On the Render free tier, web services spin down after inactivity and disk storage is ephemeral. For 24/7 uptime without needing to re-scan QR codes upon restart, consider attaching a Render Persistent Disk mounted at `/home/user/auth_session` or running on a VPS.

---

## 🖥️ Step 4: Deployment on VPS (Ubuntu / Debian with PM2)

1. **Install Node.js 18+ and Git:**
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
   sudo apt-get install -y nodejs git
   ```

2. **Install PM2 globally:**
   ```bash
   sudo npm install -g pm2
   ```

3. **Clone and setup repository:**
   ```bash
   git clone https://github.com/ayushghbk-afk/Bot-render.git
   cd Bot-render
   npm install
   nano .env # Add your SUPABASE_URL and SUPABASE_SECRET_KEY
   ```

4. **Start the application with PM2:**
   ```bash
   pm2 start index.js --name "whatsapp-bot"
   pm2 save
   pm2 startup
   ```

5. Access `http://YOUR_SERVER_IP:3000/pair` to scan the QR code.

---

## 📱 Bot Commands & Usage

| Command / Action | Description | Example |
| :--- | :--- | :--- |
| **Direct Message** | Chat naturally with the AI bot | `Explain quantum computing in simple terms` |
| `.ytmp4 <URL>` | Download YouTube video (MP4) | `.ytmp4 https://youtu.be/dQw4w9WgXcQ` |
| `.ytmp3 <URL>` | Download YouTube audio (MP3) | `.ytmp3 https://youtu.be/dQw4w9WgXcQ` |
| **Send Image** | Ask questions or analyze images | Send photo + caption: `What is this?` |
| **Send Document** | Analyze or summarize PDF/Word/TXT | Upload a PDF or `.docx` file |
| `help` or `.help` | Show command list | `.help` |
| `clear` or `.clear` | Clear AI conversation history | `clear` |

---

## 🌐 Web Endpoints

- `/` - API health and links overview JSON.
- `/dashboard` - Status monitor & quick actions dashboard.
- `/pair` - Interactive QR code pairing screen for WhatsApp.
- `/health` - Health check JSON (`{ ok: true, connected: boolean, uptime: number }`).
- `/qr.png` - Raw PNG image of the pairing QR code.
