// tiktok-api.js
'use strict';

const fs = require('fs');
const path = require('path');

const TIKTOK_ENABLED =
    String(process.env.TIKTOK_ENABLED || 'false').toLowerCase() === 'true';

const TIKTOK_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY || '';
const TIKTOK_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET || '';
const TIKTOK_REDIRECT_URI = process.env.TIKTOK_REDIRECT_URI || '';
const TIKTOK_API_BASE = 'https://open.tiktokapis.com/v2';

// Ruta donde Laravel/el operador guarda el token OAuth.
// Formato: { access_token, refresh_token, open_id, expires_at, scope }
const ARCHIVO_TOKEN_TIKTOK = path.join(__dirname, 'tiktok_token.json');

function cargarToken() {
    if (!fs.existsSync(ARCHIVO_TOKEN_TIKTOK)) return null;
    try {
        return JSON.parse(fs.readFileSync(ARCHIVO_TOKEN_TIKTOK, 'utf8'));
    } catch (_) {
        return null;
    }
}

function guardarToken(token) {
    fs.writeFileSync(
        ARCHIVO_TOKEN_TIKTOK,
        JSON.stringify(token, null, 2),
        'utf8'
    );
}

async function refrescarTokenSiEsNecesario() {
    const token = cargarToken();
    if (!token) throw new Error('No hay token de TikTok configurado.');

    const expiraEn = new Date(token.expires_at).getTime();
    const ahora = Date.now();

    // Refrescamos si quedan menos de 2 horas.
    if (expiraEn - ahora > 2 * 60 * 60 * 1000) return token;

    console.log('[TikTok] Refrescando access_token...');

    const body = new URLSearchParams({
        client_key: TIKTOK_CLIENT_KEY,
        client_secret: TIKTOK_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: token.refresh_token,
    });

    const res = await fetch(`${TIKTOK_API_BASE}/oauth/token/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });

    const data = await res.json();
    if (!res.ok || data.error) {
        throw new Error(`Refresh token falló: ${JSON.stringify(data)}`);
    }

    const nuevo = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        open_id: token.open_id,
        expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
        scope: data.scope,
    };

    guardarToken(nuevo);
    console.log('[TikTok] Token refrescado.');
    return nuevo;
}

/**
 * Publica un video en TikTok usando la Content Posting API.
 *
 * @param {Object} publicacion  Objeto de Laravel (debe traer .video y .tiktok)
 * @param {string} rutaVideo    Ruta local al archivo .mp4 ya descargado
 */
async function publicarEnTikTok(publicacion, rutaVideo) {
    if (!TIKTOK_ENABLED) throw new Error('TikTok deshabilitado.');
    if (!publicacion?.video) throw new Error(`Publicación ${publicacion?.id} no tiene video.`);
    if (!fs.existsSync(rutaVideo)) throw new Error(`Video no existe: ${rutaVideo}`);

    const token = await refrescarTokenSiEsNecesario();

    const meta = publicacion.tiktok || {};
    const titulo = String(meta.titulo || publicacion.texto || '').slice(0, 150);
    const hashtags = Array.isArray(meta.hashtags) ? meta.hashtags : [];

    const caption = [titulo, ...hashtags.map(h => `#${String(h).replace(/^#/, '')}`)]
        .filter(Boolean)
        .join(' ')
        .slice(0, 2200);

    // 1) Init: pedimos una URL de subida
    const initBody = {
        post_info: {
            title: caption,
            privacy_level: meta.privacidad || 'SELF_ONLY',
            disable_comment: !!meta.deshabilitar_comentarios,
            disable_duet: !!meta.deshabilitar_duet,
            disable_stitch: !!meta.deshabilitar_stitch,
        },
        source_info: {
            source: 'FILE_UPLOAD',
            video_size: fs.statSync(rutaVideo).size,
            chunk_size: fs.statSync(rutaVideo).size,
            total_chunk_count: 1,
        },
    };

    console.log('[TikTok] Iniciando subida (init)...');

    const initRes = await fetch(`${TIKTOK_API_BASE}/post/publish/video/init/`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token.access_token}`,
            'Content-Type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify(initBody),
    });

    const initData = await initRes.json();
    if (!initRes.ok || initData.error?.code !== 'ok') {
        throw new Error(`TikTok init falló: ${JSON.stringify(initData)}`);
    }

    const { publish_id, upload_url } = initData.data;

    // 2) Upload del binario
    console.log('[TikTok] Subiendo binario del video...');
    const buffer = fs.readFileSync(rutaVideo);

    const uploadRes = await fetch(upload_url, {
        method: 'PUT',
        headers: {
            'Content-Type': 'video/mp4',
            'Content-Length': String(buffer.length),
            'Content-Range': `bytes 0-${buffer.length - 1}/${buffer.length}`,
        },
        body: buffer,
    });

    if (!uploadRes.ok) {
        throw new Error(`TikTok upload falló: HTTP ${uploadRes.status}`);
    }

    // 3) Poll del estado hasta que termine
    console.log(`[TikTok] Upload OK. publish_id=${publish_id}. Esperando procesamiento...`);

    const inicio = Date.now();
    const TIMEOUT_MS = 5 * 60 * 1000;
    while (Date.now() - inicio < TIMEOUT_MS) {
        await new Promise(r => setTimeout(r, 5000));

        const statusRes = await fetch(
            `${TIKTOK_API_BASE}/post/publish/status/fetch/`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token.access_token}`,
                    'Content-Type': 'application/json; charset=UTF-8',
                },
                body: JSON.stringify({ publish_id }),
            }
        );

        const statusData = await statusRes.json();
        const estado = statusData?.data?.status;

        if (estado === 'PUBLISH_COMPLETE') {
            console.log('[TikTok] ✓ Publicación completada.');
            return {
                success: true,
                publish_id,
                url: statusData?.data?.publicaly_available_post_id?.[0]
                    ? `https://www.tiktok.com/@me/video/${statusData.data.publicaly_available_post_id[0]}`
                    : null,
            };
        }

        if (estado === 'FAILED') {
            throw new Error(`TikTok falló al publicar: ${JSON.stringify(statusData)}`);
        }
    }

    throw new Error('TikTok: timeout esperando PUBLISH_COMPLETE.');
}

module.exports = {
    TIKTOK_ENABLED,
    publicarEnTikTok,
    cargarToken,
};