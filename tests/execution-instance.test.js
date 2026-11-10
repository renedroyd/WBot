'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.LARAVEL_API_URL = 'http://laravel.test';
process.env.LARAVEL_API_TOKEN = 'test-token';
process.env.BOT_NAME = 'WBot';
process.env.BOT_INSTANCE_ID = 'agent-wa-01';

const api = require('../laravel-api');

test('publication execution lifecycle sends the assigned agent identity', async () => {
    const originalFetch = global.fetch;
    const requests = [];

    global.fetch = async (url, options = {}) => {
        requests.push({ url, options });
        return {
            ok: true,
            async text() {
                return JSON.stringify({ data: { id: 9, status: 'running' } });
            },
        };
    };

    try {
        await api.iniciarEjecucion({
            id: 3,
            occurrence_id: '3_2026-11-10_12-00',
        }, 'whatsapp', 'group@g.us');
        await api.completarEjecucion(9, 'message-9');
        await api.fallarEjecucion(9, 'temporary error');

        assert.equal(JSON.parse(requests[0].options.body).instance_id, 'agent-wa-01');
        assert.equal(JSON.parse(requests[1].options.body).instance_id, 'agent-wa-01');
        assert.equal(JSON.parse(requests[2].options.body).instance_id, 'agent-wa-01');
    } finally {
        global.fetch = originalFetch;
    }
});
