'use strict';

const LARAVEL_API_URL = (process.env.LARAVEL_API_URL || '').replace(/\/+$/, '');
const LARAVEL_API_TOKEN = process.env.LARAVEL_API_TOKEN || '';
const BOT_NAME = process.env.BOT_NAME || 'WBot';
const API_TIMEOUT_DEFAULT_MS = 15000;
const API_TIMEOUT_CONFIGURED_MS = Number.parseInt(process.env.BOT_API_TIMEOUT_MS || '', 10);
const API_TIMEOUT_MS = Number.isFinite(API_TIMEOUT_CONFIGURED_MS) && API_TIMEOUT_CONFIGURED_MS >= 1000
    ? API_TIMEOUT_CONFIGURED_MS
    : API_TIMEOUT_DEFAULT_MS;

async function request(path, options = {}) {
    if (!LARAVEL_API_URL || !LARAVEL_API_TOKEN) {
        throw new Error('La configuración de Laravel API está incompleta.');
    }

    let response;
    let text;
    try {
        response = await fetch(LARAVEL_API_URL + path, {
            ...options,
            signal: options.signal || AbortSignal.timeout(API_TIMEOUT_MS),
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + LARAVEL_API_TOKEN,
                ...(options.headers || {}),
            },
        });
        text = await response.text();
    } catch (error) {
        if (error && error.name === 'TimeoutError') {
            throw new Error(`La solicitud a Laravel (${path}) superó el límite de ${API_TIMEOUT_MS} ms.`, { cause: error });
        }
        throw error;
    }

    let body = {};

    try {
        body = text ? JSON.parse(text) : {};
    } catch (_) {
        body = { raw: text };
    }

    if (!response.ok) {
        throw new Error(
            'Laravel respondió HTTP ' + response.status + ': ' + text.slice(0, 500)
        );
    }

    return body;
}

async function iniciarEjecucion(publicacion, channel, targetKey, facebookGroupId = null) {
    return request('/api/bot/executions/start', {
        method: 'POST',
        body: JSON.stringify({
            publication_id: publicacion.id,
            occurrence_id: publicacion.ocurrencia_id || publicacion.occurrence_id,
            channel,
            target_key: targetKey,
            facebook_group_id: facebookGroupId,
        }),
    });
}

async function completarEjecucion(executionId, externalId = null) {
    return request('/api/bot/executions/' + executionId + '/complete', {
        method: 'POST',
        body: JSON.stringify({ external_id: externalId }),
    });
}

async function fallarEjecucion(executionId, error) {
    return request('/api/bot/executions/' + executionId + '/fail', {
        method: 'POST',
        body: JSON.stringify({
            error: String(error || 'Error de ejecución').slice(0, 2000),
        }),
    });
}

async function reclamarComando() {
    return request(
        '/api/bot/commands/claim?bot_name=' + encodeURIComponent(BOT_NAME),
        { method: 'GET' }
    );
}

async function completarComando(commandId, result = {}) {
    return request('/api/bot/commands/' + commandId + '/complete', {
        method: 'POST',
        body: JSON.stringify({ bot_name: BOT_NAME, result }),
    });
}

async function fallarComando(commandId, error, retry = true) {
    return request('/api/bot/commands/' + commandId + '/fail', {
        method: 'POST',
        body: JSON.stringify({
            bot_name: BOT_NAME,
            error: String(error || 'Error ejecutando comando').slice(0, 2000),
            retry,
        }),
    });
}

module.exports = {
    iniciarEjecucion,
    completarEjecucion,
    fallarEjecucion,
    reclamarComando,
    completarComando,
    fallarComando,
};
