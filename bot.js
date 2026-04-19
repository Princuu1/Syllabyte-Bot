require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const qrcode = require('qrcode-terminal');
const { Client, MessageMedia, LocalAuth } = require('whatsapp-web.js');

const { getSubjects, getFiles, searchFile, getPublicUrl } = require('./supabase');

// ─────────────────────────────────────────────────────────────────────
// Health server
// ─────────────────────────────────────────────────────────────────────
const app = express();

app.get('/', (_req, res) => {
  res.send('✅ Syllabyte bot is running!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 HTTP server listening on port ${PORT}`);
});

// ─────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────
const TRIGGER = (process.env.TRIGGER_WORD || 'syllabyte').toLowerCase().trim();

const ALLOWED = (process.env.ALLOWED_CHAT_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const isRender = !!process.env.RENDER;
const AUTH_PATH = isRender
  ? '/opt/render/project/src/.wwebjs_auth'
  : path.join(process.cwd(), '.wwebjs_auth');

const CHROME_PATH =
  process.env.CHROME_PATH ||
  '/opt/render/.cache/puppeteer/chrome/linux-146.0.7680.153/chrome-linux64/chrome';

console.log(`🖥️ Running on: ${isRender ? 'Render' : 'Local'}`);
if (isRender) console.log(`🔍 Using Chrome at: ${CHROME_PATH}`);
console.log(`🔐 Auth path: ${AUTH_PATH}`);

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Optional manual reset only if you explicitly set RESET_WA_SESSION=true
if (process.env.RESET_WA_SESSION === 'true') {
  try {
    if (fs.existsSync(AUTH_PATH)) {
      fs.rmSync(AUTH_PATH, { recursive: true, force: true });
      console.log('🧹 Removed existing WhatsApp auth session.');
    }
  } catch (err) {
    console.warn('⚠️ Could not clear auth session:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────
// WhatsApp client
// ─────────────────────────────────────────────────────────────────────
let printedQrOnce = false;
let reconnecting = false;

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: AUTH_PATH,
  }),
  puppeteer: {
    headless: true,
    executablePath: isRender ? CHROME_PATH : undefined,
    protocolTimeout: 180000,
    timeout: 180000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--single-process',
      '--disable-extensions',
    ],
  },
  takeoverOnConflict: true,
  takeoverTimeoutMs: 0,
  restartOnAuthFail: true,
});

process.setMaxListeners(0);

// ─────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────
client.on('qr', (qr) => {
  if (printedQrOnce) return;
  printedQrOnce = true;

  console.log('\n📱 Scan this QR once from the logs right now:\n');
  qrcode.generate(qr, { small: true });
  console.log('\n⏱️ If scan fails, restart the app and use the new QR.\n');
});

client.on('authenticated', () => {
  console.log('🔐 WhatsApp authenticated.');
});

client.on('ready', () => {
  console.log('✅ Bot Ready');
});

client.on('auth_failure', (msg) => {
  console.error('❌ Auth failed:', msg);
});

client.on('disconnected', async (reason) => {
  console.warn('⚠️ Bot disconnected:', reason);

  if (reconnecting) return;
  reconnecting = true;

  try {
    await client.destroy();
  } catch {}

  setTimeout(() => {
    client.initialize()
      .catch((err) => console.error('❌ Re-init failed:', err))
      .finally(() => {
        reconnecting = false;
      });
  }, 5000);
});

// ─────────────────────────────────────────────────────────────────────
// Gemini helpers
// ─────────────────────────────────────────────────────────────────────
let cachedModels = null;

