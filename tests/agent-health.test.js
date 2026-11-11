'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.LARAVEL_API_URL = 'http://laravel.test';
process.env.LARAVEL_API_TOKEN = 'scoped-test-token';
process.env.BOT_INSTANCE_ID = 'agent-wa-01';
process.env.SOCIAL_ACCOUNT_ID = '42';
process.env.FACEBOOK_SOCIAL_ACCOUNT_ID = '77';

const api = require('../laravel-api');

function healthResponse(overrides = {}) {
    return {
        data: {
            workspace_id: 9,
            instance_id: 'agent-wa-01',
            authorization_mode: 'scoped',
            accounts: [
                {
                    id: 42,
                    platform: 'whatsapp',
                    account_type: 'whatsapp_account',
                    status: 'connected',
                    connections: [{
                        type: 'wppconnect_qr',
                        status: 'connected',
                        agent_instance_id: 'agent-wa-01',
                    }],
                },
                {
                    id: 77,
                    platform: 'facebook',
                    account_type: 'facebook_profile',
                    status: 'pending',
                    connections: [],
                },
            ],
            ...overrides,
        },
    };
}

test('startup preflight confirms account assignments and instance identity', async () => {
    const originalFetch = global.fetch;
    let captured = null;
    global.fetch = async (url, options = {}) => {
        captured = { url, options };
        return {
            ok: true,
            async text() {
                return JSON.stringify(healthResponse());
            },
        };
    };

    try {
        const result = await api.consultarEstadoAgente();
        assert.match(captured.url, /\/api\/bot\/agent\/health\?instance_id=agent-wa-01$/);
        assert.equal(captured.options.headers.Authorization, 'Bearer scoped-test-token');
        assert.equal(result.authorizationMode, 'scoped');
        assert.equal(result.workspaceId, 9);
        assert.deepEqual(result.accounts.map(account => account.id), [42, 77]);
    } finally {
        global.fetch = originalFetch;
    }
});

test('startup preflight refuses an account not granted to the agent', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
        ok: true,
        async text() {
            return JSON.stringify(healthResponse({
                accounts: [healthResponse().data.accounts[0]],
            }));
        },
    });

    try {
        await assert.rejects(
            api.consultarEstadoAgente(),
            /no está autorizada para la instancia agent-wa-01/
        );
    } finally {
        global.fetch = originalFetch;
    }
});


test('startup preflight refuses a SocialPublicator-revoked session', async () => {
    const originalFetch = global.fetch;
    const payload = healthResponse();
    payload.data.accounts[0].connections[0].revoked_at = '2026-11-11T10:00:00Z';
    payload.data.accounts[0].connections[0].last_error_code = 'workspace_admin_revoked';

    global.fetch = async () => ({
        ok: true,
        async text() {
            return JSON.stringify(payload);
        },
    });

    try {
        await assert.rejects(
            api.consultarEstadoAgente(),
            /fue revocado desde SocialPublicator/
        );
    } finally {
        global.fetch = originalFetch;
    }
});

test('startup preflight refuses to open a session already owned by another instance', async () => {
    const originalFetch = global.fetch;
    const payload = healthResponse();
    payload.data.accounts[0].connections[0].agent_instance_id = 'agent-wa-02';

    global.fetch = async () => ({
        ok: true,
        async text() {
            return JSON.stringify(payload);
        },
    });

    try {
        await assert.rejects(
            api.consultarEstadoAgente(),
            /ya está vinculada a otra instancia WBot/
        );
    } finally {
        global.fetch = originalFetch;
    }
});
