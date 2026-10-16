'use strict';

const os = require('os');

const LARAVEL_API_URL = (process.env.LARAVEL_API_URL || '').replace(/\/+$/, '');
const LARAVEL_API_TOKEN = process.env.LARAVEL_API_TOKEN;

const BOT_NAME = process.env.BOT_NAME || 'WBot';
const BOT_PLATFORM = process.env.BOT_PLATFORM || 'whatsapp';
const BOT_VERSION = process.env.BOT_VERSION || '1.0.0';

const HEARTBEAT_INTERVAL = Math.max(
    10000,
    Number(process.env.BOT_HEARTBEAT_INTERVAL || 30000)
);
const API_TIMEOUT_DEFAULT_MS = 15000;
const API_TIMEOUT_CONFIGURED_MS = Number.parseInt(process.env.BOT_API_TIMEOUT_MS || '', 10);
const API_TIMEOUT_MS = Number.isFinite(API_TIMEOUT_CONFIGURED_MS) && API_TIMEOUT_CONFIGURED_MS >= 1000
    ? API_TIMEOUT_CONFIGURED_MS
    : API_TIMEOUT_DEFAULT_MS;

let heartbeatTimer = null;
let heartbeatEnviando = false;

const estadoHeartbeat = {
    status: 'starting',
    message: 'Iniciando bot',
    whatsapp: 'starting',
    facebook: 'disabled',
    lastPublication: null,
    lastPublicationAt: null,
    lastPublicationDestination: null,
    nextPublication: null,
    lastError: null,
    lastErrorAt: null,
    stats: {
        successful: 0,
        failed: 0,
        whatsappSuccessful: 0,
        facebookSuccessful: 0,
        retries: 0,
    },
};

function truncar(valor, max = 1000) {
    if (valor === null || valor === undefined) return null;

    const texto = String(valor);

    return texto.length > max
        ? texto.slice(0, max - 3) + '...'
        : texto;
}

function actualizarEstadoHeartbeat(cambios = {}) {
    if (!cambios || typeof cambios !== 'object') return;

    if (cambios.status) {
        estadoHeartbeat.status = cambios.status;
    }

    if (Object.prototype.hasOwnProperty.call(cambios, 'message')) {
        estadoHeartbeat.message = truncar(cambios.message);
    }

    if (Object.prototype.hasOwnProperty.call(cambios, 'whatsapp')) {
        estadoHeartbeat.whatsapp = cambios.whatsapp;
    }

    if (Object.prototype.hasOwnProperty.call(cambios, 'facebook')) {
        estadoHeartbeat.facebook = cambios.facebook;
    }

    if (Object.prototype.hasOwnProperty.call(cambios, 'lastPublication')) {
        estadoHeartbeat.lastPublication = cambios.lastPublication
            ? {
                id: cambios.lastPublication.id ?? null,
                ocurrencia_id: cambios.lastPublication.ocurrencia_id ?? null,
                fecha: cambios.lastPublication.fecha ?? null,
                hora: cambios.lastPublication.hora ?? null,
            }
            : null;
    }

    if (Object.prototype.hasOwnProperty.call(cambios, 'lastPublicationAt')) {
        estadoHeartbeat.lastPublicationAt = cambios.lastPublicationAt || null;
    }

    if (Object.prototype.hasOwnProperty.call(cambios, 'lastPublicationDestination')) {
        estadoHeartbeat.lastPublicationDestination =
            cambios.lastPublicationDestination || null;
    }

    if (Object.prototype.hasOwnProperty.call(cambios, 'nextPublication')) {
        estadoHeartbeat.nextPublication = cambios.nextPublication
            ? {
                id: cambios.nextPublication.id ?? null,
                ocurrencia_id: cambios.nextPublication.ocurrencia_id ?? null,
                fecha: cambios.nextPublication.fecha ?? null,
                hora: cambios.nextPublication.hora ?? null,
            }
            : null;
    }

    if (Object.prototype.hasOwnProperty.call(cambios, 'lastError')) {
        estadoHeartbeat.lastError = cambios.lastError
            ? truncar(cambios.lastError)
            : null;
    }

    if (Object.prototype.hasOwnProperty.call(cambios, 'lastErrorAt')) {
        estadoHeartbeat.lastErrorAt = cambios.lastErrorAt || null;
    }

    if (cambios.stats && typeof cambios.stats === 'object') {
        estadoHeartbeat.stats = {
            ...estadoHeartbeat.stats,
            ...cambios.stats,
        };
    }
}

