import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDhakaDeadlineInput } from '../deadline-utils.js';

test('parses one-digit month and day as a Dhaka timestamp', () => {
    assert.equal(
        parseDhakaDeadlineInput('2026-11-1', '13:50'),
        Date.parse('2026-11-01T13:50:00+06:00')
    );
});

test('parses two-digit month and day and defaults the time', () => {
    assert.equal(
        parseDhakaDeadlineInput('2026-11-02'),
        Date.parse('2026-11-02T09:00:00+06:00')
    );
});

test('rejects invalid calendar and clock values', () => {
    assert.equal(parseDhakaDeadlineInput('2026-02-30', '13:50'), undefined);
    assert.equal(parseDhakaDeadlineInput('2026-11-01', '24:00'), undefined);
});
