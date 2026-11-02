import assert from 'node:assert/strict';
import test from 'node:test';
import {
    applyRoutineOverride,
    formatRoutine,
    formatWeeklyRoutine,
    groupRoutineEntries,
    getDateWeekday,
    getRoutineDisplayDate,
    getRoutineTargetDate,
    getRoutineForDate,
    makeMentionList,
    normalizeRoutineConfig,
    parsePeriodSelection,
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
    assert.equal(entries[0].start, '10:50');
    assert.equal(entries[3].id, 'break');
    assert.equal(entries[3].class, 'Break');
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
    assert.match(text, /10:50 AM–11:30 AM/);
    assert.match(text, /CLASS LINEUP/);
    assert.doesNotMatch(text, /Break/);
});

test('groups adjacent identical classes into one long period', () => {
    const entries = getRoutineForDate(config, '2026-11-02');
    entries[1] = { ...entries[1], class: 'Software Development', room: 'CX402' };
    entries[2] = { ...entries[2], class: 'Software Development', room: 'CX402' };
    const groups = groupRoutineEntries(entries);
    const softwareGroup = groups.find(group => group.class === 'Software Development');
    assert.deepEqual(
        [softwareGroup.periodStart, softwareGroup.periodEnd, softwareGroup.start, softwareGroup.end],
        ['2', '3', '11:30', '13:10']
    );
    assert.match(formatRoutine('2026-11-02', entries), /P2-3/);
});

test('parses only ascending single periods or consecutive ranges', () => {
    assert.deepEqual(parsePeriodSelection('5'), ['5']);
    assert.deepEqual(parsePeriodSelection('5-6'), ['5', '6']);
    assert.equal(parsePeriodSelection('6-5'), undefined);
    assert.equal(parsePeriodSelection('2-7'), undefined);
});

test('targets today only during the inclusive daytime command window', () => {
    const atTen = Date.parse('2026-11-02T10:00:00+06:00');
    const atEnd = Date.parse('2026-11-02T16:20:00+06:00');
    const afterEnd = Date.parse('2026-11-02T16:21:00+06:00');
    assert.equal(getRoutineTargetDate(atTen), '2026-11-02');
    assert.equal(getRoutineTargetDate(atEnd), '2026-11-02');
    assert.equal(getRoutineTargetDate(afterEnd), '2026-11-03');
    assert.equal(getRoutineDisplayDate(Date.parse('2026-11-02T15:59:00+06:00')), '2026-11-02');
    assert.equal(getRoutineDisplayDate(Date.parse('2026-11-02T16:00:00+06:00')), '2026-11-03');
});

test('formats a complete weekly routine', () => {
    const weekly = formatWeeklyRoutine(config);
    assert.match(weekly, /CLASS LINEUP/);
    assert.match(weekly, /Monday/);
    assert.doesNotMatch(weekly, /Thursday/);
});
