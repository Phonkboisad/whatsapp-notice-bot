export const GAME_DAILY_ATTEMPT_LIMIT = 10;
export const GAME_TYPES = ['hunt', 'dig'];

const GAME_OUTCOMES = {
    hunt: [
        { text: 'You chased a bug into the lab and found nothing.', emoji: '🐛', points: 0, weight: 3 },
        { text: 'You caught a runaway USB drive.', emoji: '🔌', points: 5, weight: 4 },
        { text: 'You found a clean set of lecture notes.', emoji: '📚', points: 10, weight: 2 },
        { text: 'You recovered the missing lab equipment!', emoji: '🧰', points: 20, weight: 1 },
        { text: 'You found a spare lab coat.', emoji: '🥼', points: 3, weight: 0.25 },
        { text: 'You rescued a lost calculator before the exam.', emoji: '🧮', points: 4, weight: 0.25 },
        { text: 'You tracked down a useful debugging checklist.', emoji: '🐞', points: 6, weight: 0.25 },
        { text: 'You found a fresh pack of whiteboard markers.', emoji: '🖊️', points: 8, weight: 0.25 },
        { text: 'You discovered a quiet study spot in the department.', emoji: '🤫', points: 12, weight: 0.25 },
        { text: 'You fixed a stubborn compiler warning for a classmate.', emoji: '🛠️', points: 15, weight: 0.25 },
        { text: 'You recovered a forgotten project backup.', emoji: '💾', points: 25, weight: 0.25 },
        { text: 'You found the last working HDMI adapter in the lab.', emoji: '🖥️', points: 30, weight: 0.25 },
        { text: 'You helped debug a project right before submission.', emoji: '🧑‍💻', points: 40, weight: 0.25 },
        { text: 'You found a sealed box of department goodies!', emoji: '🎁', points: 60, weight: 0.25 }
    ],
    dig: [
        { text: 'You dug up an old null pointer. No points this time.', emoji: '🕳️', points: 0, weight: 3 },
        { text: 'You found a spare notebook.', emoji: '📓', points: 5, weight: 4 },
        { text: 'You uncovered a useful past paper.', emoji: '📝', points: 10, weight: 2 },
        { text: 'You discovered a buried cache of lab credits!', emoji: '🏆', points: 20, weight: 1 },
        { text: 'You uncovered a handful of lost coins.', emoji: '🪙', points: 3, weight: 0.25 },
        { text: 'You found a packet of sticky notes.', emoji: '📌', points: 4, weight: 0.25 },
        { text: 'You dug up a missing mouse from the lab drawer.', emoji: '🖱️', points: 6, weight: 0.25 },
        { text: 'You unearthed a clean set of algorithm notes.', emoji: '📚', points: 8, weight: 0.25 },
        { text: 'You found an old hard drive with useful references.', emoji: '💽', points: 12, weight: 0.25 },
        { text: 'You uncovered a forgotten logic puzzle.', emoji: '🧩', points: 15, weight: 0.25 },
        { text: 'You found a box of spare cables and adapters.', emoji: '🔗', points: 25, weight: 0.25 },
        { text: 'You dug up a vintage laptop that still boots!', emoji: '💻', points: 30, weight: 0.25 },
        { text: 'You discovered an archived solution set.', emoji: '🗂️', points: 40, weight: 0.25 },
        { text: 'You struck a shiny cache of rare lab parts!', emoji: '💎', points: 60, weight: 0.25 }
    ]
};

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function getLocalDayKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export function sanitizeGameName(value) {
    return typeof value === 'string'
        ? value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40)
        : '';
}

export function getGameOutcomes(game) {
    if (!Object.hasOwn(GAME_OUTCOMES, game)) throw new Error(`Unknown game type: ${game}`);
    return GAME_OUTCOMES[game].map(outcome => ({ ...outcome }));
}

export function createGameAccount(value) {
    const daily = isRecord(value?.daily) ? value.daily : {};
    return {
        name: sanitizeGameName(value?.name) || 'Classmate',
        balance: Number.isSafeInteger(value?.balance) && value.balance >= 0 ? value.balance : 0,
        daily: {
            date: typeof daily.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(daily.date)
                ? daily.date
                : '',
            hunt: Number.isInteger(daily.hunt) && daily.hunt >= 0 && daily.hunt <= GAME_DAILY_ATTEMPT_LIMIT
                ? daily.hunt
                : 0,
            dig: Number.isInteger(daily.dig) && daily.dig >= 0 && daily.dig <= GAME_DAILY_ATTEMPT_LIMIT
                ? daily.dig
                : 0
        }
    };
}

function ensureGameAccount(accounts, userJid, displayName, date) {
    const account = createGameAccount(accounts[userJid]);
    const today = getLocalDayKey(date);
    if (account.daily.date !== today) {
        account.daily = { date: today, hunt: 0, dig: 0 };
    }

    const name = sanitizeGameName(displayName);
    if (name) account.name = name;
    accounts[userJid] = account;
    return account;
}

export function playGameTurn(accounts, userJid, displayName, game, date = new Date(), random = Math.random) {
    if (!GAME_TYPES.includes(game)) throw new Error(`Unknown game type: ${game}`);
    const account = ensureGameAccount(accounts, userJid, displayName, date);
    if (account.daily[game] >= GAME_DAILY_ATTEMPT_LIMIT) {
        return { played: false, attempts: account.daily[game], balance: account.balance };
    }

    const outcomes = GAME_OUTCOMES[game];
    const totalWeight = outcomes.reduce((total, outcome) => total + outcome.weight, 0);
    let roll = random() * totalWeight;
    let outcome = outcomes.at(-1);
    for (const candidate of outcomes) {
        roll -= candidate.weight;
        if (roll < 0) {
            outcome = candidate;
            break;
        }
    }

    if (!Number.isSafeInteger(account.balance + outcome.points)) {
        throw new Error('Game point balance has reached its safe storage limit.');
    }

    account.daily[game]++;
    account.balance += outcome.points;
    return { played: true, outcome, attempts: account.daily[game], balance: account.balance };
}

export function transferGamePoints(accounts, senderJid, recipientJid, senderName, amount, date = new Date()) {
    if (senderJid === recipientJid) return { transferred: false, reason: 'self' };
    if (!Number.isSafeInteger(amount) || amount <= 0) {
        return { transferred: false, reason: 'invalid-amount' };
    }

    const sender = ensureGameAccount(accounts, senderJid, senderName, date);
    if (sender.balance < amount) {
        return { transferred: false, reason: 'insufficient', balance: sender.balance };
    }

    const recipient = ensureGameAccount(accounts, recipientJid, undefined, date);
    if (!Number.isSafeInteger(recipient.balance + amount)) {
        return { transferred: false, reason: 'recipient-limit' };
    }

    sender.balance -= amount;
    recipient.balance += amount;
    return {
        transferred: true,
        senderBalance: sender.balance,
        recipientBalance: recipient.balance
    };
}

export function getGameLeaderboard(accounts, limit = 5) {
    return Object.entries(accounts || {})
        .filter(([, account]) =>
            isRecord(account) &&
            typeof account.name === 'string' &&
            Number.isSafeInteger(account.balance) &&
            account.balance >= 0
        )
        .sort(([, left], [, right]) =>
            right.balance - left.balance || left.name.localeCompare(right.name)
        )
        .slice(0, limit);
}
