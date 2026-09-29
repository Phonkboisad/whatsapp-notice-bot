import makeWASocket, { 
    DisconnectReason, 
    downloadMediaMessage,
    normalizeMessageContent,
    useMultiFileAuthState 
} from '@whiskeysockets/baileys';
import { readFile } from 'node:fs/promises';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

const NOTICE_GROUP_JID = '120363400837000305@g.us';
const DISCUSSION_GROUP_JID = '120363406812832614@g.us';
const MOD_GROUP_JID = '120363430226894816@g.us';
const BOT_DATA_FILE = new URL('./bot-data.json', import.meta.url);
const DEFAULT_CR_REPLY = 'Porte jao , Distap Hcche';
let repliesEnabled = true;

async function loadCrReplies() {
    try {
        const data = JSON.parse(await readFile(BOT_DATA_FILE, 'utf8'));
        return {
            default: data.default || DEFAULT_CR_REPLY,
            commands: data.commands || {},
            images: data.images || {}
        };
    } catch (error) {
        console.error('Could not load bot-data.json:', error);
        return { default: DEFAULT_CR_REPLY, commands: {}, images: {} };
    }
}

function formatCrHelp({ commands, images }) {
    const textCommands = Object.keys(commands)
        .map(command => '• `CR ' + command + '`')
        .join('\n');
    const imageCommands = Object.keys(images)
        .map(command => '• `CR ' + command + '`')
        .join('\n');

    return [
        '*Available commands*',
        '',
        '*Text replies*',
        '• `CR` (default reply)',
        textCommands,
        '',
        '*Schedule images*',
        imageCommands
    ].filter(Boolean).join('\n');
}

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

    // Handle CR commands
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const m of messages) {
            if (!m.message || m.key.fromMe) continue;

            const senderJid = m.key.remoteJid;

            const message = normalizeMessageContent(m.message) || m.message;
            const text =
                message.conversation ||
                message.extendedTextMessage?.text ||
                message.imageMessage?.caption ||
                message.videoMessage?.caption ||
                message.documentMessage?.caption ||
                '';

            const isModGroup = senderJid === MOD_GROUP_JID;

            if (isModGroup) {
                const controlMatch = text.match(/^\s*CR\s+(start|stop)\s*$/i);
                if (controlMatch) {
                    repliesEnabled = controlMatch[1].toLowerCase() === 'start';
                    await sock.sendMessage(
                        senderJid,
                        { text: `Bot replies ${repliesEnabled ? 'started' : 'stopped'}.` },
                        { quoted: m }
                    );
                    continue;
                }

                const echoMatch = text.match(
                    /^\s*CR\s+echo\s+(notice|discussion)(?:\s+(?:"([\s\S]*)"|([\s\S]*\S)))?\s*$/i
                );
                if (echoMatch) {
                    const targetJid = echoMatch[1].toLowerCase() === 'notice'
                        ? NOTICE_GROUP_JID
                        : DISCUSSION_GROUP_JID;
                    const echoText = echoMatch[2] ?? echoMatch[3];
                    const contextInfo = message.extendedTextMessage?.contextInfo;
                    const quotedMessage = contextInfo?.quotedMessage;
                    const quotedContent = normalizeMessageContent(quotedMessage) || quotedMessage;
                    const mediaTypes = [
                        'imageMessage',
                        'videoMessage',
                        'audioMessage',
                        'documentMessage',
                        'stickerMessage',
                        'albumMessage'
                    ];
                    const messageHasMedia = mediaTypes.some(type => message[type]);
                    const quotedMessageHasMedia = mediaTypes.some(type => quotedContent?.[type]);

                    if (messageHasMedia) {
                        const forwardedMessage = await sock.sendMessage(targetJid, { forward: m });
                        if (forwardedMessage?.key) {
                            const mediaType = [
                                'imageMessage',
                                'videoMessage',
                                'documentMessage'
                            ].find(type => message[type]?.caption !== undefined);

                            if (mediaType) {
                                try {
                                    const mediaBuffer = await downloadMediaMessage(m, 'buffer', {});
                                    const sourceMedia = message[mediaType];
                                    const editContent = {
                                        [mediaType.replace('Message', '').toLowerCase()]: mediaBuffer,
                                        caption: echoText ?? '',
                                        edit: forwardedMessage.key
                                    };

                                    if (sourceMedia.mimetype) editContent.mimetype = sourceMedia.mimetype;
                                    if (mediaType === 'documentMessage' && sourceMedia.fileName) {
                                        editContent.fileName = sourceMedia.fileName;
                                    }
                                    if (mediaType === 'videoMessage' && sourceMedia.gifPlayback) {
                                        editContent.gifPlayback = sourceMedia.gifPlayback;
                                    }

                                    await sock.sendMessage(targetJid, editContent);
                                } catch (error) {
                                    console.error('Could not remove the echo command from the forwarded caption:', error);
                                    await sock.sendMessage(
                                        senderJid,
                                        { text: 'The attachment was forwarded, but its caption could not be cleaned.' },
                                        { quoted: m }
                                    );
                                }
                            }
                        }
                    } else if (quotedMessageHasMedia) {
                        await sock.sendMessage(targetJid, {
                            forward: {
                                key: {
                                    remoteJid: senderJid,
                                    id: contextInfo.stanzaId,
                                    participant: contextInfo.participant
                                },
                                message: quotedMessage
                            }
                        });
                    } else if (echoText !== undefined) {
                        await sock.sendMessage(targetJid, { text: echoText });
                    } else {
                        await sock.sendMessage(
                            senderJid,
                            { text: 'Attach a file or reply to a message with an attachment.' },
                            { quoted: m }
                        );
                        continue;
                    }

                    await sock.sendMessage(
                        senderJid,
                        { text: `Message sent to the ${echoMatch[1].toLowerCase()} group.` },
                        { quoted: m }
                    );
                    continue;
                }
            }

            if (!isModGroup && senderJid !== DISCUSSION_GROUP_JID) continue;
            if (!isModGroup && !repliesEnabled) continue;

            const commandMatch = text.match(/\bCR\b(?:\s+([a-z]+(?:-[a-z]+)*))?/i);
            if (commandMatch) {
                const chainedCommand = commandMatch[1]?.toLowerCase();
                const crReplies = await loadCrReplies();

                if (chainedCommand === 'help') {
                    await sock.sendMessage(
                        senderJid,
                        { text: formatCrHelp(crReplies) },
                        { quoted: m }
                    );
                    continue;
                }

                const imagePath = crReplies.images[chainedCommand];

                if (imagePath) {
                    try {
                        const image = await readFile(new URL(imagePath, import.meta.url));
                        await sock.sendMessage(senderJid, { image }, { quoted: m });
                    } catch (error) {
                        console.error(`Could not send image for CR ${chainedCommand}:`, error);
                    }
                    continue;
                }

                const reply =
                    crReplies.commands[chainedCommand] || crReplies.default;

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