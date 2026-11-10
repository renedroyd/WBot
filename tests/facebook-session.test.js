'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.LARAVEL_API_URL = 'http://laravel.test';
process.env.LARAVEL_API_TOKEN = 'test-token';
process.env.FACEBOOK_SOCIAL_ACCOUNT_ID = '84';
process.env.BOT_INSTANCE_ID = 'wbot-test-01';

const api = require('../laravel-api');

test('Facebook browser session state is reported without cookies or browser profile data', async () => {
    const originalFetch = global.fetch;
    let captured = null;

    global.fetch = async (url, options = {}) => {
        captured = { url, options };
        return {
            ok: true,
            async text() {
                return JSON.stringify({ success: true, status: 'connected' });
            },
        };
    };

    try {
        await api.publicarEstadoConexionFacebook('connected');

        assert.equal(captured.url, 'http://laravel.test/api/bot/facebook/connection/state');
        assert.equal(captured.options.method, 'POST');
        const body = JSON.parse(captured.options.body);
        assert.equal(body.social_account_id, 84);
        assert.equal(body.agent_instance_id, 'wbot-test-01');
        assert.equal(body.status, 'connected');
        assert.equal(Object.hasOwn(body, 'cookies'), false);
        assert.equal(Object.hasOwn(body, 'localStorage'), false);
        assert.equal(Object.hasOwn(body, 'profile_path'), false);
    } finally {
        global.fetch = originalFetch;
    }
});
