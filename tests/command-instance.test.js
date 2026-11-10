'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.LARAVEL_API_URL = 'http://laravel.test';
process.env.LARAVEL_API_TOKEN = 'test-token';
process.env.BOT_NAME = 'WBot';
process.env.BOT_INSTANCE_ID = 'wbot-wa-01';

const api = require('../laravel-api');

test('command claim and acknowledgements carry the WBot instance identity', async () => {
    const originalFetch = global.fetch;
    const requests = [];

    global.fetch = async (url, options = {}) => {
        requests.push({ url, options });
        return {
            ok: true,
            async text() {
                return JSON.stringify({ data: { id: 7, status: 'claimed' } });
            },
        };
    };

    try {
        await api.reclamarComando();
        await api.completarComando(7, { success: true });
        await api.fallarComando(7, 'temporary error', true);

        assert.match(requests[0].url, /instance_id=wbot-wa-01/);
        assert.equal(JSON.parse(requests[1].options.body).instance_id, 'wbot-wa-01');
        assert.equal(JSON.parse(requests[2].options.body).instance_id, 'wbot-wa-01');
    } finally {
        global.fetch = originalFetch;
    }
});
