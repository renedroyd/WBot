'use strict';

const LARAVEL_API_URL = (process.env.LARAVEL_API_URL || '').replace(/\/+$/, '');
const LARAVEL_API_TOKEN = process.env.LARAVEL_API_TOKEN || '';
const BOT_NAME = process.env.BOT_NAME || 'WBot';
const SOCIAL_ACCOUNT_ID = process.env.SOCIAL_ACCOUNT_ID || '';
const FACEBOOK_SOCIAL_ACCOUNT_ID = process.env.FACEBOOK_SOCIAL_ACCOUNT_ID || '';
const BOT_INSTANCE_ID = process.env.BOT_INSTANCE_ID || BOT_NAME;
const WHATSAPP_SESSION_NAME = process.env.WHATSAPP_SESSION_NAME || 'whatsapp-bot';
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


async function consultarEstadoAgente() {
    if (!SOCIAL_ACCOUNT_ID && !FACEBOOK_SOCIAL_ACCOUNT_ID) {
        return { skipped: true, reason: 'No hay cuentas sociales vinculadas a SocialPublicator.' };
    }

    const data = await request(
        '/api/bot/agent/health?instance_id=' + encodeURIComponent(BOT_INSTANCE_ID),
        { method: 'GET' }
    ).then(response => response.data);

    if (!data || data.instance_id !== BOT_INSTANCE_ID || !Array.isArray(data.accounts)) {
        throw new Error('SocialPublicator devolvió una respuesta de diagnóstico de agente no válida.');
    }

    const expected = [];
    if (SOCIAL_ACCOUNT_ID) {
        expected.push({
            id: SOCIAL_ACCOUNT_ID,
            platform: 'whatsapp',
            accountType: 'whatsapp_account',
            connectionType: 'wppconnect_qr',
            label: 'WhatsApp',
        });
    }
    if (FACEBOOK_SOCIAL_ACCOUNT_ID) {
        expected.push({
            id: FACEBOOK_SOCIAL_ACCOUNT_ID,
            platform: 'facebook',
            accountType: 'facebook_profile',
            connectionType: 'browser_session',
            label: 'Facebook',
        });
    }

    for (const item of expected) {
        if (!/^\d+$/.test(String(item.id)) || Number(item.id) <= 0) {
            throw new Error('El identificador de cuenta configurado para ' + item.label + ' no es válido.');
        }

        const account = data.accounts.find(candidate => Number(candidate.id) === Number(item.id));
        if (!account) {
            throw new Error(
                'La cuenta ' + item.id + ' de ' + item.label +
                ' no está autorizada para la instancia ' + BOT_INSTANCE_ID + ' en SocialPublicator.'
            );
        }

        if (account.platform !== item.platform || account.account_type !== item.accountType) {
            throw new Error(
                'La cuenta ' + item.id + ' no corresponde al tipo esperado para ' + item.label + '.'
            );
        }

        const relevantConnections = (account.connections || [])
            .filter(connection => connection.type === item.connectionType);

        const revokedConnection = relevantConnections.some(connection =>
            connection.status === 'revoked' || Boolean(connection.revoked_at)
        );
        if (revokedConnection) {
            throw new Error(
                'El acceso de ' + item.label + ' fue revocado desde SocialPublicator. ' +
                'Un administrador debe reactivarlo antes de iniciar WBot.'
            );
        }

        const conflictingConnection = relevantConnections.some(connection =>
            ['connected', 'pending'].includes(connection.status)
            && connection.agent_instance_id !== BOT_INSTANCE_ID
        );
        if (conflictingConnection) {
            throw new Error(
                'La cuenta ' + item.id + ' ya está vinculada a otra instancia WBot. ' +
                'No se iniciará una segunda sesión.'
            );
        }
    }

    return {
        skipped: false,
        authorizationMode: data.authorization_mode,
        workspaceId: data.workspace_id,
        instanceId: data.instance_id,
        accounts: expected.map(item => ({
            id: Number(item.id),
            platform: item.platform,
            status: data.accounts.find(account => Number(account.id) === Number(item.id)).status,
        })),
    };
}

