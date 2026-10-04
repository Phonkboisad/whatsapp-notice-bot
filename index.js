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
import {
    createGameAccount,
    GAME_DAILY_ATTEMPT_LIMIT,
    GAME_TYPES,
    getGameLeaderboard,
    getLocalDayKey,
    playGameTurn,
    sanitizeGameName,
    transferGamePoints as applyGamePointTransfer
} from './cse-game.js';

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
const GIPHY_API_KEY_IN_CODE = 'PASTE_YOUR_GIPHY_API_KEY_HERE';
const GIPHY_API_KEY = process.env.GIPHY_API_KEY?.trim() ||
    (GIPHY_API_KEY_IN_CODE.startsWith('PASTE_') ? '' : GIPHY_API_KEY_IN_CODE);
const GIPHY_TAG = process.env.GIPHY_TAG?.trim() || 'meme';
const GIPHY_REQUEST_TIMEOUT_MS = 15_000;
const GIPHY_API_MAX_RESPONSE_BYTES = 64 * 1024;
const GIPHY_MEDIA_MAX_BYTES = 8 * 1024 * 1024;
const GIPHY_MAX_REDIRECTS = 3;
let repliesEnabled = true;
let botDataUpdateQueue = Promise.resolve();
let botStateUpdateQueue = Promise.resolve();
let botStateLoadPromise;
let botState = {
    quizScores: {},
    quizQuestionHistory: [],
    gameAccounts: {},
    modGroupJids: [MOD_GROUP_JID],
    blockedCrUserJids: [],
    botAdminUserJids: []
};
const resourceSelectionState = new Map();
const activeQuizRounds = new Map();
const quizCooldowns = new Map();
let gameUpdateQueue = Promise.resolve();

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isGroupJid(value) {
    return typeof value === 'string' && /^\d+(?:-\d+)?@g\.us$/.test(value);
}

async function fetchHttpsResponse(urlValue, options, sameOriginRedirectsOnly = false) {
    const initialUrl = new URL(urlValue);
    let currentUrl = initialUrl;

    for (let redirectCount = 0; redirectCount <= GIPHY_MAX_REDIRECTS; redirectCount++) {
        if (
            currentUrl.protocol !== 'https:' ||
            currentUrl.username ||
            currentUrl.password
        ) {
            throw new Error('GIPHY and media URLs must use HTTPS without credentials.');
        }

        const headers = new Headers(options.headers);
        if (currentUrl.origin !== initialUrl.origin) headers.delete('authorization');
        const response = await fetch(currentUrl, {
            ...options,
            headers,
            redirect: 'manual'
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) return response;

        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirectCount === GIPHY_MAX_REDIRECTS) {
            throw new Error('GIPHY returned an invalid or excessive redirect.');
        }
        const nextUrl = new URL(location, currentUrl);
        if (sameOriginRedirectsOnly && nextUrl.origin !== initialUrl.origin) {
            throw new Error('GIPHY API redirected to an unexpected origin.');
        }
        currentUrl = nextUrl;
    }

    throw new Error('GIPHY returned an excessive redirect.');
}

async function readResponseBuffer(response, maxBytes) {
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw new Error(`GIPHY response exceeds the ${maxBytes}-byte size limit.`);
    }

    if (!response.body) throw new Error('GIPHY returned an empty response.');
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            totalBytes += value.byteLength;
            if (totalBytes > maxBytes) {
                await reader.cancel();
                throw new Error(`GIPHY response exceeds the ${maxBytes}-byte size limit.`);
            }
            chunks.push(Buffer.from(value));
        }
    } finally {
        reader.releaseLock();
    }

    if (!totalBytes) throw new Error('GIPHY returned an empty response.');
    return Buffer.concat(chunks, totalBytes);
}

function isValidMp4Buffer(buffer) {
    return buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp';
}

