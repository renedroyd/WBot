'use strict';

const os = require('os');

const LARAVEL_API_URL = (process.env.LARAVEL_API_URL || '').replace(/\/+$/, '');
const LARAVEL_API_TOKEN = process.env.LARAVEL_API_TOKEN;

const BOT_NAME = process.env.BOT_NAME || 'WBot';
const BOT_PLATFORM = process.env.BOT_PLATFORM || 'whatsapp';
const BOT_VERSION = process.env.BOT_VERSION || '1.0.0';

const HEARTBEAT_INTERVAL = Number(
    process.env.BOT_HEARTBEAT_INTERVAL || 30000
);

let heartbeatTimer = null;

async function enviarHeartbeat(status = 'online', extra = {}) {
    if (!LARAVEL_API_URL || !LARAVEL_API_TOKEN) {
        console.error('[HEARTBEAT] Laravel API o token no configurado');
        return false;
    }

    const payload = {
        name: BOT_NAME,
        platform: BOT_PLATFORM,
        status,
        version: BOT_VERSION,
        host: os.hostname(),
        message: extra.message || null,

        metadata: {
            pid: process.pid,
            platform: os.platform(),
            arch: os.arch(),
            node: process.version,
            uptime: Math.round(process.uptime()),
            ...extra.metadata,
        },
    };

    try {
        const response = await fetch(
            `${LARAVEL_API_URL}/api/bot/status`,
            {
                method: 'POST',

                headers: {
                    'Authorization': `Bearer ${LARAVEL_API_TOKEN}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },

                body: JSON.stringify(payload),
            }
        );

        if (!response.ok) {
            const body = await response.text();

            console.error(
                `[HEARTBEAT] HTTP ${response.status}: ${body}`
            );

            return false;
        }

        const result = await response.json();

        console.log(
            `[HEARTBEAT] ${status} | ${result.data?.last_seen_at || 'OK'}`
        );

        return true;

    } catch (error) {
        console.error(
            `[HEARTBEAT] Error: ${error.message}`
        );

        return false;
    }
}

function iniciarHeartbeat() {
    if (heartbeatTimer) {
        return;
    }

    console.log(
        `[HEARTBEAT] Iniciando monitor cada ${HEARTBEAT_INTERVAL / 1000}s`
    );

    // Primer heartbeat inmediatamente.
    enviarHeartbeat('starting');

    heartbeatTimer = setInterval(() => {
        enviarHeartbeat('online');
    }, HEARTBEAT_INTERVAL);
}

async function detenerHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }

    await enviarHeartbeat('stopping');

    console.log('[HEARTBEAT] Monitor detenido');
}

module.exports = {
    enviarHeartbeat,
    iniciarHeartbeat,
    detenerHeartbeat,
};
