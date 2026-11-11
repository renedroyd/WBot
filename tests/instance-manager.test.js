'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const {
    buildInstanceDefinitions,
    buildWorkerEnv,
} = require('../instance-manager');

const baseEnv = {
    LARAVEL_API_URL: 'https://social.test',
    BOT_NAME: 'WBot',
    WBOT_VENTAS_TOKEN: 'token-ventas',
    WBOT_MAYORISTA_TOKEN: 'token-mayorista',
};

function sampleConfig() {
    return {
        instances: [
            {
                key: 'ventas',
                id: 'wbot-ventas',
                tokenEnv: 'WBOT_VENTAS_TOKEN',
                whatsapp: { socialAccountId: 101, sessionName: 'wa-ventas' },
                facebook: {
                    socialAccountId: 201,
                    originUrl: 'https://www.facebook.com/',
                    headless: false,
                },
            },
            {
                key: 'mayorista',
                id: 'wbot-mayorista',
                tokenEnv: 'WBOT_MAYORISTA_TOKEN',
                whatsapp: { socialAccountId: 102, sessionName: 'wa-mayorista' },
            },
        ],
    };
}

test('builds isolated workers with one WhatsApp account and optional Facebook account each', () => {
    const definitions = buildInstanceDefinitions(sampleConfig(), baseEnv, '/opt/wbot');

    assert.equal(definitions.length, 2);
    assert.notEqual(definitions[0].whatsapp.sessionDir, definitions[1].whatsapp.sessionDir);
    assert.notEqual(definitions[0].profileDir, definitions[1].profileDir);
    assert.notEqual(definitions[0].stateFile, definitions[1].stateFile);
    assert.equal(definitions[0].facebook.socialAccountId, '201');
    assert.equal(definitions[1].facebook, null);
});

test('builds a worker environment with only its own account IDs and token', () => {
    const definitions = buildInstanceDefinitions(sampleConfig(), baseEnv, '/opt/wbot');
    const env = buildWorkerEnv(definitions[0], baseEnv, definitions);

    assert.equal(env.BOT_INSTANCE_ID, 'wbot-ventas');
    assert.equal(env.LARAVEL_API_TOKEN, 'token-ventas');
    assert.equal(env.SOCIAL_ACCOUNT_ID, '101');
    assert.equal(env.FACEBOOK_SOCIAL_ACCOUNT_ID, '201');
    assert.equal(env.FACEBOOK_ENABLED, 'true');
    assert.equal(env.WHATSAPP_PROFILE_DIR, definitions[0].profileDir);
    assert.equal(env.BROWSER_PROFILE_DIR, definitions[0].profileDir);
    assert.equal(env.BOT_STATE_FILE, definitions[0].stateFile);
    assert.equal(Object.hasOwn(env, 'WBOT_VENTAS_TOKEN'), false);
    assert.equal(Object.hasOwn(env, 'WBOT_MAYORISTA_TOKEN'), false);
});

test('keeps Facebook disabled for WhatsApp-only workers', () => {
    const definitions = buildInstanceDefinitions(sampleConfig(), baseEnv, '/opt/wbot');
    const env = buildWorkerEnv(definitions[1], baseEnv, definitions);

    assert.equal(env.FACEBOOK_ENABLED, 'false');
    assert.equal(env.FACEBOOK_SOCIAL_ACCOUNT_ID, '');
    assert.equal(env.SOCIAL_ACCOUNT_ID, '102');
});

test('rejects duplicate instance IDs, account assignments, tokens and session names', () => {
    const duplicateId = sampleConfig();
    duplicateId.instances[1].id = duplicateId.instances[0].id;
    assert.throws(() => buildInstanceDefinitions(duplicateId, baseEnv), /BOT_INSTANCE_ID duplicado/);

    const duplicateAccount = sampleConfig();
    duplicateAccount.instances[1].whatsapp.socialAccountId = 101;
    assert.throws(() => buildInstanceDefinitions(duplicateAccount, baseEnv), /cuenta WhatsApp #101/);

    const duplicateToken = sampleConfig();
    duplicateToken.instances[1].tokenEnv = duplicateToken.instances[0].tokenEnv;
    assert.throws(() => buildInstanceDefinitions(duplicateToken, baseEnv), /tokenEnv diferente/);

    const duplicateSession = sampleConfig();
    duplicateSession.instances[1].whatsapp.sessionName = 'wa-ventas';
    assert.throws(() => buildInstanceDefinitions(duplicateSession, baseEnv), /sesión WhatsApp duplicado/);
});

test('rejects missing per-instance tokens and shared runtime paths', () => {
    assert.throws(
        () => buildInstanceDefinitions(sampleConfig(), { LARAVEL_API_URL: 'https://social.test' }),
        /WBOT_VENTAS_TOKEN/
    );

    const sharedPath = sampleConfig();
    sharedPath.instances[1].dataDir = sharedPath.instances[0].dataDir || './runtime/ventas/data';
    assert.throws(
        () => buildInstanceDefinitions(sharedPath, baseEnv, '/opt/wbot'),
        /Ruta de runtime compartida/
    );
});

test('rejects Facebook workers without an origin URL', () => {
    const config = sampleConfig();
    delete config.instances[0].facebook.originUrl;
    assert.throws(
        () => buildInstanceDefinitions(config, { ...baseEnv, FACEBOOK_ORIGEN_URL: '' }),
        /facebook.originUrl/
    );
});