function registrarPublicacionExitosa(publicacion, destino) {
    const stats = estadoHeartbeat.stats;

    actualizarEstadoHeartbeat({
        lastPublication: publicacion,
        lastPublicationAt: new Date().toISOString(),
        lastPublicationDestination: destino || null,
        lastError: null,
        lastErrorAt: null,
        stats: {
            successful: stats.successful + 1,
            whatsappSuccessful:
                stats.whatsappSuccessful +
                (destino === 'whatsapp' ? 1 : 0),
            facebookSuccessful:
                stats.facebookSuccessful +
                (destino === 'facebook' ? 1 : 0),
        },
    });
}

function registrarPublicacionFallida(publicacion, destino, error) {
    const stats = estadoHeartbeat.stats;
    const id = publicacion && publicacion.id !== undefined
        ? publicacion.id
        : '?';

    actualizarEstadoHeartbeat({
        lastError: error && error.message ? error.message : error || 'Error de publicación',
        lastErrorAt: new Date().toISOString(),
        message:
            'Error publicando ID ' + id +
            (destino ? ' en ' + destino : ''),
        stats: {
            failed: stats.failed + 1,
        },
    });
}

function registrarReintento() {
    actualizarEstadoHeartbeat({
        stats: {
            retries: estadoHeartbeat.stats.retries + 1,
        },
    });
}

function obtenerEstadoHeartbeat() {
    return JSON.parse(JSON.stringify(estadoHeartbeat));
}

async function enviarHeartbeat(status = estadoHeartbeat.status, extra = {}) {
    if (!LARAVEL_API_URL || !LARAVEL_API_TOKEN) {
        console.error('[HEARTBEAT] Laravel API o token no configurado');
        return false;
    }

    if (heartbeatEnviando) {
        return false;
    }

    heartbeatEnviando = true;

    const estadoActual = obtenerEstadoHeartbeat();

    const payload = {
        name: BOT_NAME,
        platform: BOT_PLATFORM,
        status,
        version: BOT_VERSION,
        host: os.hostname(),
        message: truncar(
            extra.message !== undefined
                ? extra.message
                : estadoActual.message
        ),

        metadata: {
            pid: process.pid,
            platform: os.platform(),
            arch: os.arch(),
            node: process.version,
            uptime: Math.round(process.uptime()),

            whatsapp: estadoActual.whatsapp,
            facebook: estadoActual.facebook,

            last_publication: estadoActual.lastPublication,
            last_publication_at: estadoActual.lastPublicationAt,
            last_publication_destination:
                estadoActual.lastPublicationDestination,

            next_publication: estadoActual.nextPublication,

            last_error: estadoActual.lastError,
            last_error_at: estadoActual.lastErrorAt,

            stats: estadoActual.stats,

            ...extra.metadata,
        },
    };

    try {
        const response = await fetch(
            LARAVEL_API_URL + '/api/bot/status',
            {
                method: 'POST',
                signal: AbortSignal.timeout(API_TIMEOUT_MS),
                headers: {
                    'Authorization': 'Bearer ' + LARAVEL_API_TOKEN,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
                body: JSON.stringify(payload),
            }
        );

        if (!response.ok) {
            const body = await response.text();

            console.error(
                '[HEARTBEAT] HTTP ' + response.status + ': ' + body
            );

            return false;
        }

        const result = await response.json();

        console.log(
            '[HEARTBEAT] ' + status +
            ' | ' + (result.data?.last_seen_at || 'OK')
        );

        return true;

    } catch (error) {
        console.error(
            '[HEARTBEAT] Error: ' + error.message
        );

        return false;

    } finally {
        heartbeatEnviando = false;
    }
}

function iniciarHeartbeat(statusInicial = 'online') {
    if (heartbeatTimer) {
        return;
    }

    actualizarEstadoHeartbeat({
        status: statusInicial,
    });

    console.log(
        '[HEARTBEAT] Iniciando monitor cada ' +
        (HEARTBEAT_INTERVAL / 1000) +
        's'
    );

    enviarHeartbeat(statusInicial);

    heartbeatTimer = setInterval(() => {
        enviarHeartbeat(estadoHeartbeat.status);
    }, HEARTBEAT_INTERVAL);
}

async function detenerHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }

    actualizarEstadoHeartbeat({
        status: 'stopping',
        message: 'Bot detenido',
    });

    await enviarHeartbeat('stopping');

    console.log('[HEARTBEAT] Monitor detenido');
}

module.exports = {
    enviarHeartbeat,
    iniciarHeartbeat,
    detenerHeartbeat,
    actualizarEstadoHeartbeat,
    obtenerEstadoHeartbeat,
    registrarPublicacionExitosa,
    registrarPublicacionFallida,
    registrarReintento,
};
