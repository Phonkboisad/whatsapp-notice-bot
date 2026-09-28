import makeWASocket, { 
    DisconnectReason, 
    useMultiFileAuthState 
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import cron from 'node-cron';

// Target group JID format: [group-id]@g.us
const NOTICE_GROUP_JID = '1203630XXXXXXXXX@g.us';

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    // Connection lifecycle
    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
        if (connection === 'close') {
            const shouldReconnect = 
                (lastDisconnect?.error instanceof Boom)
                    ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
                    : true;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('Bot is active and connected to WhatsApp!');
        }
    });

    // Schedule: Sunday to Thursday at 8:30 AM
    cron.schedule('30 8 * * 0-4', async () => {
        const announcement = 
            `📢 *Class Reminder*\n\n` +
            `• 09:00 AM - 10:30 AM: Room 402\n` +
            `• 11:00 AM - 12:30 PM: Lab 2\n\n` +
            `_Check course portal for materials._`;

        await sock.sendMessage(NOTICE_GROUP_JID, { text: announcement });
    });

    // Handle mentions
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const senderJid = m.key.remoteJid;
        const text = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
        const mentions = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const botJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';

        if (mentions.includes(botJid)) {
            let reply = "Hello! Mention me with 'routine' to see today's schedule.";
            if (/routine|class|room/i.test(text)) {
                reply = "Today's classes:\n1. 09:00 AM - Room 402\n2. 11:00 AM - Lab 2";
            }
            await sock.sendMessage(senderJid, { text: reply }, { quoted: m });
        }
    });
}

startBot();