async function listModels() {
  const url = `${GEMINI_BASE}/models?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const res = await axios.get(url);
  return Array.isArray(res.data?.models) ? res.data.models : [];
}

async function getModelCandidates() {
  if (cachedModels) return cachedModels;

  const models = await listModels();
  const supported = models
    .filter(
      (m) =>
        Array.isArray(m.supportedGenerationMethods) &&
        m.supportedGenerationMethods.includes('generateContent')
    )
    .map((m) => m.name.replace(/^models\//, ''));

  const preferred = [
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.5-pro',
    'gemini-3-flash-preview',
  ];

  cachedModels = [
    ...preferred.filter((m) => supported.includes(m)),
    ...supported.filter((m) => !preferred.includes(m)),
  ];

  cachedModels = [...new Set(cachedModels)];

  if (!cachedModels.length) {
    throw new Error('No Gemini model with generateContent is available for this API key.');
  }

  return cachedModels;
}

async function geminiGenerate(prompt, jsonMode = false) {
  const models = await getModelCandidates();
  let lastErr = null;

  for (const model of models.slice(0, 4)) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const url = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
        const body = {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: jsonMode
            ? { temperature: 0, responseMimeType: 'application/json' }
            : { temperature: 0.5 },
        };

        const res = await axios.post(url, body, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000,
        });

        const text =
          res.data?.candidates?.[0]?.content?.parts
            ?.map((p) => p.text || '')
            .join('') || '';

        return text;
      } catch (err) {
        lastErr = err;
        const status = err?.response?.status;

        if (status === 503 || status === 429) {
          await sleep(400 * Math.pow(2, attempt - 1));
          continue;
        }

        break;
      }
    }
  }

  throw lastErr || new Error('Gemini request failed');
}

function parseJsonSafe(text) {
  const cleaned = String(text || '').replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

async function analyze(msg) {
  const prompt = `
You are an intelligent AI assistant for a WhatsApp study bot.

Return ONLY valid JSON in this exact format:

{
  "intent": "subjects" | "subject_files" | "file" | "chat" | "unknown",
  "subject": "",
  "query": "",
  "type": "",
  "unit": ""
}

Rules:
- "subjects" means the user wants the list of subjects/buckets.
- "subject_files" means the user wants all files inside one subject/bucket.
- "file" means the user wants one specific PDF.
- "chat" means the user is chatting normally.
- "unknown" means you cannot understand.

Important:
- subject must be lowercase if present.
- query should be the cleaned request.
- type must be one of: notes, pyq, lab, assignment, other.
- unit must be a plain number string only, like "1", "2", "3", "4", "5".

Treat unit and module as the same thing:
- unit 1, unit-i, unit one, 1st unit, first unit => "1"
- unit 2, unit-ii, unit two, 2nd unit, second unit => "2"
- unit 3, unit-iii, unit three, 3rd unit, third unit => "3"

Also:
- module 1, module-i, module one, 1st module, first module => "1"
- module 2, module-ii, module two, 2nd module, second module => "2"
- module 3, module-iii, module three, 3rd module, third module => "3"
- module 4, module-iv => "4"
- module 5, module-v => "5"

Understand:
- pyq, previous year, question paper => type = "pyq"
- lab, practical, record => type = "lab"
- notes, study material => type = "notes"

Do not explain anything.
Do not add markdown.
Return JSON only.

Message:
${JSON.stringify(msg)}
`.trim();

  const raw = await geminiGenerate(prompt, true);
  return parseJsonSafe(raw);
}

async function chatReply(context) {
  const prompt = `
You are Syllabyte, a helpful WhatsApp study bot.

Write a short, friendly reply.
Keep it human, natural, and concise.

Context:
- reason: ${context.reason}
- user_message: ${context.userMessage}
- subject: ${context.subject || 'none'}
- available_subjects: ${context.availableSubjects.join(', ') || 'none'}

Rules:
- If a file was not found, say that clearly and suggest a better query.
- If a subject bucket is empty, say that the bucket is empty.
- If the user is chatting casually, answer normally and politely.
- If the user asks for subjects, list the available subjects.
`.trim();

  return geminiGenerate(prompt, false);
}

async function sendPdf(message, result) {
  const url = getPublicUrl(result.subject, result.file);

  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30000,
  });

  const media = new MessageMedia(
    'application/pdf',
    Buffer.from(res.data).toString('base64'),
    result.file
  );

  await message.react('✅');
  return message.reply(media);
}

// ─────────────────────────────────────────────────────────────────────
// Message handling
// ─────────────────────────────────────────────────────────────────────
client.on('message', async (message) => {
  if (!ALLOWED.includes(message.from)) return;

  let msg = message.body.trim();

  try {
    if (!msg.toLowerCase().startsWith(TRIGGER)) return;

    const triggerRegex = new RegExp(`^${escapeRegex(TRIGGER)}`, 'i');
    msg = msg.replace(triggerRegex, '').trim();

    if (!msg) {
      return message.reply(
        '👋 Ask me like:\n• syllabyte beee module 5\n• syllabyte beee pyq\n• syllabyte show subjects'
      );
    }

    await message.react('👀');
    await sleep(200);
    await message.react('⏳');

    const ai = await analyze(msg);
    const subjects = getSubjects();

    if (!ai) {
      await message.react('❌');
      return message.reply(
        await chatReply({
          reason: 'unknown',
          userMessage: msg,
          availableSubjects: subjects,
        })
      );
    }

    if (ai.intent === 'subjects') {
      if (!subjects.length) {
        await message.react('❌');
        return message.reply(
          await chatReply({
            reason: 'no_subjects',
            userMessage: msg,
            availableSubjects: subjects,
          })
        );
      }

      await message.react('✅');
      return message.reply(`📚 Subjects:\n\n${subjects.map((s) => `• ${s}`).join('\n')}`);
    }

    if (ai.intent === 'subject_files') {
      const subject = ai.subject;

      if (!subject || !subjects.includes(subject)) {
        await message.react('❌');
        return message.reply(
          await chatReply({
            reason: 'subject_not_found',
            userMessage: msg,
            subject,
            availableSubjects: subjects,
          })
        );
      }

      const files = await getFiles(subject);

      if (!files.length) {
        await message.react('❌');
        return message.reply(
          await chatReply({
            reason: 'bucket_empty',
            userMessage: msg,
            subject,
            availableSubjects: subjects,
          })
        );
      }

      let text = `📚 *${subject.toUpperCase()} FILES*\n\n`;
      files.forEach((f, i) => {
        text += `${i + 1}. ${f.name.replace(/\.pdf$/i, '')}\n`;
      });

      await message.react('✅');
      return message.reply(text);
    }

    if (ai.intent === 'file') {
      const result = await searchFile(msg, {
        subject: ai.subject,
        unit: ai.unit,
        type: ai.type,
        query: ai.query,
      });

      if (!result) {
        await message.react('❌');
        return message.reply(
          await chatReply({
            reason: 'file_not_found',
            userMessage: msg,
            subject: ai.subject,
            availableSubjects: subjects,
          })
        );
      }

      const filesInBucket = await getFiles(result.subject);

      if (!filesInBucket.length) {
        await message.react('❌');
        return message.reply(
          await chatReply({
            reason: 'bucket_empty',
            userMessage: msg,
            subject: result.subject,
            availableSubjects: subjects,
          })
        );
      }

      return sendPdf(message, result);
    }

    await message.react('✅');
    return message.reply(
      await chatReply({
        reason: 'chat',
        userMessage: msg,
        availableSubjects: subjects,
      })
    );
  } catch (err) {
    console.error(err);
    try {
      await message.react('❌');
    } catch {}
    return message.reply('❌ Error occurred.');
  }
});

// ─────────────────────────────────────────────────────────────────────
// Start bot
// ─────────────────────────────────────────────────────────────────────
setTimeout(() => {
  client.initialize().catch((err) => {
    console.error('❌ Client initialize failed:', err);
  });
}, 8000);
