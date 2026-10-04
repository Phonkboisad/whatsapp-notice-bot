import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createGameAccount,
    GAME_DAILY_ATTEMPT_LIMIT,
    getGameOutcomes,
    getGameLeaderboard,
    getLocalDayKey,
    playGameTurn,
    transferGamePoints
} from '../cse-game.js';

const firstDay = new Date(2026, 9, 4, 12);
const secondDay = new Date(2026, 9, 5, 0);

test('hunt and dig each have independent daily attempt limits that reset by local date', () => {
    const accounts = {};

    for (let attempt = 0; attempt < GAME_DAILY_ATTEMPT_LIMIT; attempt++) {
        assert.equal(playGameTurn(accounts, '123456@s.whatsapp.net', 'CSE Student', 'hunt', firstDay, () => 0).played, true);
    }
    assert.deepEqual(
        playGameTurn(accounts, '123456@s.whatsapp.net', 'CSE Student', 'hunt', firstDay, () => 0),
        { played: false, attempts: GAME_DAILY_ATTEMPT_LIMIT, balance: 0 }
    );
    assert.equal(playGameTurn(accounts, '123456@s.whatsapp.net', 'CSE Student', 'dig', firstDay, () => 0).played, true);
    assert.equal(playGameTurn(accounts, '123456@s.whatsapp.net', 'CSE Student', 'hunt', secondDay, () => 0).attempts, 1);
    assert.equal(accounts['123456@s.whatsapp.net'].daily.date, getLocalDayKey(secondDay));
});

test('game outcomes award their configured points and sanitize member names', () => {
    const accounts = {};
    const result = playGameTurn(
        accounts,
        '123456@s.whatsapp.net',
        '  CSE\n Student  ',
        'dig',
        firstDay,
        () => 0.99
    );

    assert.equal(result.outcome.points, 60);
    assert.equal(result.balance, 60);
    assert.match(result.outcome.emoji, /\p{Extended_Pictographic}/u);
    assert.equal(accounts['123456@s.whatsapp.net'].name, 'CSE Student');
    assert.throws(() => playGameTurn(accounts, '123456@s.whatsapp.net', '', 'unknown', firstDay), /Unknown game type/);
});

test('hunt and dig each have ten extra emoji-tagged weighted outcomes', () => {
    for (const game of ['hunt', 'dig']) {
        const outcomes = getGameOutcomes(game);
        assert.equal(outcomes.length, 14);
        assert.ok(outcomes.every(outcome =>
            typeof outcome.text === 'string' &&
            /\p{Extended_Pictographic}/u.test(outcome.emoji) &&
            Number.isSafeInteger(outcome.points) &&
            outcome.points >= 0 &&
            Number.isFinite(outcome.weight) &&
            outcome.weight > 0
        ));
    }
    assert.throws(() => getGameOutcomes('unknown'), /Unknown game type/);
});

test('point transfers reject self/invalid/insufficient transfers and preserve total points', () => {
    const accounts = {};
    playGameTurn(accounts, 'sender@s.whatsapp.net', 'Sender', 'hunt', firstDay, () => 0.99);

    assert.deepEqual(
        transferGamePoints(accounts, 'sender@s.whatsapp.net', 'sender@s.whatsapp.net', 'Sender', 5, firstDay),
        { transferred: false, reason: 'self' }
    );
    assert.deepEqual(
        transferGamePoints(accounts, 'sender@s.whatsapp.net', 'recipient@s.whatsapp.net', 'Sender', 0, firstDay),
        { transferred: false, reason: 'invalid-amount' }
    );
    assert.deepEqual(
        transferGamePoints(accounts, 'sender@s.whatsapp.net', 'recipient@s.whatsapp.net', 'Sender', 61, firstDay),
        { transferred: false, reason: 'insufficient', balance: 60 }
    );

    const result = transferGamePoints(
        accounts,
        'sender@s.whatsapp.net',
        'recipient@s.whatsapp.net',
        'Sender',
        7,
        firstDay
    );
    assert.equal(result.transferred, true);
    assert.equal(result.senderBalance, 53);
    assert.equal(result.recipientBalance, 7);
    assert.equal(accounts['sender@s.whatsapp.net'].balance + accounts['recipient@s.whatsapp.net'].balance, 60);
});

test('saved account validation and leaderboard ordering are bounded', () => {
    assert.deepEqual(createGameAccount({
        name: '\u0000Student',
        balance: -10,
        daily: { date: 'not-a-date', hunt: 500, dig: 2 }
    }), {
        name: 'Student',
        balance: 0,
        daily: { date: '', hunt: 0, dig: 2 }
    });

    const leaders = getGameLeaderboard({
        '1@s.whatsapp.net': { name: 'Ada', balance: 20 },
        '2@s.whatsapp.net': { name: 'Bea', balance: 25 },
        '3@s.whatsapp.net': { name: 'Cal', balance: 10 },
        '4@s.whatsapp.net': { name: 'Invalid', balance: -1 }
    }, 2);
    assert.deepEqual(leaders.map(([, account]) => account.name), ['Bea', 'Ada']);
});
