'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.LARAVEL_API_URL = 'http://laravel.test';
process.env.LARAVEL_API_TOKEN = 'test-token';
process.env.BOT_API_TIMEOUT_MS = '1000';

const laravelApi = require('../laravel-api');
const heartbeat = require('../heartbeat');

function fetchUntilAborted(_url, options = {}) {
    const { signal } = options;
    return new Promise((_resolve, reject) => {
        if (!signal) {
            reject(new Error('Expected a timeout signal on the request.'));
            return;
        }

        if (signal.aborted) {
            reject(signal.reason);
            return;
        }

        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
}

test('Laravel API requests fail with a clear message when they time out', async () => {
    const originalFetch = global.fetch;
    global.fetch = fetchUntilAborted;

    try {
        await assert.rejects(
            laravelApi.reclamarComando(),
            /La solicitud a Laravel .* superó el límite de 1000 ms/
        );
    } finally {
        global.fetch = originalFetch;
    }
});

test('heartbeat timeout releases the in-flight guard so later heartbeats can run', async () => {
    const originalFetch = global.fetch;
    global.fetch = fetchUntilAborted;

    try {
        const result = await heartbeat.enviarHeartbeat('online');
        assert.equal(result, false);

        global.fetch = async (_url, options = {}) => {
            assert.ok(options.signal, 'heartbeat request should include a timeout signal');
            return {
                ok: true,
                async json() {
                    return { data: { last_seen_at: 'test' } };
                },
            };
        };

        assert.equal(await heartbeat.enviarHeartbeat('online'), true);
    } finally {
        global.fetch = originalFetch;
    }
});