async function fetchRandomMeme() {
    if (!GIPHY_API_KEY) throw new Error('GIPHY_API_KEY is not configured.');

    const apiUrl = new URL('https://api.giphy.com/v1/gifs/random');
    apiUrl.searchParams.set('api_key', GIPHY_API_KEY);
    apiUrl.searchParams.set('tag', GIPHY_TAG);
    apiUrl.searchParams.set('rating', 'g');
    apiUrl.searchParams.set('bundle', 'messaging_non_clips');

    const signal = AbortSignal.timeout(GIPHY_REQUEST_TIMEOUT_MS);
    const apiResponse = await fetchHttpsResponse(
        apiUrl,
        { headers: { accept: 'application/json' }, signal },
        true
    );
    if (!apiResponse.ok) {
        throw new Error(`GIPHY API returned HTTP ${apiResponse.status}.`);
    }
    const apiContentType = apiResponse.headers.get('content-type')
        ?.split(';', 1)[0]
        .trim()
        .toLowerCase();
    if (
        apiContentType !== 'application/json' &&
        !/^application\/[^/;]+\+json$/.test(apiContentType || '')
    ) {
        throw new Error('GIPHY API did not return JSON.');
    }

    let giphyData;
    const apiBody = await readResponseBuffer(apiResponse, GIPHY_API_MAX_RESPONSE_BYTES);
    try {
        giphyData = JSON.parse(apiBody.toString('utf8'));
    } catch (error) {
        throw new Error('GIPHY API returned invalid JSON.', { cause: error });
    }
    if (!isRecord(giphyData) || !isRecord(giphyData.data) || !isRecord(giphyData.data.images)) {
        throw new Error('GIPHY API response did not contain GIF renditions.');
    }

    const gifVideoUrl = giphyData.data.images.fixed_height?.mp4 ||
        giphyData.data.images.original_mp4?.mp4;
    if (typeof gifVideoUrl !== 'string' || !gifVideoUrl.trim()) {
        throw new Error('GIPHY did not return an MP4 rendition for this GIF.');
    }

    let videoUrl;
    try {
        videoUrl = new URL(gifVideoUrl);
    } catch {
        throw new Error('GIPHY returned an invalid MP4 URL.');
    }
    if (videoUrl.protocol !== 'https:' || videoUrl.username || videoUrl.password) {
        throw new Error('GIPHY MP4 URLs must use HTTPS and must not contain credentials.');
    }

    const videoResponse = await fetchHttpsResponse(videoUrl, {
        headers: { accept: 'video/mp4' },
        signal
    });
    if (!videoResponse.ok) {
        throw new Error(`GIPHY media host returned HTTP ${videoResponse.status}.`);
    }

    const mimeType = videoResponse.headers.get('content-type')
        ?.split(';', 1)[0]
        .trim()
        .toLowerCase();
    if (mimeType !== 'video/mp4') {
        throw new Error('GIPHY rendition must be an MP4 video.');
    }

    const video = await readResponseBuffer(videoResponse, GIPHY_MEDIA_MAX_BYTES);
    if (!isValidMp4Buffer(video)) {
        throw new Error('GIPHY response content is not a valid MP4 file.');
    }

    return {
        video,
        caption: typeof giphyData.data.title === 'string'
            ? [giphyData.data.title.trim(), 'via GIPHY'].filter(Boolean).join('\n').slice(0, 1000)
            : 'via GIPHY'
    };
}

function getUsableResourceLink(resource) {
    if (typeof resource?.link !== 'string') return undefined;

    try {
        const url = new URL(resource.link.trim());
        return url.protocol === 'http:' || url.protocol === 'https:'
            ? url.toString()
            : undefined;
    } catch {
        return undefined;
    }
}

