import makeWASocket, { 
    DisconnectReason, 
    downloadMediaMessage,
    normalizeMessageContent,
    useMultiFileAuthState 
} from '@whiskeysockets/baileys';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

const NOTICE_GROUP_JID = '120363400837000305@g.us';
const DISCUSSION_GROUP_JID = '120363406812832614@g.us';
const MOD_GROUP_JID = '120363430226894816@g.us';
const BOT_DATA_FILE = new URL('./bot-data.json', import.meta.url);
const BOT_STATE_FILE = new URL('./bot-state.json', import.meta.url);
const DEFAULT_CR_REPLY = 'Keep studying and stay focused.';
const EXAMTIME_IMAGE_EXTENSIONS = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp'
};
const QUIZ_DURATION_MS = 30_000;
const QUIZ_COOLDOWN_MS = 60_000;
const SHELL_COMMAND_TIMEOUT_MS = 20_000;
const SHELL_COMMAND_MAX_OUTPUT_LENGTH = 5_000;
let repliesEnabled = true;
let botDataUpdateQueue = Promise.resolve();
let botStateUpdateQueue = Promise.resolve();
let botStateLoadPromise;
let botState = {
    quizScores: {},
    quizQuestionHistory: [],
    modGroupJids: [MOD_GROUP_JID],
    blockedCrUserJids: [],
    botAdminUserJids: []
};
const resourceSelectionState = new Map();
const activeQuizRounds = new Map();
const quizCooldowns = new Map();

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isGroupJid(value) {
    return typeof value === 'string' && /^\d+(?:-\d+)?@g\.us$/.test(value);
}

function normalizeBlockedUserJid(value) {
    if (typeof value !== 'string') return undefined;

    const normalized = value.trim();
    const phoneMatch = normalized.match(/^\+?(\d{6,15})(?::\d+)?(?:@s\.whatsapp\.net)?$/i);
    if (phoneMatch) return `${phoneMatch[1]}@s.whatsapp.net`;
    if (/^\d{6,20}@lid$/i.test(normalized)) return normalized.toLowerCase();
    return undefined;
}

const INITIAL_BOT_ADMIN_USER_JIDS = [
    ...new Set(
        (process.env.BOT_ADMIN_USER_JIDS || '90314823958687@lid')
            .split(',')
            .map(normalizeBlockedUserJid)
            .filter(Boolean)
    )
];

function isValidQuizQuestion(question) {
    return isRecord(question) &&
        typeof question.question === 'string' && question.question.trim() &&
        Array.isArray(question.choices) && question.choices.length === 3 &&
        question.choices.every(choice => typeof choice === 'string' && choice.trim()) &&
        Number.isInteger(question.answer) && question.answer >= 1 && question.answer <= 3 &&
        typeof question.explanation === 'string' && question.explanation.trim();
}

