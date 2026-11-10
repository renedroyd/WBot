'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.LARAVEL_API_URL = 'http://laravel.test';
process.env.LARAVEL_API_TOKEN = 'test-token';
process.env.SOCIAL_ACCOUNT_ID = '42';
process.env.BOT_INSTANCE_ID = 'wbot-test-01';

const api = require('../laravel-api');

test('WhatsApp QR state is forwarded to SocialPublicator without storing local session data', async () => {
    const originalFetch = global.fetch;
    let captured = null;

    global.fetch = async (url, options = {}) => {
        captured = { url, options };
        return {
            ok: true,
            async text() {
                return JSON.stringify({ success: true, status: 'qr' });
            },
        };
    };

    try {
        await api.publicarEstadoConexionWhatsApp('qr', {
            qr: 'data:image/png;base64,temporary',
        });

        assert.equal(captured.url, 'http://laravel.test/api/bot/whatsapp/connection/state');
        assert.equal(captured.options.method, 'POST');
        assert.equal(captured.options.headers.Authorization, 'Bearer test-token');

        const body = JSON.parse(captured.options.body);
        assert.equal(body.social_account_id, 42);
        assert.equal(body.agent_instance_id, 'wbot-test-01');
        assert.equal(body.status, 'qr');
        assert.equal(body.qr, 'data:image/png;base64,temporary');
        assert.equal(Object.hasOwn(body, 'credentials'), false);
        assert.equal(Object.hasOwn(body, 'session_path'), false);
    } finally {
        global.fetch = originalFetch;
    }
});

test('WhatsApp group sync includes the configured social account id', async () => {
    const originalFetch = global.fetch;
    let captured = null;

    global.fetch = async (url, options = {}) => {
        captured = { url, options };
        return {
            ok: true,
            async text() {
                return JSON.stringify({ success: true, total: 1 });
            },
        };
    };

    try {
        await api.sincronizarGruposWhatsApp([{
            whatsapp_id: '120363000000001@g.us',
            name: 'Grupo de prueba',
        }]);

        const body = JSON.parse(captured.options.body);
        assert.equal(body.social_account_id, 42);
        assert.equal(body.groups.length, 1);
    } finally {
        global.fetch = originalFetch;
    }
});