async function sincronizarGruposWhatsApp(groups) {
    return request('/api/bot/whatsapp/groups/sync', {
        method: 'POST',
        body: JSON.stringify({
            groups,
            agent_instance_id: BOT_INSTANCE_ID,
            ...(SOCIAL_ACCOUNT_ID ? { social_account_id: Number(SOCIAL_ACCOUNT_ID) } : {}),
        }),
    });
}

async function publicarEstadoConexionFacebook(status, extra = {}) {
    if (!FACEBOOK_SOCIAL_ACCOUNT_ID) {
        return { skipped: true, reason: 'FACEBOOK_SOCIAL_ACCOUNT_ID no configurado' };
    }

    return request('/api/bot/facebook/connection/state', {
        method: 'POST',
        body: JSON.stringify({
            social_account_id: Number(FACEBOOK_SOCIAL_ACCOUNT_ID),
            agent_instance_id: BOT_INSTANCE_ID,
            status,
            ...(extra.error ? { error: String(extra.error).slice(0, 500) } : {}),
        }),
    });
}

async function publicarEstadoConexionWhatsApp(status, extra = {}) {
    if (!SOCIAL_ACCOUNT_ID) {
        return { skipped: true, reason: 'SOCIAL_ACCOUNT_ID no configurado' };
    }

    return request('/api/bot/whatsapp/connection/state', {
        method: 'POST',
        body: JSON.stringify({
            social_account_id: Number(SOCIAL_ACCOUNT_ID),
            agent_instance_id: BOT_INSTANCE_ID,
            status,
            session_name: WHATSAPP_SESSION_NAME,
            ...(extra.qr ? { qr: extra.qr } : {}),
            ...(extra.phone ? { phone: extra.phone } : {}),
            ...(extra.error ? { error: String(extra.error).slice(0, 500) } : {}),
        }),
    });
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
            instance_id: BOT_INSTANCE_ID,
        }),
    });
}

async function completarEjecucion(executionId, externalId = null) {
    return request('/api/bot/executions/' + executionId + '/complete', {
        method: 'POST',
        body: JSON.stringify({ external_id: externalId, instance_id: BOT_INSTANCE_ID }),
    });
}

async function fallarEjecucion(executionId, error, options = {}) {
    return request('/api/bot/executions/' + executionId + '/fail', {
        method: 'POST',
        body: JSON.stringify({
            instance_id: BOT_INSTANCE_ID,
            error: String(error || 'Error de ejecución').slice(0, 2000),
            ...(options.outcomeUncertain === true ? { outcome_unknown: true } : {}),
        }),
    });
}

async function reclamarComando() {
    return request(
        '/api/bot/commands/claim?bot_name=' + encodeURIComponent(BOT_NAME) + '&instance_id=' + encodeURIComponent(BOT_INSTANCE_ID),
        { method: 'GET' }
    );
}

async function completarComando(commandId, result = {}) {
    return request('/api/bot/commands/' + commandId + '/complete', {
        method: 'POST',
        body: JSON.stringify({ bot_name: BOT_NAME, instance_id: BOT_INSTANCE_ID, result }),
    });
}

async function fallarComando(commandId, error, retry = true) {
    return request('/api/bot/commands/' + commandId + '/fail', {
        method: 'POST',
        body: JSON.stringify({
            bot_name: BOT_NAME,
            instance_id: BOT_INSTANCE_ID,
            error: String(error || 'Error ejecutando comando').slice(0, 2000),
            retry,
        }),
    });
}

module.exports = {
    consultarEstadoAgente,
    sincronizarGruposWhatsApp,
    publicarEstadoConexionWhatsApp,
    publicarEstadoConexionFacebook,
    iniciarEjecucion,
    completarEjecucion,
    fallarEjecucion,
    reclamarComando,
    completarComando,
    fallarComando,
};
