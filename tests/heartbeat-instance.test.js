'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.LARAVEL_API_URL = 'http://laravel.test';
process.env.LARAVEL_API_TOKEN = 'test-token';
process.env.BOT_NAME = 'WBot';
process.env.BOT_INSTANCE_ID = 'wbot-whatsapp-02';

const heartbeat = require('../heartbeat');

test('heartbeat identifies the concrete WBot instance', async () => {
    const originalFetch = global.fetch;
    let captured = null;

    global.fetch = async (_url, options = {}) => {
        captured = options;
        return {
            ok: true,
            async json() {
                return { data: { last_seen_at: 'test' } };
            },
        };
    };

    try {
        assert.equal(await heartbeat.enviarHeartbeat('online'), true);
        const payload = JSON.parse(captured.body);
        assert.equal(payload.name, 'WBot');
        assert.equal(payload.instance_id, 'wbot-whatsapp-02');
    } finally {
        global.fetch = originalFetch;
    }
});