function runShellCommand(command) {
    return new Promise(resolve => {
        const child = spawn(command, {
            shell: true,
            detached: process.platform !== 'win32',
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let output = '';
        let outputLimitReached = false;
        let timedOut = false;
        let spawnError;

        const terminate = () => {
            if (process.platform !== 'win32' && child.pid) {
                try {
                    process.kill(-child.pid, 'SIGTERM');
                } catch {}
            } else {
                child.kill('SIGTERM');
            }
        };

        const appendOutput = chunk => {
            const text = chunk.toString('utf8');
            const remainingLength = SHELL_COMMAND_MAX_OUTPUT_LENGTH - output.length;
            output += text.slice(0, remainingLength);
            if (text.length > remainingLength && !outputLimitReached) {
                outputLimitReached = true;
                terminate();
            }
        };

        child.stdout.on('data', appendOutput);
        child.stderr.on('data', appendOutput);
        child.once('error', error => {
            spawnError = error;
        });

        const timeout = setTimeout(() => {
            timedOut = true;
            terminate();
        }, SHELL_COMMAND_TIMEOUT_MS);

        child.once('close', (code, signal) => {
            clearTimeout(timeout);
            resolve({ code, output, outputLimitReached, signal, spawnError, timedOut });
        });
    });
}

async function loadCrReplies() {
    try {
        const data = JSON.parse(await readFile(BOT_DATA_FILE, 'utf8'));
        return {
            default: data.default || DEFAULT_CR_REPLY,
            commands: data.commands || {},
            images: data.images || {},
            resources: Array.isArray(data.resources) ? data.resources : [],
            quizQuestions: Array.isArray(data.quizQuestions)
                ? data.quizQuestions.filter(isValidQuizQuestion)
                : []
        };
    } catch (error) {
        console.error('Could not load bot-data.json:', error);
        return { default: DEFAULT_CR_REPLY, commands: {}, images: {}, resources: [], quizQuestions: [] };
    }
}

function ensureBotStateLoaded() {
    if (!botStateLoadPromise) {
        botStateLoadPromise = (async () => {
            try {
                const data = JSON.parse(await readFile(BOT_STATE_FILE, 'utf8'));
                const scores = isRecord(data) && isRecord(data.quizScores) ? data.quizScores : {};
                const quizScores = {};
                const configuredModGroups = Array.isArray(data?.modGroupJids)
                    ? data.modGroupJids.filter(isGroupJid)
                    : [];
                const blockedCrUserJids = Array.isArray(data?.blockedCrUserJids)
                    ? [...new Set(data.blockedCrUserJids.map(normalizeBlockedUserJid).filter(Boolean))]
                    : [];
                const botAdminUserJids = Array.isArray(data?.botAdminUserJids)
                    ? [...new Set(data.botAdminUserJids.map(normalizeBlockedUserJid).filter(Boolean))]
                    : [...INITIAL_BOT_ADMIN_USER_JIDS];

                for (const [groupJid, groupScores] of Object.entries(scores)) {
                    if (!isRecord(groupScores)) continue;

                    quizScores[groupJid] = Object.fromEntries(
                        Object.entries(groupScores).filter(([, entry]) =>
                            isRecord(entry) && typeof entry.name === 'string' &&
                            Number.isInteger(entry.score) && entry.score >= 0
                        )
                    );
                }

                botState = {
                    quizScores,
                    quizQuestionHistory: Array.isArray(data?.quizQuestionHistory)
                        ? data.quizQuestionHistory.filter(question => typeof question === 'string')
                        : [],
                    modGroupJids: [...new Set([MOD_GROUP_JID, ...configuredModGroups])],
                    blockedCrUserJids,
                    botAdminUserJids
                };
            } catch (error) {
                if (error.code !== 'ENOENT') {
                    console.error('Could not load bot-state.json; starting with empty quiz scores:', error);
                }
                botState = {
                    quizScores: {},
                    quizQuestionHistory: [],
                    modGroupJids: [MOD_GROUP_JID],
                    blockedCrUserJids: [],
                    botAdminUserJids: [...INITIAL_BOT_ADMIN_USER_JIDS]
                };
            }
        })();
    }

    return botStateLoadPromise;
}

function persistBotState() {
    const update = botStateUpdateQueue.then(async () => {
        const temporaryFile = new URL('./bot-state.json.tmp', import.meta.url);

        try {
            await writeFile(temporaryFile, `${JSON.stringify(botState, null, 2)}\n`, 'utf8');
            await rename(temporaryFile, BOT_STATE_FILE);
        } catch (error) {
            await unlink(temporaryFile).catch(() => {});
            throw error;
        }
    });

    botStateUpdateQueue = update.catch(() => {});
    return update;
}

function getQuizParticipantId(key) {
    const participantJids = [key?.participantAlt, key?.participant];
    const phoneJid = participantJids.find(
        jid => typeof jid === 'string' && /^\d+(?::\d+)?@s\.whatsapp\.net$/.test(jid)
    );

    if (phoneJid) {
        const [number] = phoneJid.split('@');
        return `${number.split(':')[0]}@s.whatsapp.net`;
    }

    return participantJids.find(jid => typeof jid === 'string' && jid.length > 0);
}

function getMessageSenderUserJid(key, remoteJid) {
    return normalizeBlockedUserJid(getQuizParticipantId(key)) ||
        normalizeBlockedUserJid(remoteJid);
}

function formatQuizQuestion(question) {
    return [
        '*Quiz*',
        question.question,
        ...question.choices.map((choice, index) => `${index + 1}. ${choice}`),
        '',
        'Reply with 1, 2, or 3 within 30 seconds. You can answer once.'
    ].join('\n');
}

function formatQuizScoreboard(scores) {
    const leaders = Object.values(scores)
        .filter(entry => isRecord(entry) && typeof entry.name === 'string' && Number.isInteger(entry.score))
        .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
        .slice(0, 5);

    if (!leaders.length) return 'No points yet. Start a quiz with `CR quiz`.';

    return [
        '*Quiz Leaderboard*',
        ...leaders.map((leader, index) => `${index + 1}. ${leader.name} - ${leader.score} point${leader.score === 1 ? '' : 's'}`)
    ].join('\n');
}

function selectNextQuizQuestion(questions) {
    const questionsById = new Map(questions.map(question => [question.question, question]));
    let history = [...new Set(botState.quizQuestionHistory)]
        .filter(question => questionsById.has(question));
    let unseenQuestions = [...questionsById.keys()].filter(question => !history.includes(question));

    if (!unseenQuestions.length) {
        history = [];
        unseenQuestions = [...questionsById.keys()];
    }

    const questionId = unseenQuestions[Math.floor(Math.random() * unseenQuestions.length)];
    botState.quizQuestionHistory = [...history, questionId];
    return questionsById.get(questionId);
}

async function finishQuizRound(sock, groupJid, round) {
    if (activeQuizRounds.get(groupJid) !== round) return;

    activeQuizRounds.delete(groupJid);
    quizCooldowns.set(groupJid, Date.now() + QUIZ_COOLDOWN_MS);

    const correctPlayers = [...round.answers.values()]
        .filter(answer => answer.correct)
        .map(answer => answer.name);
    const result = correctPlayers.length
        ? `Correct answers submitted by: ${correctPlayers.join(', ')}`
        : 'No one answered correctly this round.';

    await sock.sendMessage(groupJid, {
        text: [
            `Time is up! Correct answer: ${round.question.answer}. ${round.question.choices[round.question.answer - 1]}`,
            round.question.explanation,
            result
        ].join('\n')
    });
}

async function handleQuizAnswer(sock, message, groupJid, round, choice) {
    const participantId = getQuizParticipantId(message.key);
    if (!participantId) {
        await sock.sendMessage(groupJid, {
            text: "I couldn't identify you, so your answer wasn't counted.",
            quoted: message
        });
        return;
    }

    if (round.answers.has(participantId)) {
        await sock.sendMessage(groupJid, {
            text: 'You can answer only once per round.',
            quoted: message
        });
        return;
    }

    const isCorrect = Number(choice) === round.question.answer;
    const previousScore = botState.quizScores[groupJid]?.[participantId];
    const name = (message.pushName || previousScore?.name || 'Classmate').replace(/\s+/g, ' ').trim().slice(0, 40);
    round.answers.set(participantId, { name, correct: isCorrect });

    if (isCorrect) {
        const groupScores = botState.quizScores[groupJid] || {};
        groupScores[participantId] = { name, score: (previousScore?.score || 0) + 1 };
        botState.quizScores[groupJid] = groupScores;

        try {
            await persistBotState();
        } catch (error) {
            console.error('Could not save the quiz score:', error);
        }
    }

    await sock.sendMessage(groupJid, {
        text: isCorrect
            ? 'Correct! You earned 1 point.'
            : 'Not quite. The correct answer will be revealed when the round ends.',
        quoted: message
    });
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

function updateCrImage(command, imagePath, reply) {
    const update = botDataUpdateQueue.then(async () => {
        const data = JSON.parse(await readFile(BOT_DATA_FILE, 'utf8'));
        if (
            !isRecord(data.commands) ||
            !Object.hasOwn(data.commands, command)
        ) {
            return { updated: false };
        }

        if (reply !== undefined) data.commands[command] = reply;
        if (!isRecord(data.images)) data.images = {};
        const previousImage = data.images[command];
        data.images[command] = imagePath;
        const temporaryFile = new URL('./bot-data.json.tmp', import.meta.url);

        try {
            await writeFile(temporaryFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
            await rename(temporaryFile, BOT_DATA_FILE);
        } catch (error) {
            await unlink(temporaryFile).catch(() => {});
            throw error;
        }

        return { updated: true, previousImage };
    });

    botDataUpdateQueue = update.catch(() => {});
    return update;
}

function isManagedExamtimeImage(imagePath) {
    return typeof imagePath === 'string' &&
        /^assets\/examtime-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png|webp)$/i.test(imagePath);
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

function formatCrHelp({ commands, images }, showModManual) {
    const textCommands = Object.keys(commands)
        .map(command => '• `CR ' + command + '`')
        .join('\n');
    const imageCommands = Object.keys(images)
        .map(command => '• `CR ' + command + '`')
        .join('\n');

    if (!showModManual) {
        return [
            '*Discussion group command manual*',
            '',
            '*General*',
            '• `CR` (default reply)',
            '• `CR help`',
            '• `CR myid` (show your WhatsApp JID)',
            textCommands,
            '',
            '*Resources*',
            '• `CR rsrc`',
            '',
            '*Games*',
            '• `CR quiz`',
            '• `CR score`',
            '',
            '*Schedule images*',
            imageCommands
        ].filter(Boolean).join('\n');
    }

    return [
        '*Mod group full command manual*',
        '',
        '*General*',
        '• `CR` (default reply)',
        '• `CR help`',
        '• `CR myid` (show your WhatsApp JID)',
        textCommands,
        '',
        '*Resources*',
        '• `CR rsrc`',
        '',
        '*Games*',
        '• `CR quiz` (Discussion and mod groups)',
        '• `CR score` (Discussion and mod groups)',
        '',
        '*Mod group members*',
        '• `CR mod list`',
        '• `CR start` (enable Discussion group replies)',
        '• `CR stop` (disable Discussion group replies)',
        '• `CR update <command> <new text>`',
        '• `CR echo notice [text]` (or echo a caption/attachment)',
        '• `CR echo discussion [text]` (or echo a caption/attachment)',
        '',
        '*Bot admins only*',
        '• `CR admin add <phone number, JID, or @mention>`',
        '• `CR admin remove <phone number, JID, or @mention>`',
        '• `CR admin list`',
        '• `CR mod add <group JID>`',
        '• `CR mod remove <group JID>`',
        '• `CR block <phone number, JID, or @mention>`',
        '• `CR unblock <phone number, JID, or @mention>`',
        '• `CR run <shell command>`',
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
    await ensureBotStateLoaded();
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

            const isModGroup = botState.modGroupJids.includes(senderJid);
            const isAllowedGroup = senderJid === NOTICE_GROUP_JID || senderJid === DISCUSSION_GROUP_JID;
            const senderUserJid = getMessageSenderUserJid(m.key, senderJid);
            const isBotAdmin = senderUserJid && botState.botAdminUserJids.includes(senderUserJid);
            const canManageBot = isModGroup || isBotAdmin;
            const isBlockedFromCr = !isBotAdmin && senderUserJid && botState.blockedCrUserJids.includes(senderUserJid);

            if (/^\s*CR\s+myid\s*$/i.test(text)) {
                await sock.sendMessage(
                    senderJid,
                    { text: senderUserJid ? `Your WhatsApp JID: ${senderUserJid}` : 'Could not determine your WhatsApp JID.' },
                    { quoted: m }
                );
                continue;
            }

            if (
                isBlockedFromCr &&
                (isModGroup || senderJid === DISCUSSION_GROUP_JID) &&
                /\bCR\b/i.test(text)
            ) {
                await sock.sendMessage(
                    senderJid,
                    { text: 'You are blocked from using CR commands in this group.' },
                    { quoted: m }
                );
                continue;
            }

            if (/^\s*CR\s+admin(?:\s|$)/i.test(text) && !isBotAdmin) {
                await sock.sendMessage(
                    senderJid,
                    { text: 'Only configured bot admins can manage the admin list.' },
                    { quoted: m }
                );
                continue;
            }

            if (canManageBot) {
                if (/^\s*CR\s+admin(?:\s|$)/i.test(text)) {
                    const adminMatch = text.match(/^\s*CR\s+admin\s+(add|remove|list)(?:\s+(\S+))?\s*$/i);
                    if (!adminMatch || (adminMatch[1].toLowerCase() === 'list' && adminMatch[2]) ||
                        (adminMatch[1].toLowerCase() !== 'list' && !adminMatch[2])) {
                        await sock.sendMessage(
                            senderJid,
                            { text: 'Usage: CR admin add <phone number, JID, or @mention>, CR admin remove <phone number, JID, or @mention>, or CR admin list.' },
                            { quoted: m }
                        );
                        continue;
                    }

                    const action = adminMatch[1].toLowerCase();
                    if (action === 'list') {
                        await sock.sendMessage(
                            senderJid,
                            { text: botState.botAdminUserJids.length
                                ? `Bot admins:\n${botState.botAdminUserJids.map(jid => `• ${jid}`).join('\n')}`
                                : 'No bot admins are configured.' },
                            { quoted: m }
                        );
                        continue;
                    }

                    const target = adminMatch[2];
                    const mentionedJids = message.extendedTextMessage?.contextInfo?.mentionedJid || [];
                    const userJid = target.startsWith('@')
                        ? mentionedJids.length === 1
                            ? normalizeBlockedUserJid(mentionedJids[0])
                            : undefined
                        : normalizeBlockedUserJid(target);
                    if (!userJid) {
                        await sock.sendMessage(
                            senderJid,
                            { text: target.startsWith('@')
                                ? 'Mention exactly one valid WhatsApp user.'
                                : 'Provide a valid phone number, phone JID, or WhatsApp LID.' },
                            { quoted: m }
                        );
                        continue;
                    }

                    const wasAdmin = botState.botAdminUserJids.includes(userJid);
                    if ((action === 'add' && wasAdmin) || (action === 'remove' && !wasAdmin)) {
                        await sock.sendMessage(
                            senderJid,
                            { text: action === 'add' ? 'That user is already a bot admin.' : 'That user is not a bot admin.' },
                            { quoted: m }
                        );
                        continue;
                    }
                    if (action === 'remove' && botState.botAdminUserJids.length <= 1) {
                        await sock.sendMessage(
                            senderJid,
                            { text: 'The last bot admin cannot be removed. Add another admin first.' },
                            { quoted: m }
                        );
                        continue;
                    }

                    const previousAdmins = botState.botAdminUserJids;
                    botState.botAdminUserJids = action === 'add'
                        ? [...previousAdmins, userJid]
                        : previousAdmins.filter(adminJid => adminJid !== userJid);
                    try {
                        await persistBotState();
                        await sock.sendMessage(
                            senderJid,
                            { text: action === 'add' ? `Added ${userJid} as a bot admin.` : `Removed ${userJid} as a bot admin.` },
                            { quoted: m }
                        );
                    } catch (error) {
                        botState.botAdminUserJids = previousAdmins;
                        console.error('Could not save the bot admin list:', error);
                        await sock.sendMessage(
                            senderJid,
                            { text: 'Could not save the bot admin list. Try again.' },
                            { quoted: m }
                        );
                    }
                    continue;
                }

                if (/^\s*CR\s+(?:block|unblock)(?:\s|$)/i.test(text)) {
                    if (!isBotAdmin) {
                        await sock.sendMessage(
                            senderJid,
                            { text: 'Only bot admins can block or unblock users.' },
                            { quoted: m }
                        );
                        continue;
                    }

                    const blockMatch = text.match(/^\s*CR\s+(block|unblock)\s+(\S+)\s*$/i);
                    if (!blockMatch) {
                        await sock.sendMessage(
                            senderJid,
                            { text: 'Usage: CR block <phone number or WhatsApp JID> or CR unblock <phone number or WhatsApp JID>.' },
                            { quoted: m }
                        );
                        continue;
                    }

                    const action = blockMatch[1].toLowerCase();
                    const target = blockMatch[2];
                    const mentionedJids = message.extendedTextMessage?.contextInfo?.mentionedJid || [];
                    const userJid = target.startsWith('@')
                        ? mentionedJids.length === 1
                            ? normalizeBlockedUserJid(mentionedJids[0])
                            : undefined
                        : normalizeBlockedUserJid(target);
                    if (!userJid) {
                        await sock.sendMessage(
                            senderJid,
                            { text: target.startsWith('@')
                                ? 'Mention exactly one valid WhatsApp user.'
                                : 'Provide a valid phone number, phone JID, or WhatsApp LID.' },
                            { quoted: m }
                        );
                        continue;
                    }

                    const wasBlocked = botState.blockedCrUserJids.includes(userJid);
                    if ((action === 'block' && wasBlocked) || (action === 'unblock' && !wasBlocked)) {
                        await sock.sendMessage(
                            senderJid,
                            { text: action === 'block' ? 'That user is already blocked from CR commands.' : 'That user is not blocked from CR commands.' },
                            { quoted: m }
                        );
                        continue;
                    }

                    const previousBlockedUsers = botState.blockedCrUserJids;
                    botState.blockedCrUserJids = action === 'block'
                        ? [...previousBlockedUsers, userJid]
                        : previousBlockedUsers.filter(blockedJid => blockedJid !== userJid);

                    try {
                        await persistBotState();
                        await sock.sendMessage(
                            senderJid,
                            { text: action === 'block'
                                ? `Blocked ${userJid} from CR commands in Discussion and mod groups.`
                                : `Unblocked ${userJid} for CR commands in Discussion and mod groups.` },
                            { quoted: m }
                        );
                    } catch (error) {
                        botState.blockedCrUserJids = previousBlockedUsers;
                        console.error('Could not save the CR blocked-user list:', error);
                        await sock.sendMessage(
                            senderJid,
                            { text: 'Could not save the CR blocked-user list. Try again.' },
                            { quoted: m }
                        );
                    }
                    continue;
                }

                if (/^\s*CR\s+run(?:\s|$)/i.test(text)) {
                    if (!isBotAdmin) {
                        await sock.sendMessage(
                            senderJid,
                            { text: 'Only bot admins can run shell commands.' },
                            { quoted: m }
                        );
                        continue;
                    }

                    const runMatch = text.match(/^\s*CR\s+run\s+([\s\S]*\S)\s*$/i);
                    if (!runMatch) {
                        await sock.sendMessage(
                            senderJid,
                            { text: 'Usage: CR run <shell command>' },
                            { quoted: m }
                        );
                        continue;
                    }

                    const command = runMatch[1].trim();
                    if (/^pm2\s+stop(?:\s|$)/i.test(command)) {
                        await sock.sendMessage(
                            senderJid,
                            { text: 'This command cannot be run because `pm2 stop` would stop the bot and make it unusable.' },
                            { quoted: m }
                        );
                        continue;
                    }

                    let result;
                    try {
                        result = await runShellCommand(command);
                    } catch (error) {
                        console.error('Could not run the requested shell command:', error);
                        await sock.sendMessage(
                            senderJid,
                            { text: `*SHELL OUTPUT*\nCommand failed to run: ${error.message}` },
                            { quoted: m }
                        );
                        continue;
                    }

                    const status = result.spawnError
                        ? `Failed to start: ${result.spawnError.message}`
                        : result.timedOut
                            ? `Timed out after ${SHELL_COMMAND_TIMEOUT_MS / 1000} seconds`
                            : result.signal
                                ? `Terminated by signal: ${result.signal}`
                                : `Exit code: ${result.code ?? 'unknown'}`;
                    const output = result.output.trimEnd() || '(no output)';
                    const response = [
                        '*SHELL OUTPUT*',
                        `Command: ${command}`,
                        status,
                        result.outputLimitReached ? 'Output truncated at 5,000 characters.' : '',
                        '```',
                        output,
                        '```'
                    ].filter(Boolean).join('\n');

                    await sock.sendMessage(senderJid, { text: response }, { quoted: m });
                    continue;
                }

                if (/^\s*CR\s+mod(?:\s|$)/i.test(text)) {
                    const modCommand = text.match(
                        /^\s*CR\s+mod\s+(add|list|remove)(?:\s+(\S+))?\s*$/i
                    );

                    if (!modCommand || (modCommand[1].toLowerCase() !== 'list' && !modCommand[2])) {
                        await sock.sendMessage(
                            senderJid,
                            { text: 'Usage: CR mod add <group JID>, CR mod list, or CR mod remove <group JID>.' },
                            { quoted: m }
                        );
                        continue;
                    }

                    const action = modCommand[1].toLowerCase();
                    const groupJid = modCommand[2];
                    if (action !== 'list' && !isBotAdmin) {
                        await sock.sendMessage(
                            senderJid,
                            { text: 'Only bot admins can add or remove mod groups.' },
                            { quoted: m }
                        );
                        continue;
                    }

                    if (action === 'list') {
                        await sock.sendMessage(
                            senderJid,
                            { text: `Trusted mod groups:\n${botState.modGroupJids.map(jid => `• ${jid}`).join('\n')}` },
                            { quoted: m }
                        );
                        continue;
                    }

                    if (!isGroupJid(groupJid)) {
                        await sock.sendMessage(
                            senderJid,
                            { text: 'That is not a valid WhatsApp group JID. It should end in @g.us.' },
                            { quoted: m }
                        );
                        continue;
                    }

                    if (action === 'remove' && groupJid === MOD_GROUP_JID) {
                        await sock.sendMessage(
                            senderJid,
                            { text: 'The original mod group cannot be removed.' },
                            { quoted: m }
                        );
                        continue;
                    }

                    if (action === 'add' && botState.modGroupJids.includes(groupJid)) {
                        await sock.sendMessage(
                            senderJid,
                            { text: 'That group is already a mod group.' },
                            { quoted: m }
                        );
                        continue;
                    }

                    if (action === 'remove' && !botState.modGroupJids.includes(groupJid)) {
                        await sock.sendMessage(
                            senderJid,
                            { text: 'That group is not in the mod group list.' },
                            { quoted: m }
                        );
                        continue;
                    }

                    const previousModGroupJids = botState.modGroupJids;
                    botState.modGroupJids = action === 'add'
                        ? [...previousModGroupJids, groupJid]
                        : previousModGroupJids.filter(jid => jid !== groupJid);

                    try {
                        await persistBotState();
                        await sock.sendMessage(
                            senderJid,
                            { text: action === 'add' ? `Added ${groupJid} as a mod group.` : `Removed ${groupJid} from mod groups.` },
                            { quoted: m }
                        );
                    } catch (error) {
                        botState.modGroupJids = previousModGroupJids;
                        console.error('Could not save mod group settings:', error);
                        await sock.sendMessage(
                            senderJid,
                            { text: 'Could not save the mod group settings. Try again.' },
                            { quoted: m }
                        );
                    }
                    continue;
                }

                if (/^\s*CR\s+update(?:\s|$)/i.test(text)) {
                    const hasMediaAttachment = [
                        'imageMessage',
                        'videoMessage',
                        'documentMessage',
                        'audioMessage',
                        'stickerMessage',
                        'albumMessage'
                    ].some(type => message[type]);

                    if (hasMediaAttachment) {
                        const imageUpdateMatch = text.match(
                            /^\s*CR\s+update\s+examtime(?:\s+([\s\S]*\S))?\s*$/i
                        );
                        if (!message.imageMessage || !imageUpdateMatch) {
                            await sock.sendMessage(
                                senderJid,
                                { text: 'Attach a JPEG, PNG, or WebP image with the caption `CR update examtime <new text>` or `CR update examtime`.' },
                                { quoted: m }
                            );
                            continue;
                        }

                        const mimeType = message.imageMessage.mimetype;
                        const extension = Object.hasOwn(EXAMTIME_IMAGE_EXTENSIONS, mimeType)
                            ? EXAMTIME_IMAGE_EXTENSIONS[mimeType]
                            : undefined;
                        if (!extension) {
                            await sock.sendMessage(
                                senderJid,
                                { text: 'Only JPEG, PNG, and WebP images can be saved for CR examtime.' },
                                { quoted: m }
                            );
                            continue;
                        }

                        let savedImagePath;
                        let settingsUpdated = false;
                        try {
                            const imageBuffer = await downloadMediaMessage(m, 'buffer', {});
                            if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
                                throw new Error('Downloaded examtime image was empty.');
                            }

                            savedImagePath = `assets/examtime-${randomUUID()}.${extension}`;
                            await writeFile(new URL(savedImagePath, import.meta.url), imageBuffer, { flag: 'wx' });

                            const updatedReply = imageUpdateMatch[1]?.trim();
                            const result = await updateCrImage('examtime', savedImagePath, updatedReply);
                            if (!result.updated) {
                                await unlink(new URL(savedImagePath, import.meta.url)).catch(() => {});
                                savedImagePath = undefined;
                                await sock.sendMessage(
                                    senderJid,
                                    { text: 'No existing text command named "examtime".' },
                                    { quoted: m }
                                );
                                continue;
                            }

                            settingsUpdated = true;
                            if (isManagedExamtimeImage(result.previousImage)) {
                                await unlink(new URL(result.previousImage, import.meta.url)).catch(error => {
                                    console.error('Could not remove the previous examtime image:', error);
                                });
                            }

                            await sock.sendMessage(
                                senderJid,
                                { text: updatedReply
                                    ? 'Updated the CR examtime text and image.'
                                    : 'Updated the CR examtime image. CR examtime will send its text and this image.' },
                                { quoted: m }
                            );
                        } catch (error) {
                            if (savedImagePath && !settingsUpdated) {
                                await unlink(new URL(savedImagePath, import.meta.url)).catch(() => {});
                            }
                            console.error('Could not update the CR examtime image:', error);
                            await sock.sendMessage(
                                senderJid,
                                { text: 'Could not update the CR examtime image. Check bot-data.json and try again.' },
                                { quoted: m }
                            );
                        }
                        continue;
                    }

                    const updateMatch = text.match(
                        /^\s*CR\s+update\s+([a-z]+(?:-[a-z]+)*)\s+([\s\S]*\S)\s*$/i
                    );

                    if (!updateMatch) {
                        await sock.sendMessage(
                            senderJid,
                            { text: 'Usage: CR update <command> <new text>, or attach an image with the caption `CR update examtime`.' },
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

            if (!isModGroup && !isAllowedGroup && !isBotAdmin) continue;
            if (!isModGroup && !isBotAdmin && !repliesEnabled) continue;

            const activeQuiz = activeQuizRounds.get(senderJid);
            if (activeQuiz && /^[1-3]$/.test(text.trim())) {
                await handleQuizAnswer(sock, m, senderJid, activeQuiz, text.trim());
                continue;
            }

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
                        { text: formatCrHelp(
                            crReplies,
                            senderJid !== DISCUSSION_GROUP_JID && (isModGroup || isBotAdmin)
                        ) },
                        { quoted: m }
                    );
                    continue;
                }

                if (chainedCommand === 'quiz') {
                    if (senderJid !== DISCUSSION_GROUP_JID && !isModGroup && !isBotAdmin) {
                        await sock.sendMessage(
                            senderJid,
                            { text: 'The quiz is available only in the Discussion group and configured mod groups.' },
                            { quoted: m }
                        );
                        continue;
                    }

                    if (activeQuizRounds.has(senderJid)) {
                        await sock.sendMessage(
                            senderJid,
                            { text: 'A quiz is already in progress. Reply with 1, 2, or 3.' },
                            { quoted: m }
                        );
                        continue;
                    }

                    const cooldownUntil = quizCooldowns.get(senderJid) || 0;
                    if (cooldownUntil > Date.now()) {
                        const secondsRemaining = Math.ceil((cooldownUntil - Date.now()) / 1000);
                        await sock.sendMessage(
                            senderJid,
                            { text: `Please wait ${secondsRemaining} more seconds before starting another quiz.` },
                            { quoted: m }
                        );
                        continue;
                    }

                    if (!crReplies.quizQuestions.length) {
                        await sock.sendMessage(
                            senderJid,
                            { text: 'There are no valid quiz questions. Check bot-data.json.' },
                            { quoted: m }
                        );
                        continue;
                    }

                    const previousQuestionHistory = botState.quizQuestionHistory;
                    const question = selectNextQuizQuestion(crReplies.quizQuestions);
                    try {
                        await persistBotState();
                    } catch (error) {
                        botState.quizQuestionHistory = previousQuestionHistory;
                        console.error('Could not save quiz question history:', error);
                        await sock.sendMessage(
                            senderJid,
                            { text: 'The quiz could not start. Please try again.' },
                            { quoted: m }
                        );
                        continue;
                    }

                    const round = { question, answers: new Map() };
                    activeQuizRounds.set(senderJid, round);
                    resourceSelectionState.delete(senderJid);
                    setTimeout(() => {
                        finishQuizRound(sock, senderJid, round).catch(error => {
                            console.error('Could not finish the quiz round:', error);
                        });
                    }, QUIZ_DURATION_MS);

                    await sock.sendMessage(senderJid, { text: formatQuizQuestion(question) });
                    continue;
                }

                if (chainedCommand === 'score') {
                    const scores = botState.quizScores[senderJid] || {};
                    const response = senderJid === DISCUSSION_GROUP_JID || isModGroup || isBotAdmin
                        ? formatQuizScoreboard(scores)
                        : 'Quiz scores are available only in the Discussion group and configured mod groups.';
                    await sock.sendMessage(senderJid, { text: response }, { quoted: m });
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
                    const reply = crReplies.commands[chainedCommand] || crReplies.default;
                    try {
                        const image = await readFile(new URL(imagePath, import.meta.url));
                        if (chainedCommand === 'examtime') {
                            await sock.sendMessage(
                                senderJid,
                                { image, caption: reply },
                                { quoted: m }
                            );
                        } else {
                            await sock.sendMessage(senderJid, { image }, { quoted: m });
                        }
                    } catch (error) {
                        console.error(`Could not send image for CR ${chainedCommand}:`, error);
                        if (chainedCommand === 'examtime') {
                            await sock.sendMessage(senderJid, { text: reply }, { quoted: m });
                        }
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