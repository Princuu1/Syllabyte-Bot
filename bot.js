require('dotenv').config();

const { Client, MessageMedia, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');

const { getSubjects, getFiles, searchFile, getPublicUrl } = require('./supabase');

// ✅ Multiple allowed chats
const ALLOWED_CHATS = process.env.ALLOWED_CHAT_IDS
  .split(',')
  .map(id => id.trim());

const client = new Client({
    authStrategy: new LocalAuth()
});

// QR
client.on('qr', qr => {
    console.log("📱 Scan QR:");
    qrcode.generate(qr, { small: true });
});

// READY
client.on('ready', () => {
    console.log('✅ Bot Ready');
});

// ⏱ Delay helper
const delay = (ms) => new Promise(res => setTimeout(res, ms));

// MAIN HANDLER
client.on('message', async message => {

    if (!ALLOWED_CHATS.includes(message.from)) return;

    const msg = message.body.trim().toLowerCase();

    try {

        // 📚 GET SUBJECTS
        if (msg === 'get subjects') {

            await message.react('👀'); // 👀 first
            await delay(300);

            await message.react('⏳'); // ⏳ loading
            await delay(300);

            const subjects = await getSubjects();

            await message.react('✅'); // ✅ done

            return message.reply(
                `📚 Subjects:\n\n${subjects.map(s => '• ' + s).join('\n')}`
            );
        }

        // 📦 HANDLE "get ..."
        if (msg.startsWith('get ')) {

            await message.react('👀'); // 👀 first
            await delay(300);

            await message.react('⏳'); // ⏳ loading
            await delay(300);

            const query = msg.replace('get ', '').trim();
            const subjects = await getSubjects();

            // 📂 SUBJECT FILE LIST
            if (subjects.includes(query)) {
                const files = await getFiles(query);

                if (!files.length) {
                    await message.react('❌');
                    return message.reply("❌ No files found");
                }

                let text = `📚 *${query.toUpperCase()} FILES*\n\n`;

                files.forEach((f, i) => {
                    text += `${i + 1}. ${f.name.replace('.pdf', '')}\n`;
                });

                await message.react('✅');
                return message.reply(text);
            }

            // 🔍 GLOBAL FILE SEARCH
            const result = await searchFile(query);

            if (!result) {
                await message.react('❌');
                return message.reply("❌ File not found");
            }

            const url = getPublicUrl(result.subject, result.file);

            const response = await axios.get(url, {
                responseType: 'arraybuffer'
            });

            const media = new MessageMedia(
                'application/pdf',
                Buffer.from(response.data).toString('base64'),
                result.file
            );

            await message.react('✅');
            return message.reply(media);
        }

        return;

    } catch (err) {
        console.error(err);
        await message.react('❌');
        message.reply("❌ Error occurred");
    }
});

client.initialize();