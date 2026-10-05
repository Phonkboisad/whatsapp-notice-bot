import assert from 'node:assert/strict';
import test from 'node:test';
import {
    getHermesAllowedCommands,
    getHermesConfig,
    resolveHermesCommand
} from '../hermes-agent.js';

const config = {
    apiUrl: 'https://hermes.example/v1/chat/completions',
    apiKey: 'test-secret',
    model: 'hermes-test'
};

function completion(command, status = 200) {
    return new Response(JSON.stringify({
        choices: [{
            message: {
                content: JSON.stringify({ command })
            }
        }]
    }), { status });
}

test('Hermes configuration reads trimmed environment values', () => {
    assert.deepEqual(getHermesConfig({
        HERMES_API_URL: ' https://hermes.example/v1/chat/completions ',
        HERMES_API_KEY: ' test-secret ',
        HERMES_MODEL: ' hermes-test '
    }), config);
});

test('allowlist includes configured commands and excludes privileged or invalid names', () => {
    assert.deepEqual(
        getHermesAllowedCommands(
            ['routine', 'run', 'admin', 'bad command', 'transfer'],
            ['bus-class']
        ),
        ['bus-class', 'dig', 'game', 'games', 'help', 'hunt', 'leaderboard', 'meme',
            'menu', 'quiz', 'routine', 'rsrc', 'score', 'wallet']
    );
});

test('sends an authenticated structured request and returns an allowlisted command', async () => {
    let requestUrl;
    let requestOptions;
    const command = await resolveHermesCommand({
        ...config,
        request: 'give me the class routine',
        allowedCommands: ['routine', 'run'],
        fetchImpl: async (url, options) => {
            requestUrl = url;
            requestOptions = options;
            return completion('routine');
        }
    });

    assert.equal(command, 'routine');
    assert.equal(requestUrl, config.apiUrl);
    assert.equal(requestOptions.headers.authorization, 'Bearer test-secret');
    assert.equal(requestOptions.redirect, 'error');
    const payload = JSON.parse(requestOptions.body);
    assert.equal(payload.model, 'hermes-test');
    assert.deepEqual(payload.response_format, { type: 'json_object' });
    assert.deepEqual(payload.messages[1], {
        role: 'user',
        content: 'give me the class routine'
    });
    assert.match(payload.messages[0].content, /"routine"/);
    assert.doesNotMatch(payload.messages[0].content, /"run"/);
});

test('accepts an explicit no-match selection', async () => {
    const command = await resolveHermesCommand({
        ...config,
        request: 'do something unrelated',
        allowedCommands: ['routine'],
        fetchImpl: async () => completion(null)
    });
    assert.equal(command, null);
});

test('rejects commands outside the allowlist and malformed API output', async () => {
    await assert.rejects(
        resolveHermesCommand({
            ...config,
            request: 'run a shell command',
            allowedCommands: ['routine'],
            fetchImpl: async () => completion('run')
        }),
        /not allowed/
    );
    await assert.rejects(
        resolveHermesCommand({
            ...config,
            request: 'give me the class routine',
            allowedCommands: ['routine'],
            fetchImpl: async () => new Response(JSON.stringify({
                choices: [{ message: { content: '{"command":"routine","args":"extra"}' } }]
            }))
        }),
        /invalid command selection/
    );
    await assert.rejects(
        resolveHermesCommand({
            ...config,
            request: 'give me the class routine',
            allowedCommands: ['routine'],
            fetchImpl: async () => new Response('not-json')
        }),
        /invalid JSON/
    );
});

test('rejects missing credentials, unsafe endpoints, and API errors', async () => {
    await assert.rejects(
        resolveHermesCommand({
            ...config,
            apiKey: '',
            request: 'routine',
            allowedCommands: ['routine']
        }),
        /not configured/
    );
    await assert.rejects(
        resolveHermesCommand({
            ...config,
            apiUrl: 'http://hermes.example/v1/chat/completions',
            request: 'routine',
            allowedCommands: ['routine']
        }),
        /must use HTTPS/
    );
    await assert.rejects(
        resolveHermesCommand({
            ...config,
            request: 'routine',
            allowedCommands: ['routine'],
            fetchImpl: async () => completion(null, 503)
        }),
        /HTTP 503/
    );
});

test('limits response size and reports request timeouts', async () => {
    await assert.rejects(
        resolveHermesCommand({
            ...config,
            request: 'routine',
            allowedCommands: ['routine'],
            fetchImpl: async () => new Response(JSON.stringify({
                choices: [{ message: { content: `{"command":"${'x'.repeat(17_000)}"}` } }]
            }))
        }),
        /16 KB limit/
    );

    await assert.rejects(
        resolveHermesCommand({
            ...config,
            request: 'routine',
            allowedCommands: ['routine'],
            timeoutMs: 5,
            fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
                options.signal.addEventListener('abort', () => reject(new Error('aborted')));
            })
        }),
        /timed out/
    );
});
