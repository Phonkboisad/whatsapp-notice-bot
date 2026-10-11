import assert from 'node:assert/strict';
import test from 'node:test';
import {
    AKINATOR_ANSWER_CHOICES,
    formatAkinatorQuestion,
    parseAkinatorAnswer,
    parseAkinatorConfirmation
} from '../akinator-game.js';

test('parses numbered Akinator answers without accepting arbitrary text', () => {
    assert.deepEqual(
        [1, 2, 3, 4, 5].map(value => parseAkinatorAnswer(String(value))),
        [0, 1, 2, 3, 4]
    );
    assert.equal(parseAkinatorAnswer('0'), undefined);
    assert.equal(parseAkinatorAnswer('6'), undefined);
    assert.equal(parseAkinatorAnswer('yes'), undefined);
});

test('parses final confirmations and formats all five choices', () => {
    assert.equal(parseAkinatorConfirmation('YES'), true);
    assert.equal(parseAkinatorConfirmation('no'), false);
    assert.equal(parseAkinatorConfirmation('maybe'), undefined);

    const question = formatAkinatorQuestion({
        currentStep: 0,
        question: 'Is your character real?'
    });
    assert.match(question, /Is your character real/);
    for (const [index, choice] of AKINATOR_ANSWER_CHOICES.entries()) {
        assert.match(question, new RegExp(`${index + 1}\\. ${choice.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    }
});
