import makeWASocket, { 
    DisconnectReason, 
    downloadMediaMessage,
    normalizeMessageContent,
    useMultiFileAuthState 
} from '@whiskeysockets/baileys';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

const NOTICE_GROUP_JID = '120363430226894816@g.us';
const DISCUSSION_GROUP_JID = '120363406812832614@g.us';
const MOD_GROUP_JID = '120363430226894816@g.us';
const BOT_DATA_FILE = new URL('./bot-data.json', import.meta.url);
const DEFAULT_CR_REPLY = 'Porte jao , Distap Hcche';
let repliesEnabled = true;
let botDataUpdateQueue = Promise.resolve();
const resourceSelectionState = new Map();

async function loadCrReplies() {
    try {
        const data = JSON.parse(await readFile(BOT_DATA_FILE, 'utf8'));
        return {
            default: data.default || DEFAULT_CR_REPLY,
            commands: data.commands || {},
            images: data.images || {},
            resources: Array.isArray(data.resources) ? data.resources : []
        };
    } catch (error) {
        console.error('Could not load bot-data.json:', error);
        return { default: DEFAULT_CR_REPLY, commands: {}, images: {}, resources: [] };
    }
}

function updateCrReply(command, reply) {
    const update = botDataUpdateQueue.then(async () => {
        const data = JSON.parse(await readFile(BOT_DATA_FILE, 'utf8'));
        if (
            !data.commands ||
            typeof data.commands !== 'object' ||
            Array.isArray(data.commands) ||
            !Object.hasOwn(data.commands, command)
        ) {
            return false;
        }

        data.commands[command] = reply;
        const temporaryFile = new URL('./bot-data.json.tmp', import.meta.url);

        try {
            await writeFile(temporaryFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
            await rename(temporaryFile, BOT_DATA_FILE);
        } catch (error) {
            await unlink(temporaryFile).catch(() => {});
            throw error;
        }

        return true;
    });

    botDataUpdateQueue = update.catch(() => {});
    return update;
}

function getEchoSenderMention(key) {
    const phoneJid = [key?.participantAlt, key?.participant].find(
        jid => typeof jid === 'string' && /^\d+(?::\d+)?@s\.whatsapp\.net$/.test(jid)
    );
    if (!phoneJid) return { text: '@unknown:', mentions: [] };

    const [number] = phoneJid.split('@');
    const senderId = number.split(':')[0];
    return {
        text: `@${senderId}:`,
        mentions: [`${senderId}@s.whatsapp.net`]
    };
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
        '• `CR rsrc`',
        textCommands,
        '',
        '*Mod group*',
        '• `CR update <command> <new text>`',
        '',
        '*Schedule images*',
        imageCommands
    ].filter(Boolean).join('\n');
}

function formatResourceMenu(resources) {
    const lines = resources.map((resource, index) => `• ${index}. ${resource.subject}`);
    return [
        '*Available resources*',
        ...lines,
        '',
        'Reply with the number of the subject you want.'
    ].join('\n');
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' })
    });
    let connectionOpenedAt;

    sock.ev.on('creds.update', saveCreds);

    // Connection lifecycle
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            connectionOpenedAt = undefined;
            const shouldReconnect = 
                (lastDisconnect?.error instanceof Boom)
                    ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
                    : true;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            connectionOpenedAt = Math.floor(Date.now() / 1000);
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
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify' || connectionOpenedAt === undefined) return;

        for (const m of messages) {
            if (!m.message || m.key.fromMe) continue;
            const messageTimestamp = Number(m.messageTimestamp);
            if (!Number.isFinite(messageTimestamp) || messageTimestamp < connectionOpenedAt) continue;

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
            const isAllowedGroup = senderJid === NOTICE_GROUP_JID || senderJid === DISCUSSION_GROUP_JID;

            if (isModGroup) {
                if (/^\s*CR\s+update(?:\s|$)/i.test(text)) {
                    const updateMatch = text.match(
                        /^\s*CR\s+update\s+([a-z]+(?:-[a-z]+)*)\s+([\s\S]*\S)\s*$/i
                    );

                    if (!updateMatch) {
                        await sock.sendMessage(
                            senderJid,
                            { text: 'Usage: CR update <command> <new text>' },
                            { quoted: m }
                        );
                        continue;
                    }

                    const command = updateMatch[1].toLowerCase();
                    try {
                        const updated = await updateCrReply(command, updateMatch[2].trim());
                        await sock.sendMessage(
                            senderJid,
                            { text: updated
                                ? `Updated CR ${command}. The new reply is active immediately.`
                                : `No existing text command named "${command}".` },
                            { quoted: m }
                        );
                    } catch (error) {
                        console.error(`Could not update CR ${command}:`, error);
                        await sock.sendMessage(
                            senderJid,
                            { text: 'Could not update the command. Check bot-data.json and try again.' },
                            { quoted: m }
                        );
                    }
                    continue;
                }

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
                    const senderMention = getEchoSenderMention(m.key);
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
                        const mediaType = [
                            'imageMessage',
                            'videoMessage',
                            'documentMessage'
                        ].find(type => message[type]?.caption !== undefined);

                        if (!mediaType) {
                            await sock.sendMessage(targetJid, {
                                text: senderMention.text,
                                mentions: senderMention.mentions
                            });
                        }

                        const forwardedMessage = await sock.sendMessage(targetJid, { forward: m });
                        if (forwardedMessage?.key && mediaType) {
                            try {
                                const mediaBuffer = await downloadMediaMessage(m, 'buffer', {});
                                const sourceMedia = message[mediaType];
                                const editContent = {
                                    [mediaType.replace('Message', '').toLowerCase()]: mediaBuffer,
                                    caption: `${senderMention.text}${echoText ? ` ${echoText}` : ''}`,
                                    mentions: senderMention.mentions,
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
                    } else if (quotedMessageHasMedia) {
                        await sock.sendMessage(targetJid, {
                            text: senderMention.text,
                            mentions: senderMention.mentions
                        });
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
                        await sock.sendMessage(targetJid, {
                            text: `${senderMention.text} ${echoText}`,
                            mentions: senderMention.mentions
                        });
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

            if (!isModGroup && !isAllowedGroup) continue;
            if (!isModGroup && !repliesEnabled) continue;

            const pendingResources = resourceSelectionState.get(senderJid);
            if (pendingResources) {
                const choice = Number(text.trim());

                if (Number.isInteger(choice) && choice >= 0 && choice < pendingResources.length) {
                    const selected = pendingResources[choice];
                    await sock.sendMessage(
                        senderJid,
                        { text: `${selected.subject}: ${selected.link}` },
                        { quoted: m }
                    );
                    resourceSelectionState.delete(senderJid);
                    continue;
                }

                await sock.sendMessage(
                    senderJid,
                    { text: 'Invalid choice. Please reply with a valid number from the resource list.' },
                    { quoted: m }
                );
                resourceSelectionState.delete(senderJid);
                continue;
            }

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

                if (chainedCommand === 'rsrc') {
                    if (!crReplies.resources.length) {
                        await sock.sendMessage(
                            senderJid,
                            { text: 'No resources available right now.' },
                            { quoted: m }
                        );
                        continue;
                    }

                    resourceSelectionState.set(senderJid, crReplies.resources);
                    await sock.sendMessage(
                        senderJid,
                        { text: formatResourceMenu(crReplies.resources) },
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

                const reply = crReplies.commands[chainedCommand] || crReplies.default;

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