function updateResourceLink(subject, link) {
    const update = botDataUpdateQueue.then(async () => {
        const data = JSON.parse(await readFile(BOT_DATA_FILE, 'utf8'));
        if (!isRecord(data)) {
            throw new Error('bot-data.json must contain a JSON object.');
        }
        if (data.resources === undefined) data.resources = [];
        if (!Array.isArray(data.resources)) {
            throw new Error('The resources property in bot-data.json must be an array.');
        }

        const existingResource = data.resources.find(resource =>
            isRecord(resource) &&
            typeof resource.subject === 'string' &&
            resource.subject.trim().toLowerCase() === subject.toLowerCase()
        );
        const resourceSubject = existingResource?.subject.trim() || subject;
        if (existingResource) {
            existingResource.link = link;
        } else {
            data.resources.push({ subject: resourceSubject, link });
        }

        const temporaryFile = new URL('./bot-data.json.tmp', import.meta.url);
        try {
            await writeFile(temporaryFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
            await rename(temporaryFile, BOT_DATA_FILE);
        } catch (error) {
            await unlink(temporaryFile).catch(() => {});
            throw error;
        }

        return { created: !existingResource, subject: resourceSubject };
    });

    botDataUpdateQueue = update.catch(() => {});
    return update;
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
                const savedGameAccounts = isRecord(data) && isRecord(data.gameAccounts)
                    ? data.gameAccounts
                    : {};
                const gameAccounts = {};
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

                for (const [groupJid, groupAccounts] of Object.entries(savedGameAccounts)) {
                    if (!isGroupJid(groupJid) || !isRecord(groupAccounts)) continue;

                    const validAccounts = {};
                    for (const [userJid, account] of Object.entries(groupAccounts)) {
                        if (
                            normalizeBlockedUserJid(userJid) !== userJid ||
                            !isRecord(account)
                        ) {
                            continue;
                        }
                        validAccounts[userJid] = createGameAccount(account);
                    }
                    if (Object.keys(validAccounts).length) gameAccounts[groupJid] = validAccounts;
                }

                botState = {
                    quizScores,
                    quizQuestionHistory: Array.isArray(data?.quizQuestionHistory)
                        ? data.quizQuestionHistory.filter(question => typeof question === 'string')
                        : [],
                    gameAccounts,
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
                    gameAccounts: {},
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

function transactGameState(updateState) {
    const transaction = gameUpdateQueue.then(async () => {
        const previousGameAccounts = botState.gameAccounts;
        botState.gameAccounts = structuredClone(previousGameAccounts);

        try {
            const result = updateState();
            await persistBotState();
            return result;
        } catch (error) {
            botState.gameAccounts = previousGameAccounts;
            throw error;
        }
    });

    gameUpdateQueue = transaction.catch(() => {});
    return transaction;
}

function getGameGroupAccounts(groupJid) {
    if (!isRecord(botState.gameAccounts[groupJid])) botState.gameAccounts[groupJid] = {};
    return botState.gameAccounts[groupJid];
}

function playCseGame(groupJid, userJid, displayName, game) {
    if (!GAME_TYPES.includes(game)) throw new Error(`Unknown game type: ${game}`);
    return transactGameState(() =>
        playGameTurn(getGameGroupAccounts(groupJid), userJid, displayName, game)
    );
}

function transferGamePoints(groupJid, senderJid, recipientJid, senderName, amount) {
    return transactGameState(() =>
        applyGamePointTransfer(
            getGameGroupAccounts(groupJid),
            senderJid,
            recipientJid,
            senderName,
            amount
        )
    );
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

function formatCseGameMenu() {
    return [
        '🎮 *CSE Mini-Games*',
        '• `CR games` — show this game guide.',
        '• `CR hunt` — explore campus for study gear and lab finds.',
        '• `CR dig` — uncover notes, devices, and hidden CSE treasures.',
        '• Each game has 14 weighted outcomes and rewards from 0–60 🪙 CSE Coins.',
        `• Daily limit per member: ${GAME_DAILY_ATTEMPT_LIMIT} hunt and ${GAME_DAILY_ATTEMPT_LIMIT} dig tries in each group.`,
        '• Tries reset at midnight using the bot host local time.',
        '• `CR wallet` — check your coin balance and tries used today.',
        '• `CR leaderboard` — see the top five balances in this group.',
        '• `CR transfer @mention <amount>` — transfer coins to another member.',
        '',
        'Balances are separate per group. CSE Coins are fictional and have no cash value.'
    ].join('\n');
}

function formatCseLeaderboard(accounts) {
    const leaders = getGameLeaderboard(accounts);
    if (!leaders.length) return '🪙 No CSE Coins have been earned in this group yet. Try `CR hunt` or `CR dig`.';
    const rankEmojis = ['🥇', '🥈', '🥉'];

    return [
        '🏆 *CSE Game Leaderboard*',
        ...leaders.map(([userJid, account], index) =>
            `${rankEmojis[index] || `${index + 1}.`} ${account.name || `Classmate ${userJid.split('@')[0]}`} — ${account.balance} 🪙`
        )
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
            '📖 *Discussion Group Command Guide*',
            '',
            '*Quick commands*',
            '• `CR` (default reply)',
            '• `CR help`',
            '• `CR menu` (academic info, bus schedules, resources, and games)',
            '• `CR myid` (show your WhatsApp JID)',
            textCommands,
            '',
            '📚 *Study resources*',
            '• `CR rsrc` (browse resources)',
            '• `CR rsrc <subject>` (open a subject resource)',
            '',
            formatCseGameMenu(),
            '',
            '🧠 *Quiz*',
            '• `CR quiz`',
            '• `CR score`',
            '',
            '🎞️ *GIFs and fun*',
            '• `CR meme` (fetch a G-rated GIF)',
            '',
            '🗓️ *Schedule images*',
            imageCommands
        ].filter(Boolean).join('\n');
    }

    return [
        '*Mod group full command manual*',
        '',
        '*General*',
        '• `CR` (default reply)',
        '• `CR help`',
        '• `CR menu` (academic info, bus schedules, resources, and games)',
        '• `CR myid` (show your WhatsApp JID)',
        textCommands,
        '',
        '📚 *Resources*',
        '• `CR rsrc` (browse resources)',
        '• `CR rsrc <subject>` (open a subject resource)',
        '• `CR rsrc set <subject> <https://link>` (mod groups and bot admins)',
        '',
        formatCseGameMenu(),
        '',
        '🧠 *Quiz*',
        '• `CR quiz` (Discussion and mod groups)',
        '• `CR score` (Discussion and mod groups)',
        '',
        '🎞️ *GIFs and fun*',
        '• `CR meme` (fetch a G-rated GIF)',
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

function formatCrMenu({ commands, images, resources }) {
    const academicCommands = Object.keys(commands)
        .filter(command => !/^bus-/i.test(command));
    const busCommands = Object.keys(images)
        .filter(command => /^bus-/i.test(command));
    const availableResources = resources
        .filter(resource => getUsableResourceLink(resource))
        .map(resource => resource.subject);
    const comingSoonResources = resources
        .filter(resource => !getUsableResourceLink(resource))
        .map(resource => resource.subject);

    return [
        '🧭 *CSE Quick Menu*',
        '',
        '🎓 *Academic information*',
        ...(academicCommands.length
            ? academicCommands.map(command => `• \`CR ${command}\``)
            : ['• No academic shortcuts are configured yet.']),
        '',
        '🚌 *Bus schedules*',
        ...(busCommands.length
            ? busCommands.map(command => `• \`CR ${command}\``)
            : ['• No bus schedule shortcuts are configured yet.']),
        '',
        '📚 *Study resources*',
        '• Browse: `CR rsrc`',
        '• Open a subject directly: `CR rsrc <subject>` (example: `CR rsrc DS`)',
        availableResources.length
            ? `• Links available: ${availableResources.join(', ')}`
            : '• No resource links are available yet.',
        ...(comingSoonResources.length
            ? [`• Coming soon: ${comingSoonResources.join(', ')}`]
            : []),
        '',
        formatCseGameMenu(),
        '',
        '🧠 *Quiz*',
        '• `CR quiz` (start a quiz in the Discussion group)',
        '• `CR score` (view quiz scores)',
        '',
        '🎞️ *GIFs and fun*',
        '• `CR meme` (fetch a G-rated GIF)'
    ].join('\n');
}

function formatResourceMenu(resources) {
    const lines = resources.map((resource, index) => {
        const status = getUsableResourceLink(resource) ? 'available' : 'coming soon';
        return `• ${index}. ${resource.subject} — ${status}`;
    });
    return [
        '*Study resources*',
        ...lines,
        '',
        'Reply with a number to open a resource, or use `CR rsrc <subject>`.'
    ].join('\n');
}

function formatResourceReply(resource) {
    const link = getUsableResourceLink(resource);
    return link
        ? `${resource.subject}: ${link}`
        : `${resource.subject} is not available yet. Ask a mod to add the resource link.`;
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

            if (/^\s*CR\s+rsrc\s+set(?:\s|$)/i.test(text) && !canManageBot) {
                await sock.sendMessage(
                    senderJid,
                    { text: 'Only configured mod groups and bot admins can add or update resource links.' },
                    { quoted: m }
                );
                continue;
            }

            if (canManageBot) {
                if (/^\s*CR\s+rsrc\s+set(?:\s|$)/i.test(text)) {
                    const resourceUpdateMatch = text.match(
                        /^\s*CR\s+rsrc\s+set\s+([\s\S]+?)\s+(https?:\/\/\S+)\s*$/i
                    );
                    const subject = resourceUpdateMatch?.[1]
                        .trim()
                        .replace(/\s+/g, ' ');
                    const link = resourceUpdateMatch
                        ? getUsableResourceLink({ link: resourceUpdateMatch[2] })
                        : undefined;

                    if (!subject || subject.length > 80 || !link) {
                        await sock.sendMessage(
                            senderJid,
                            { text: 'Usage: CR rsrc set <subject> <https://link> (subject must be 1-80 characters).' },
                            { quoted: m }
                        );
                        continue;
                    }

                    try {
                        const result = await updateResourceLink(subject, link);
                        await sock.sendMessage(
                            senderJid,
                            { text: `${result.created ? 'Added' : 'Updated'} the ${result.subject} resource link.` },
                            { quoted: m }
                        );
                    } catch (error) {
                        console.error('Could not save the resource link:', error);
                        await sock.sendMessage(
                            senderJid,
                            { text: 'Could not save the resource link. Check bot-data.json and try again.' },
                            { quoted: m }
                        );
                    }
                    continue;
                }

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
                const choiceText = text.trim();
                const choice = /^\d+$/.test(choiceText) ? Number(choiceText) : -1;

                if (Number.isInteger(choice) && choice >= 0 && choice < pendingResources.length) {
                    const selected = pendingResources[choice];
                    await sock.sendMessage(
                        senderJid,
                        { text: formatResourceReply(selected) },
                        { quoted: m }
                    );
                    resourceSelectionState.delete(senderJid);
                    continue;
                }

                resourceSelectionState.delete(senderJid);
                if (!/^\s*CR\b/i.test(text)) {
                    await sock.sendMessage(
                        senderJid,
                        { text: 'Invalid choice. Please reply with a valid number from the resource list.' },
                        { quoted: m }
                    );
                    continue;
                }
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

                if (chainedCommand === 'menu') {
                    const resources = crReplies.resources.filter(
                        resource => isRecord(resource) &&
                            typeof resource.subject === 'string' &&
                            resource.subject.trim()
                    );
                    await sock.sendMessage(
                        senderJid,
                        { text: formatCrMenu({ ...crReplies, resources }) },
                        { quoted: m }
                    );
                    continue;
                }

                if (chainedCommand === 'meme') {
                    if (!GIPHY_API_KEY) {
                        await sock.sendMessage(
                            senderJid,
                            { text: 'The GIPHY meme feature is not configured yet. Ask a bot admin to set GIPHY_API_KEY.' },
                            { quoted: m }
                        );
                        continue;
                    }

                    try {
                        const meme = await fetchRandomMeme();
                        await sock.sendMessage(
                            senderJid,
                            {
                                video: meme.video,
                                mimetype: 'video/mp4',
                                gifPlayback: true,
                                caption: meme.caption
                            },
                            { quoted: m }
                        );
                    } catch (error) {
                        console.error('Could not fetch or send a GIPHY GIF:', error.message);
                        await sock.sendMessage(
                            senderJid,
                            { text: 'Could not fetch a GIF right now. GIPHY may be unavailable or over its request limit; try again later.' },
                            { quoted: m }
                        );
                    }
                    continue;
                }

                if (chainedCommand === 'game' || chainedCommand === 'games') {
                    if (!isGroupJid(senderJid) || (!isAllowedGroup && !isModGroup)) {
                        await sock.sendMessage(
                            senderJid,
                            { text: 'CSE games are available only in the configured department and mod groups.' },
                            { quoted: m }
                        );
                        continue;
                    }
                    await sock.sendMessage(
                        senderJid,
                        { text: formatCseGameMenu() },
                        { quoted: m }
                    );
                    continue;
                }

                if (GAME_TYPES.includes(chainedCommand)) {
                    if (!isGroupJid(senderJid) || (!isAllowedGroup && !isModGroup)) {
                        await sock.sendMessage(
                            senderJid,
                            { text: 'CSE games are available only in the configured department and mod groups.' },
                            { quoted: m }
                        );
                        continue;
                    }
                    if (!senderUserJid) {
                        await sock.sendMessage(
                            senderJid,
                            { text: 'Could not identify your WhatsApp account, so this game turn was not counted.' },
                            { quoted: m }
                        );
                        continue;
                    }

                    try {
                        const result = await playCseGame(
                            senderJid,
                            senderUserJid,
                            m.pushName,
                            chainedCommand
                        );
                        const response = result.played
                            ? `${result.outcome.emoji} ${result.outcome.text}\n+${result.outcome.points} 🪙 CSE Coins\n👛 Wallet: ${result.balance} 🪙\n🎯 ${GAME_DAILY_ATTEMPT_LIMIT - result.attempts} ${chainedCommand} tries left today.`
                            : `🎯 You've used all ${GAME_DAILY_ATTEMPT_LIMIT} ${chainedCommand} tries for today.\n👛 Wallet: ${result.balance} 🪙`;
                        await sock.sendMessage(
                            senderJid,
                            { text: response },
                            { quoted: m }
                        );
                    } catch (error) {
                        console.error(`Could not run the CSE ${chainedCommand} game:`, error);
                        await sock.sendMessage(
                            senderJid,
                            { text: 'Could not save your game result. Your turn was not counted; try again.' },
                            { quoted: m }
                        );
                    }
                    continue;
                }

                if (chainedCommand === 'wallet') {
                    if (!isGroupJid(senderJid) || (!isAllowedGroup && !isModGroup)) {
                        await sock.sendMessage(
                            senderJid,
                            { text: '👛 CSE Coin wallets are available only in the configured department and mod groups.' },
                            { quoted: m }
                        );
                        continue;
                    }
                    if (!senderUserJid) {
                        await sock.sendMessage(
                            senderJid,
                            { text: 'Could not identify your WhatsApp account.' },
                            { quoted: m }
                        );
                        continue;
                    }

                    const account = botState.gameAccounts[senderJid]?.[senderUserJid];
                    const daily = account?.daily?.date === getLocalDayKey()
                        ? account.daily
                        : { hunt: 0, dig: 0 };
                    await sock.sendMessage(
                        senderJid,
                        {
                            text: [
                                `👛 *${sanitizeGameName(m.pushName) || account?.name || 'Your'} CSE Coin wallet*`,
                                `🪙 Balance: ${account?.balance || 0} CSE Coins.`,
                                `🏹 Hunt tries today: ${daily.hunt}/${GAME_DAILY_ATTEMPT_LIMIT}.`,
                                `⛏️ Dig tries today: ${daily.dig}/${GAME_DAILY_ATTEMPT_LIMIT}.`
                            ].join('\n')
                        },
                        { quoted: m }
                    );
                    continue;
                }

                if (chainedCommand === 'leaderboard') {
                    if (!isGroupJid(senderJid) || (!isAllowedGroup && !isModGroup)) {
                        await sock.sendMessage(
                            senderJid,
                            { text: '🏆 The CSE Coin leaderboard is available only in the configured department and mod groups.' },
                            { quoted: m }
                        );
                        continue;
                    }
                    await sock.sendMessage(
                        senderJid,
                        { text: formatCseLeaderboard(botState.gameAccounts[senderJid]) },
                        { quoted: m }
                    );
                    continue;
                }

                if (chainedCommand === 'transfer') {
                    if (!isGroupJid(senderJid) || (!isAllowedGroup && !isModGroup)) {
                        await sock.sendMessage(
                            senderJid,
                            { text: '🪙 CSE Coin transfers are available only in the configured department and mod groups.' },
                            { quoted: m }
                        );
                        continue;
                    }
                    if (!senderUserJid) {
                        await sock.sendMessage(
                            senderJid,
                            { text: 'Could not identify your WhatsApp account.' },
                            { quoted: m }
                        );
                        continue;
                    }

                    const transferMatch = text.match(/^\s*CR\s+transfer\s+(@\S+)\s+(\d+)\s*$/i);
                    const mentionedJids = message.extendedTextMessage?.contextInfo?.mentionedJid || [];
                    const recipientJid = transferMatch && mentionedJids.length === 1
                        ? normalizeBlockedUserJid(mentionedJids[0])
                        : undefined;
                    const amount = transferMatch ? Number(transferMatch[2]) : 0;
                    if (!recipientJid || !Number.isSafeInteger(amount) || amount <= 0) {
                        await sock.sendMessage(
                            senderJid,
                            { text: 'Usage: `CR transfer @mention <positive whole-number amount>`. Mention exactly one group member.' },
                            { quoted: m }
                        );
                        continue;
                    }

                    try {
                        const result = await transferGamePoints(
                            senderJid,
                            senderUserJid,
                            recipientJid,
                            m.pushName,
                            amount
                        );
                        const response = result.transferred
                            ? `💸 Transferred ${amount} 🪙 CSE Coins to the member you mentioned.\n👛 Your balance is now ${result.senderBalance} 🪙.`
                            : result.reason === 'self'
                                ? '🚫 You cannot transfer CSE Coins to yourself.'
                                : result.reason === 'insufficient'
                                    ? `🚫 You only have ${result.balance} 🪙 CSE Coins, so you cannot transfer ${amount}.`
                                    : '🚫 That transfer would exceed the recipient wallet limit.';
                        await sock.sendMessage(
                            senderJid,
                            { text: response },
                            { quoted: m }
                        );
                    } catch (error) {
                        console.error('Could not transfer CSE game points:', error);
                        await sock.sendMessage(
                            senderJid,
                            { text: 'Could not save the transfer. No points were transferred; try again.' },
                            { quoted: m }
                        );
                    }
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
                    const resources = crReplies.resources.filter(
                        resource => isRecord(resource) &&
                            typeof resource.subject === 'string' &&
                            resource.subject.trim()
                    );
                    if (!resources.length) {
                        await sock.sendMessage(
                            senderJid,
                            { text: 'No resources available right now.' },
                            { quoted: m }
                        );
                        continue;
                    }

                    const requestedSubject = text.match(
                        /^\s*CR\s+rsrc(?:\s+([\s\S]*?))?\s*$/i
                    )?.[1]?.trim();
                    if (requestedSubject) {
                        const requestedResource = resources.find(
                            resource => resource.subject.trim().toLowerCase() === requestedSubject.toLowerCase()
                        );
                        await sock.sendMessage(
                            senderJid,
                            {
                                text: requestedResource
                                    ? formatResourceReply(requestedResource)
                                    : `I couldn't find "${requestedSubject}". Browse subjects with \`CR rsrc\`.`
                            },
                            { quoted: m }
                        );
                        continue;
                    }

                    resourceSelectionState.set(senderJid, resources);
                    await sock.sendMessage(
                        senderJid,
                        { text: formatResourceMenu(resources) },
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
