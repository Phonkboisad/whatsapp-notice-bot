import makeWASocket, { 
    DisconnectReason, 
    normalizeMessageContent,
    useMultiFileAuthState 
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import cron from 'node-cron';
import qrcode from 'qrcode-terminal';

// Target group JID format: [group-id]@g.us
const NOTICE_GROUP_JID = '120363406812832614@g.us';
const CR_DEFAULT_REPLY = 'Porte jao , Distap Hcche';
const CR_COMMAND_REPLIES = {
    classtime: 'Classtime details will be added soon.',
    examtime: 'Examtime details will be added soon.',
    special: 'Special announcements will be added soon.',
    assignment: 'Assignment details will be added soon.',
    classtest: 'Classtest details will be added soon.',
    labtest: 'Labtest details will be added soon.'
};

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    // Connection lifecycle
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = 
                (lastDisconnect?.error instanceof Boom)
                    ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
                    : true;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('Bot is active and connected to WhatsApp!');

            try {
                const groups = await sock.groupFetchAllParticipating();

                console.log('Available WhatsApp groups:');
                for (const group of Object.values(groups)) {
                    console.log(`${group.subject}: ${group.id}`);
                }
            } catch (error) {
                console.error('Could not fetch WhatsApp groups:', error);
            }
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

    // Handle CR commands
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const m of messages) {
            if (!m.message || m.key.fromMe) continue;

            const senderJid = m.key.remoteJid;
            if (senderJid !== NOTICE_GROUP_JID) continue;

            const message = normalizeMessageContent(m.message) || m.message;
            const text =
                message.conversation ||
                message.extendedTextMessage?.text ||
                message.imageMessage?.caption ||
                message.videoMessage?.caption ||
                message.documentMessage?.caption ||
                '';

            const commandMatch = text.match(/\bCR\b(?:\s+([a-z]+))?/i);
            if (commandMatch) {
                const chainedCommand = commandMatch[1]?.toLowerCase();
                const reply =
                    CR_COMMAND_REPLIES[chainedCommand] || CR_DEFAULT_REPLY;

                await sock.sendMessage(
                    senderJid,
                    { text: reply },
                    { quoted: m }
                );
            }
        }
    });
}

startBot();