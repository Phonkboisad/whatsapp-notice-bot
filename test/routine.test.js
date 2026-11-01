import assert from 'node:assert/strict';
import test from 'node:test';
import {
    applyRoutineOverride,
    formatRoutine,
    getDateWeekday,
    getRoutineForDate,
    makeMentionList,
    normalizeRoutineConfig,
    ROUTINE_PERIODS
} from '../routine.js';

const config = normalizeRoutineConfig({
    noClassDays: ['Thursday'],
    days: {
        Monday: {
            1: { class: 'Data Structures', room: 'CX404' },
            2: { class: 'Software Development', room: 'CX402' }
        }
    }
});

test('selects a weekday routine and preserves period times', () => {
    assert.equal(getDateWeekday('2026-11-02'), 'Monday');
    const entries = getRoutineForDate(config, '2026-11-02');
    assert.equal(entries.length, ROUTINE_PERIODS.length);
    assert.equal(entries[0].class, 'Data Structures');
    assert.equal(entries[0].start, '10:30');
});

test('applies room and cancellation overrides without mutating the base routine', () => {
    const overrides = {};
    applyRoutineOverride(overrides, '2026-11-02', '1', { room: 'CX999' });
    applyRoutineOverride(overrides, '2026-11-02', '2', { cancelled: true });
    const entries = getRoutineForDate(config, '2026-11-02', overrides);
    assert.equal(entries[0].room, 'CX999');
    assert.equal(entries[1].cancelled, true);
    assert.equal(entries[1].class, 'Cancelled');
    assert.equal(config.days.Monday['1'].room, 'CX404');
});

test('deduplicates all-group mention participants', () => {
    assert.deepEqual(
        makeMentionList([{ id: '1@s.whatsapp.net' }, { id: '1@s.whatsapp.net' }, '2@s.whatsapp.net']),
        ['1@s.whatsapp.net', '2@s.whatsapp.net']
    );
});

test('formats an unconfirmed routine warning', () => {
    const text = formatRoutine('2026-11-02', getRoutineForDate(config, '2026-11-02'), true);
    assert.match(text, /Published without CR\/ACR confirmation/);
    assert.match(text, /Data Structures/);
});
