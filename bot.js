// V7 - selector estricto del botón final; conserva cola concurrente y WhatsApp secuencial\n'use strict';

require('dotenv').config();

const wppconnect = require('@wppconnect-team/wppconnect');
const puppeteer = require('puppeteer');

const {
    enviarHeartbeat,
    iniciarHeartbeat,
    detenerHeartbeat,
    actualizarEstadoHeartbeat,
    registrarPublicacionExitosa,
    registrarPublicacionFallida,
    registrarReintento,
} = require('./heartbeat');

const {
    iniciarEjecucion,
    completarEjecucion,
    fallarEjecucion,
    reclamarComando,
    completarComando,
    fallarComando,
} = require('./laravel-api');

// Navegador/página de WhatsApp administrados por el bot, igual que Facebook.
let navegadorPrincipal = null;
let whatsappBrowser = null;
let whatsappPage = null;
let whatsappClient = null;

// Estado de Facebook.
let facebookBrowser = null;
let facebookPage = null;
let facebookSyncPage = null;
let facebookDisponible = false;
let datosMigracionFacebookPendientes = null;

// Diagnóstico Facebook: limitar temporalmente a dos tareas activas para comprobar
// si el procesamiento de publicaciones se atasca por la concurrencia de pestañas.
// La cola sigue siendo concurrente; WhatsApp conserva su orden secuencial.
const FACEBOOK_CONCURRENCIA_MAXIMA = 2;
const facebookTrabajosPendientes = [];
const facebookTrabajosActivos = new Map();
let facebookTrabajosActivosCount = 0;
function encolarTrabajoFacebook(clave, trabajo) {
    const existente = facebookTrabajosActivos.get(clave) ||
        facebookTrabajosPendientes.find(item => item.clave === clave);
    if (existente) {
        console.log(`[Facebook][Cola] Trabajo duplicado detectado; se reutiliza su resultado: ${clave}`);
        return existente.promise;
    }

    let resolver, rechazar;
    const promise = new Promise((resolve, reject) => { resolver = resolve; rechazar = reject; });
    // Evita un rechazo no observado para las tareas normales que se ejecutan en segundo plano.
    promise.catch(() => {});
    facebookTrabajosPendientes.push({ clave, trabajo, promise, resolver, rechazar });
    console.log(`[Facebook][Cola] Encolado ${clave}. Pendientes: ${facebookTrabajosPendientes.length}; activos: ${facebookTrabajosActivosCount}/${FACEBOOK_CONCURRENCIA_MAXIMA}.`);
    procesarColaFacebook();
    return promise;
}
function procesarColaFacebook() {
    while (facebookTrabajosActivosCount < FACEBOOK_CONCURRENCIA_MAXIMA && facebookTrabajosPendientes.length) {
        const item = facebookTrabajosPendientes.shift();
        facebookTrabajosActivosCount++;
        facebookTrabajosActivos.set(item.clave, item);
        (async () => {
            let pageTrabajo = null;
            try {
                if (!facebookBrowser || facebookBrowser.isConnected?.() === false) {
                    throw new Error('El navegador de Facebook no está disponible.');
                }
                pageTrabajo = await facebookBrowser.newPage();
                await pageTrabajo.setDefaultNavigationTimeout(FACEBOOK_TIMEOUT_MS);
                const resultado = await item.trabajo(pageTrabajo);
                item.resolver(resultado ?? { success: true });
            } catch (error) {
                item.rechazar(error);
                console.error(`[Facebook][Cola] Error en ${item.clave}: ${error.message}`);
            } finally {
                if (pageTrabajo && !pageTrabajo.isClosed()) {
                    await pageTrabajo.close().catch(() => {});
                }
                facebookTrabajosActivos.delete(item.clave);
                facebookTrabajosActivosCount--;
                console.log(`[Facebook][Cola] Finalizado ${item.clave}. Pendientes: ${facebookTrabajosPendientes.length}; activos: ${facebookTrabajosActivosCount}/${FACEBOOK_CONCURRENCIA_MAXIMA}.`);
                procesarColaFacebook();
            }
        })();
    }
}

const fs = require('fs');
const path = require('path');

// ============================================================
// CONFIGURACIÓN
// ============================================================

const NOMBRE_GRUPO = 'Venta mayorista de cervezas.';

// ------------------------------------------------------------
// FACEBOOK
// ------------------------------------------------------------
//
// IMPORTANTE:
// Meta retiró la antigua Groups API. Este módulo utiliza una
// sesión persistente del navegador y la interfaz web de Facebook.
//
// Primera ejecución:
//   - FACEBOOK_HEADLESS=false
//   - inicia sesión manualmente en Facebook
//   - entra al grupo si Facebook solicita verificación
//
// Después:
//   - la sesión queda guardada en facebook_session/
//   - puede ejecutarse con FACEBOOK_HEADLESS=true
//

const FACEBOOK_ENABLED =
String(process.env.FACEBOOK_ENABLED || 'false').toLowerCase() === 'true';

const FACEBOOK_ORIGEN_URL =
process.env.FACEBOOK_ORIGEN_URL || '';

// La selección de grupos de publicación procede de las asociaciones
// de cada publicación devueltas por Laravel.
const FACEBOOK_SYNC_INTERVAL_MS = Math.max(
    5 * 60 * 1000,
    parseInt(process.env.FACEBOOK_SYNC_INTERVAL_MS || String(30 * 60 * 1000), 10)
);

const FACEBOOK_GRUPOS_SYNC_ENDPOINT =
process.env.FACEBOOK_GRUPOS_SYNC_ENDPOINT ||
'/api/bot/facebook/grupos/sincronizar';

const FACEBOOK_HEADLESS =
String(process.env.FACEBOOK_HEADLESS || 'true').toLowerCase() === 'true';

const FACEBOOK_REINTENTOS =
Math.max(
    1,
    parseInt(process.env.FACEBOOK_REINTENTOS || '3', 10)
);

const FACEBOOK_ESPERA_REINTENTO_MS =
Math.max(
    1000,
    parseInt(
        process.env.FACEBOOK_ESPERA_REINTENTO_MS || '10000',
        10
    )
);

const FACEBOOK_TIMEOUT_MS =
Math.max(
    10000,
    parseInt(
        process.env.FACEBOOK_TIMEOUT_MS || '60000',
        10
    )
);

// MODO DE REFINAMIENTO DEL FLUJO FACEBOOK
// ------------------------------------------------------------
// El flujo se detiene intencionalmente después de seleccionar los grupos
// y regresar a "Post settings". No se pulsa "Publica" ni se continúa.
// Se reinicia al reiniciar el bot.
let facebookFlujoPausadoEnPostSettings = false; // V96: compatibilidad; ya no detiene el flujo operativo.

// ------------------------------------------------------------
// API LARAVEL
// ------------------------------------------------------------

const LARAVEL_API_URL = (
    process.env.LARAVEL_API_URL || ''
).replace(/\/+$/, '');

const LARAVEL_API_TOKEN =
process.env.LARAVEL_API_TOKEN || '';

const API_TIMEOUT_CONFIGURED_MS = Number.parseInt(process.env.BOT_API_TIMEOUT_MS || '', 10);
const BOT_API_TIMEOUT_MS = Number.isFinite(API_TIMEOUT_CONFIGURED_MS) && API_TIMEOUT_CONFIGURED_MS >= 1000
    ? API_TIMEOUT_CONFIGURED_MS
    : 15000;

const INTERVALO_ACTUALIZACION_API = 60 * 1000;

// ------------------------------------------------------------
// ARCHIVOS LOCALES
// ------------------------------------------------------------

const ARCHIVO_ESTADO = path.join(
    __dirname,
    'publicaciones_enviadas.json'
);

// ------------------------------------------------------------
// CARPETAS
// ------------------------------------------------------------

const CARPETA_IMAGENES = path.join(
    __dirname,
    'imagenes'
);

const CARPETA_IMAGENES_API = path.join(
    __dirname,
    'imagenes_api'
);

const CARPETA_SESION = path.join(
    __dirname,
    'whatsapp_session'
);

const CARPETA_PERFIL_WHATSAPP = path.join(
    CARPETA_SESION,
    'whatsapp-bot'
);

const ARCHIVO_BLOQUEO_WHATSAPP = path.join(
    CARPETA_SESION,
    'bot.lock'
);

const CARPETA_SESION_FACEBOOK = path.join(
    __dirname,
    'facebook_session'
);

// Un único perfil Chromium para WhatsApp + Facebook.
// Se reutiliza el perfil persistente actual de WhatsApp para no perder su sesión.
const CARPETA_PERFIL_COMUN = CARPETA_PERFIL_WHATSAPP;

// Migración segura de la sesión Facebook antigua al perfil Chromium compartido.
const ARCHIVO_MIGRACION_FACEBOOK = path.join(
    CARPETA_SESION_FACEBOOK,
    'migracion_compartida.json'
);

const CARPETA_BACKUPS_PERFIL = path.join(
    __dirname,
    'backups_perfiles'
);

// ============================================================
// CREAR CARPETAS
// ============================================================

// ============================================================
// MIGRACIÓN SEGURA DE FACEBOOK AL PERFIL COMPARTIDO
// ============================================================

function crearBackupPerfilCompartido() {

    if (!fs.existsSync(CARPETA_PERFIL_COMUN)) {
        return null;
    }

    fs.mkdirSync(CARPETA_BACKUPS_PERFIL, { recursive: true });

    const sello = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace(/T/g, '_')
    .replace(/Z$/, '');

    const destino = path.join(
        CARPETA_BACKUPS_PERFIL,
        `whatsapp-bot-antes-facebook-${sello}`
    );

    console.log(`[Migración Facebook] Creando backup de WhatsApp en: ${destino}`);

    fs.cpSync(
        CARPETA_PERFIL_COMUN,
        destino,
        {
            recursive: true,
            force: false,
                errorOnExist: true
        }
    );

    return destino;
}

function esCookieFacebook(cookie) {

    if (!cookie || typeof cookie !== 'object') return false;

    const dominio = String(cookie.domain || '').toLowerCase();

    return (
        dominio.includes('facebook.com') ||
        dominio.includes('fbcdn.net') ||
        dominio.includes('messenger.com')
    );
}

async function extraerSesionFacebookAntigua() {

    if (!FACEBOOK_ENABLED) return null;

    if (!fs.existsSync(CARPETA_SESION_FACEBOOK)) {
        console.log('[Migración Facebook] No existe la sesión antigua; no hay nada que migrar.');
        return null;
    }

    console.log('');
    console.log('='.repeat(70));
    console.log('MIGRANDO SESIÓN FACEBOOK ANTIGUA');
    console.log('='.repeat(70));
    console.log(`Origen: ${CARPETA_SESION_FACEBOOK}`);
    console.log(`Destino: ${CARPETA_PERFIL_COMUN}`);

    let navegadorMigracion = null;

    try {

        navegadorMigracion = await puppeteer.launch({
            //executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            headless: true,
            userDataDir: CARPETA_SESION_FACEBOOK,
            defaultViewport: { width: 1366, height: 900 },
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--no-first-run',
                    '--no-default-browser-check'
                ]
        });

        const paginas = await navegadorMigracion.pages();
        const pagina = paginas[0] || await navegadorMigracion.newPage();
        pagina.setDefaultTimeout(30000);

        await pagina.goto(
            FACEBOOK_ORIGEN_URL || 'https://www.facebook.com/',
            {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            }
        );

        await esperar(3000);

        const cookies = (await pagina.cookies()).filter(esCookieFacebook);

        let localStorage = {};

        try {
            localStorage = await pagina.evaluate(() => {
                const resultado = {};
                for (let i = 0; i < window.localStorage.length; i++) {
                    const clave = window.localStorage.key(i);
                    if (clave !== null) {
                        resultado[clave] = window.localStorage.getItem(clave);
                    }
                }
                return resultado;
            });
        } catch (error) {
            console.warn('[Migración Facebook] No se pudo leer localStorage:', error.message);
        }

        const urlFinal = pagina.url();
        const titulo = await pagina.title().catch(() => '');

        const sesionDisponible = cookies.some(cookie =>
        ['c_user', 'xs', 'fr', 'datr', 'sb'].includes(cookie.name)
        );

        console.log(`[Migración Facebook] URL obtenida: ${urlFinal}`);
        console.log(`[Migración Facebook] Título: ${titulo}`);
        console.log(`[Migración Facebook] Cookies Facebook: ${cookies.length}`);
        console.log(`[Migración Facebook] localStorage: ${Object.keys(localStorage).length} entradas`);
        console.log(`[Migración Facebook] Sesión detectable: ${sesionDisponible ? 'SÍ' : 'NO'}`);

        if (!sesionDisponible) {
            console.warn(
                '[Migración Facebook] La sesión antigua no parece estar autenticada. No se copiará nada.'
            );
            return null;
        }

        return {
            cookies,
            localStorage
        };

    } catch (error) {

        console.error(
            '[Migración Facebook] No fue posible leer la sesión antigua:',
            error.message
        );

        return null;

    } finally {

        if (navegadorMigracion) {
            try {
                await navegadorMigracion.close();
            } catch (error) {
                console.warn(
                    '[Migración Facebook] Error cerrando navegador temporal:',
                    error.message
                );
            }
        }
    }
}

async function aplicarSesionFacebookMigrada(pagina, datos) {

    if (!pagina || !datos) return false;

    let cookiesAplicadas = 0;

    try {
        if (Array.isArray(datos.cookies) && datos.cookies.length > 0) {
            await pagina.setCookie(...datos.cookies);
            cookiesAplicadas = datos.cookies.length;
        }
    } catch (error) {
        console.warn(
            '[Migración Facebook] Algunas cookies no pudieron aplicarse:',
            error.message
        );
    }

    try {
        await pagina.goto(
            'https://www.facebook.com/',
            {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            }
        );

        if (datos.localStorage && typeof datos.localStorage === 'object') {
            await pagina.evaluate((valores) => {
                for (const [clave, valor] of Object.entries(valores)) {
                    try {
                        window.localStorage.setItem(clave, String(valor));
                    } catch (_) {}
                }
            }, datos.localStorage);
        }

        console.log(
            `[Migración Facebook] Sesión aplicada al perfil compartido: ${cookiesAplicadas} cookies.`
        );

        return cookiesAplicadas > 0;

    } catch (error) {
        console.error(
            '[Migración Facebook] Error aplicando la sesión:',
            error.message
        );
        return false;
    }
}

async function prepararMigracionFacebook() {

    if (!FACEBOOK_ENABLED) return null;

    // Si ya migramos una vez, no volvemos a abrir un Chromium auxiliar.
    if (fs.existsSync(ARCHIVO_MIGRACION_FACEBOOK)) {
        console.log('[Migración Facebook] Migración anterior detectada; se conservará el perfil compartido.');
        return null;
    }

    if (!fs.existsSync(CARPETA_SESION_FACEBOOK)) {
        return null;
    }

    // El backup se crea ANTES de tocar el perfil compartido.
    try {
        const backup = crearBackupPerfilCompartido();
        if (backup) {
            console.log(`[Migración Facebook] Backup completado: ${backup}`);
        }
    } catch (error) {
        throw new Error(
            `No se pudo crear el backup del perfil de WhatsApp. Migración cancelada: ${error.message}`
        );
    }

    return await extraerSesionFacebookAntigua();
}

function marcarMigracionFacebookCompletada() {

    fs.writeFileSync(
        ARCHIVO_MIGRACION_FACEBOOK,
        JSON.stringify(
            {
                completada: true,
                fecha: new Date().toISOString(),
                       perfilCompartido: CARPETA_PERFIL_COMUN,
                       origen: CARPETA_SESION_FACEBOOK
            },
            null,
            2
        ),
        'utf8'
    );
}

function crearCarpetas() {

    for (const carpeta of [
        CARPETA_IMAGENES,
         CARPETA_IMAGENES_API,
         CARPETA_SESION,
         CARPETA_PERFIL_WHATSAPP,
         CARPETA_SESION_FACEBOOK
    ]) {

        if (!fs.existsSync(carpeta)) {
            fs.mkdirSync(
                carpeta,
                {
                    recursive: true
                }
            );
        }
    }
}

// ============================================================
// BLOQUEO DE INSTANCIA WHATSAPP
// ============================================================

function adquirirBloqueoWhatsApp() {
    if (fs.existsSync(ARCHIVO_BLOQUEO_WHATSAPP)) {
        const pid = Number(fs.readFileSync(ARCHIVO_BLOQUEO_WHATSAPP, 'utf8').trim());
        if (Number.isInteger(pid) && pid > 0) {
            try {
                process.kill(pid, 0);
                throw new Error(`Ya existe otra instancia del bot ejecutándose (PID ${pid}).`);
            } catch (error) {
                if (error && error.message && error.message.startsWith('Ya existe otra instancia')) {
                    throw error;
                }
                if (!error || error.code !== 'ESRCH') {
                    throw error;
                }
            }
        }
        fs.unlinkSync(ARCHIVO_BLOQUEO_WHATSAPP);
    }

    try {
        fs.writeFileSync(ARCHIVO_BLOQUEO_WHATSAPP, String(process.pid), { flag: 'wx' });
    } catch (error) {
        if (error.code === 'EEXIST') {
            throw new Error('Ya existe otra instancia del bot ejecutándose. No se abrirá otra sesión de WhatsApp.');
        }
        throw error;
    }
}

function liberarBloqueoWhatsApp() {
    try {
        if (!fs.existsSync(ARCHIVO_BLOQUEO_WHATSAPP)) return;
        const pid = Number(fs.readFileSync(ARCHIVO_BLOQUEO_WHATSAPP, 'utf8').trim());
        if (pid === process.pid) fs.unlinkSync(ARCHIVO_BLOQUEO_WHATSAPP);
    } catch (error) {
        console.error('[WhatsApp] No se pudo liberar el bloqueo:', error.message);
    }
}

// ============================================================
// UTILIDADES
// ============================================================

function cargarJson(ruta, valorPorDefecto) {

    try {

        if (!fs.existsSync(ruta)) {
            return valorPorDefecto;
        }

        const contenido =
        fs.readFileSync(
            ruta,
            'utf8'
        );

        return JSON.parse(contenido);

    } catch (error) {

        console.error(
            `ERROR leyendo ${ruta}:`,
            error.message
        );

        return valorPorDefecto;
    }
}

function guardarJson(ruta, datos) {

    const temporal =
    `${ruta}.tmp`;

    fs.writeFileSync(
        temporal,
        JSON.stringify(
            datos,
            null,
            2
        ),
        'utf8'
    );

    fs.renameSync(
        temporal,
        ruta
    );
}

function obtenerHoraActual() {

    const ahora = new Date();

    const horas =
    String(
        ahora.getHours()
    ).padStart(2, '0');

    const minutos =
    String(
        ahora.getMinutes()
    ).padStart(2, '0');

    return `${horas}:${minutos}`;
}

function obtenerFechaActual() {

    const ahora = new Date();

    const año =
    ahora.getFullYear();

    const mes =
    String(
        ahora.getMonth() + 1
    ).padStart(2, '0');

    const dia =
    String(
        ahora.getDate()
    ).padStart(2, '0');

    return `${año}-${mes}-${dia}`;
}

function esperar(ms) {

    return new Promise(
        resolve => setTimeout(resolve, ms)
    );
}

// ============================================================
// ESTADO DE DESTINOS
// ============================================================

function obtenerClavePublicacion(publicacion) {

    /* Laravel genera una ocurrencia única por cada ejecución programada. */
    if (
        publicacion &&
        typeof publicacion.ocurrencia_id === 'string' &&
        publicacion.ocurrencia_id.trim() !== ''
    ) {
        return publicacion.ocurrencia_id.trim();
    }

    // Compatibilidad con respuestas antiguas de Laravel.
    return [
        publicacion?.id,
        publicacion?.fecha,
        publicacion?.hora
    ].join('_');
}

function obtenerRegistroEstado(
    estado,
    publicacion
) {
    const clave = obtenerClavePublicacion(publicacion);

    if (!estado[clave] || typeof estado[clave] !== 'object') {
        estado[clave] = {
            id: publicacion.id,
            ocurrencia_id: publicacion.ocurrencia_id || clave,
            fecha: obtenerFechaActual(),
            hora: publicacion.hora,
            whatsapp: false,
            facebook: false,
            facebookOrigenUrl: FACEBOOK_ORIGEN_URL,
            facebookUrlPublicacion: null,
            facebookOrigenPublicado: false,
            facebookGrupos: {},
            facebookAuditoriaV97: null
        };
    }

    if (typeof estado[clave].ocurrencia_id !== 'string' || estado[clave].ocurrencia_id === '') {
        estado[clave].ocurrencia_id = publicacion.ocurrencia_id || clave;
    }

    if (typeof estado[clave].whatsapp !== 'boolean') {
        estado[clave].whatsapp = estado[clave].enviada === true;
    }

    if (typeof estado[clave].facebook !== 'boolean') {
        estado[clave].facebook = false;
    }

    if (typeof estado[clave].facebookOrigenUrl !== 'string' || !estado[clave].facebookOrigenUrl) {
        estado[clave].facebookOrigenUrl = FACEBOOK_ORIGEN_URL;
    }

    if (!Object.prototype.hasOwnProperty.call(estado[clave], 'facebookUrlPublicacion')) {
        estado[clave].facebookUrlPublicacion = null;
    }

    if (typeof estado[clave].facebookOrigenPublicado !== 'boolean') {
        estado[clave].facebookOrigenPublicado = false;
    }

    if (!estado[clave].facebookGrupos || typeof estado[clave].facebookGrupos !== 'object') {
        estado[clave].facebookGrupos = {};
    }

    if (!Object.prototype.hasOwnProperty.call(estado[clave], 'facebookAuditoriaV97')) {
        estado[clave].facebookAuditoriaV97 = null;
    }

    return estado[clave];
}

function destinoFueEnviado(
    estado,
    publicacion,
    destino
) {
    const registro = estado[obtenerClavePublicacion(publicacion)];

    if (!registro) return false;

    return (
        registro.fecha === obtenerFechaActual() &&
        registro[destino] === true
    );
}

function facebookGrupoFueEnviado(
    estado,
    publicacion,
    grupo
) {
    const registro = estado[obtenerClavePublicacion(publicacion)];

    if (!registro || registro.fecha !== obtenerFechaActual()) {
        return false;
    }

    return registro.facebookGrupos?.[obtenerClaveFacebookGrupo(grupo)] === true;
}

function marcarDestinoComoEnviado(
    estado,
    publicacion,
    destino
) {
    const clave = obtenerClavePublicacion(publicacion);
    const registro = obtenerRegistroEstado(estado, publicacion);

    registro.fecha = obtenerFechaActual();
    registro[destino] = true;

    const destinos = obtenerDestinosPublicacion(publicacion);

    const facebookCompleto = !destinos.includes('facebook') ||
    obtenerGruposFacebookPublicacion(publicacion).every(
        grupo => registro.facebookGrupos?.[obtenerClaveFacebookGrupo(grupo)] === true
    );

    registro.facebook = facebookCompleto;

    registro.enviada =
    destinos.length > 0 &&
    destinos.every(destinoActual => {
        if (destinoActual === 'facebook') return facebookCompleto;
        return registro[destinoActual] === true;
    });

    estado[clave] = registro;
    guardarJson(ARCHIVO_ESTADO, estado);

    registrarPublicacionExitosa(
        publicacion,
        destino
    );
}

function marcarFacebookGrupoComoEnviado(
    estado,
    publicacion,
    grupo
) {
    const clave = obtenerClavePublicacion(publicacion);
    const registro = obtenerRegistroEstado(estado, publicacion);

    registro.fecha = obtenerFechaActual();
    registro.facebookGrupos[obtenerClaveFacebookGrupo(grupo)] = true;

    const grupos = obtenerGruposFacebookPublicacion(publicacion);

    registro.facebook =
    grupos.length > 0 &&
    grupos.every(
        grupoActual =>
        registro.facebookGrupos?.[obtenerClaveFacebookGrupo(grupoActual)] === true
    );

    const destinos = obtenerDestinosPublicacion(publicacion);

    registro.enviada =
    destinos.length > 0 &&
    destinos.every(destinoActual => {
        if (destinoActual === 'facebook') return registro.facebook === true;
        return registro[destinoActual] === true;
    });

    estado[clave] = registro;
    guardarJson(ARCHIVO_ESTADO, estado);

    registrarPublicacionExitosa(
        publicacion,
        'facebook'
    );
}

// ============================================================
// AUDITORÍA NO DESTRUCTIVA DEL ESTADO - V97
// ============================================================

function auditarEstadoV97(estado) {
    if (!estado || typeof estado !== 'object') return { cambios: 0, anomalías: 0 };

    let cambios = 0;
    let anomalias = 0;

    for (const [clave, registro] of Object.entries(estado)) {
        if (!registro || typeof registro !== 'object') {
            anomalias++;
            continue;
        }

        // Normalizar campos nuevos sin borrar información existente.
        if (typeof registro.facebookOrigenUrl !== 'string' || !registro.facebookOrigenUrl) {
            registro.facebookOrigenUrl = FACEBOOK_ORIGEN_URL;
            cambios++;
        }

        if (!Object.prototype.hasOwnProperty.call(registro, 'facebookUrlPublicacion')) {
            registro.facebookUrlPublicacion = null;
            cambios++;
        }

        // V92/V96 pudieron dejar un objeto de diagnóstico dentro de
        // facebookOrigenUrl. Lo conservamos y lo retiramos de la posición
        // reservada para una URL.
        if (registro.facebookOrigenUrl && typeof registro.facebookOrigenUrl === 'object') {
            registro.facebookAuditoriaV97 = registro.facebookAuditoriaV97 || {};
            registro.facebookAuditoriaV97.legacyFacebookOrigenUrl = registro.facebookOrigenUrl;
            registro.facebookAuditoriaV97.migradoEn = new Date().toISOString();
            registro.facebookOrigenUrl = FACEBOOK_ORIGEN_URL;
            cambios++;
        }

        // Si una versión anterior guardó accidentalmente un permalink en
        // facebookOrigenUrl, migrarlo al campo correcto.
        if (
            typeof registro.facebookOrigenUrl === 'string' &&
            /\/posts\/|\/permalink\.php|story_fbid=|\/photos\//i.test(registro.facebookOrigenUrl)
        ) {
            if (!registro.facebookUrlPublicacion) {
                registro.facebookUrlPublicacion = normalizarUrlPublicacionFacebook(registro.facebookOrigenUrl) || null;
            }
            registro.facebookOrigenUrl = FACEBOOK_ORIGEN_URL;
            cambios++;
        }

        if (!Object.prototype.hasOwnProperty.call(registro, 'facebookOrigenPublicado')) {
            registro.facebookOrigenPublicado = false;
            cambios++;
        }

        if (!registro.facebookGrupos || typeof registro.facebookGrupos !== 'object') {
            registro.facebookGrupos = {};
            cambios++;
        }

        // Si ya existen grupos marcados como enviados, hay evidencia de que
        // la publicación de origen fue aceptada. No se borra ni se reinterpreta
        // el historial; solo se hace explícito el estado.
        if (
            registro.facebookOrigenPublicado !== true &&
            Object.values(registro.facebookGrupos).some(v => v === true)
        ) {
            registro.facebookOrigenPublicado = true;
            registro.facebookAuditoriaV97 = registro.facebookAuditoriaV97 || {};
            registro.facebookAuditoriaV97.inferidoDesdeGruposEnviados = true;
            registro.facebookAuditoriaV97.inferidoEn = new Date().toISOString();
            cambios++;
        }
    }

    if (cambios > 0) {
        guardarJson(ARCHIVO_ESTADO, estado);
    }

    console.log(`[V97][Estado] Auditoría completada: ${Object.keys(estado).length} registros, ${cambios} ajuste(s) no destructivo(s), ${anomalias} anomalía(s).`);
    return { cambios, anomalias };
}

// ============================================================
// VALIDACIÓN DE CONFIGURACIÓN
// ============================================================

function validarConfiguracion() {

    console.log('');
    console.log(
        '='.repeat(70)
    );

    console.log(
        'VALIDANDO CONFIGURACIÓN'
    );

    console.log(
        '='.repeat(70)
    );

    if (!LARAVEL_API_URL) {

        throw new Error(
            'Falta la variable LARAVEL_API_URL.'
        );
    }

    if (!LARAVEL_API_TOKEN) {

        throw new Error(
            'Falta la variable LARAVEL_API_TOKEN.'
        );
    }

    console.log(
        `Laravel API: ${LARAVEL_API_URL}`
    );

    console.log(
        'Token API: configurado'
    );

    console.log(
        `WhatsApp: ${NOMBRE_GRUPO}`
    );

    console.log(
        `Facebook: ${FACEBOOK_ENABLED ? 'ACTIVADO' : 'DESACTIVADO'}`
    );

    if (FACEBOOK_ENABLED) {

        if (!FACEBOOK_ORIGEN_URL) {
            throw new Error(
                'FACEBOOK_ENABLED=true pero falta FACEBOOK_ORIGEN_URL.'
            );
        }

        console.log(
            `Facebook origen: ${FACEBOOK_ORIGEN_URL}`
        );

        console.log(
            `Facebook grupos destino: sincronizados desde Facebook y gestionados por Laravel/Filament`
        );

        console.log(
            `Facebook headless: ${FACEBOOK_HEADLESS ? 'true' : 'false'}`
        );

        console.log(
            `Facebook reintentos: ${FACEBOOK_REINTENTOS}`
        );
    }

    console.log('');
}

// ============================================================
// DESTINOS DE PUBLICACIÓN
// ============================================================

function normalizarDestino(valor) {
    if (typeof valor !== 'string') return '';
    return valor.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function obtenerDestinosPublicacion(publicacion) {
    if (!publicacion || typeof publicacion !== 'object') return [];

    const candidatos = [
        publicacion.destino,
        publicacion.canal,
        publicacion.tipo_destino,
        publicacion.tipoDestino,
        publicacion.channels,
        publicacion.canales,
        publicacion.destinos
    ];

    let valores = [];
    for (const candidato of candidatos) {
        if (Array.isArray(candidato)) {
            valores.push(...candidato);
        } else if (typeof candidato === 'string') {
            valores.push(...candidato.split(/[,+|]/));
        } else if (candidato && typeof candidato === 'object') {
            for (const [clave, habilitado] of Object.entries(candidato)) {
                if (habilitado === true) {
                    valores.push(clave);
                }
            }
        }
    }

    valores = valores.map(normalizarDestino).filter(Boolean);
    if (valores.length === 0) return ['whatsapp'];

    const destinos = new Set();
    for (const valor of valores) {
        if (['whatsapp', 'wa', 'whatsapp_web'].includes(valor)) destinos.add('whatsapp');
        if (['facebook', 'fb'].includes(valor)) destinos.add('facebook');
        if (['ambos', 'both', 'todos', 'all', 'whatsapp_facebook', 'facebook_whatsapp'].includes(valor)) {
            destinos.add('whatsapp');
            destinos.add('facebook');
        }
    }
    return [...destinos];
}

function obtenerGruposFacebookPublicacion(publicacion) {
    if (!publicacion || typeof publicacion !== 'object') return [];

    const candidatos = [
        publicacion.facebook_grupos,
        publicacion.facebookGrupos,
        publicacion.facebook_groups,
        publicacion.facebookGroups,
        publicacion.facebook_destinos,
        publicacion.facebookDestinos,
    ];

    const valores = [];

    for (const candidato of candidatos) {
        if (Array.isArray(candidato)) {
            valores.push(...candidato);
        } else if (candidato && typeof candidato === 'object') {
            valores.push(candidato);
        } else if (typeof candidato === 'string' && candidato.trim()) {
            valores.push(...candidato.split(/[,+|]/));
        }
    }

    const grupos = [];
    const claves = new Set();

    for (const valor of valores) {
        let grupo;

        if (valor && typeof valor === 'object') {
            const url = String(valor.url ?? valor.href ?? '').trim();
            const facebookId = String(
                valor.facebook_id ?? valor.facebookId ?? valor.group_id ?? valor.groupId ?? ''
            ).trim();

            grupo = {
                id: valor.id ?? null,
                facebook_id: facebookId || extraerIdGrupoFacebook(url),
                nombre: limpiarNombreGrupoFacebook(
                    String(valor.nombre ?? valor.name ?? '').trim()
                ),
                url: url || null,
            };
        } else {
            const texto = limpiarNombreGrupoFacebook(String(valor || '').trim());
            grupo = {
                id: null,
                facebook_id: null,
                nombre: texto,
                url: null,
            };
        }

        // Los nombres de relleno no son destinos válidos, aunque incluyan un ID.
        if (!grupo.nombre || /^grupo\s+facebook(?:\s+\d+)?$/i.test(grupo.nombre)) continue;

        // Si Facebook/Laravel conserva un nombre contaminado, nunca lo
        // llevamos al selector. El ID/URL tiene prioridad como identidad.
        if (!grupo.facebook_id && grupo.url) {
            grupo.facebook_id = extraerIdGrupoFacebook(grupo.url);
        }

        const clave = normalizarDestino(
            grupo.facebook_id || grupo.url || grupo.nombre
        );

        if (!clave || claves.has(clave)) continue;
        claves.add(clave);
        grupos.push(grupo);
    }

    return grupos;
}

function normalizarGruposFacebookPublicacion(grupos) {
    if (!Array.isArray(grupos)) return [];
    const salida = [];
    const vistos = new Set();

    for (const grupo of grupos) {
        if (!grupo || typeof grupo !== 'object') continue;
        const url = String(grupo.url || grupo.href || '').trim();
        const facebookId = String(
            grupo.facebook_id || grupo.facebookId || grupo.group_id || grupo.groupId ||
            extraerIdGrupoFacebook(url) || ''
        ).trim();
        const nombre = limpiarNombreGrupoFacebook(grupo.nombre || grupo.name || '');
        if (!facebookId && !url) continue;
        if (!nombre || /^grupo\s+facebook(?:\s+\d+)?$/i.test(nombre)) continue;

        const clave = normalizarDestino(facebookId || url);
        if (!clave || vistos.has(clave)) continue;
        vistos.add(clave);
        salida.push({
            id: grupo.id ?? null,
            facebook_id: facebookId || extraerIdGrupoFacebook(url),
            nombre,
            url: url || (facebookId ? `https://www.facebook.com/groups/${facebookId}` : null),
        });
    }

    return salida;
}

function obtenerClaveFacebookGrupo(grupo) {
    return normalizarDestino(
        grupo?.facebook_id || grupo?.url || grupo?.id || grupo?.nombre || ''
    );
}

function requiereDestino(publicacion, destino) {
    return obtenerDestinosPublicacion(publicacion).includes(destino);
}

function facebookPublicacionFueEnviada(
    estado,
    publicacion
) {
    const grupos = obtenerGruposFacebookPublicacion(publicacion);

    if (grupos.length === 0) return false;

    return grupos.every(
        grupo => facebookGrupoFueEnviado(
            estado,
            publicacion,
            grupo
        )
    );
}


// ============================================================
// SINCRONIZACIÓN FACEBOOK -> LARAVEL
// ============================================================

let ultimaSincronizacionGruposFacebook = null;
let temporizadorSincronizacionGruposFacebook = null;

function limpiarNombreGrupoFacebook(valor) {
    let nombre = String(valor || '')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    if (!nombre) return '';

    // Facebook agrega información dinámica de la interfaz al texto del
    // enlace del grupo. Esa información NO forma parte del nombre real.
    // Ejemplos observados:
    // "You last visited fa 22 setmanes Mostra el grup"
    // "Last active Fa 8 hores"
    // "You last visited 5 weeks ago See group"
    nombre = nombre.replace(
        /\s+(?:you\s+last\s+visited|last\s+active|mostra\s+el\s+grup|see\s+group|show\s+group|ver\s+(?:el\s+)?grupo|mostrar\s+(?:el\s+)?grupo)\b.*$/i,
        ''
    ).trim();

    // Algunas traducciones de Facebook pueden aparecer sin el prefijo
    // anterior. También eliminamos estos sufijos si quedaron al final.
    nombre = nombre.replace(
        /\s+(?:mostra\s+el\s+grup|see\s+group|show\s+group|ver\s+(?:el\s+)?grupo|mostrar\s+(?:el\s+)?grupo)\s*$/i,
        ''
    ).trim();

    return nombre;
}

function normalizarGrupoFacebookDescubierto(grupo) {
    if (!grupo) return null;

    const nombre = limpiarNombreGrupoFacebook(grupo.nombre);
    const url = grupo.url ? String(grupo.url).trim() : null;
    const facebookId = grupo.facebook_id
    ? String(grupo.facebook_id).trim()
    : null;

    if (!nombre || /^grupo\s+facebook(?:\s+\d+)?$/i.test(nombre) || (!url && !facebookId)) return null;

    const idFinal = facebookId || extraerIdGrupoFacebook(url);

    // Si aún así no hay ID utilizable, generamos uno determinista
    // a partir del nombre para no romper el pipeline de Laravel.
    const idSeguro = idFinal
    || 'slug_' + nombre
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 120);

    return {
        facebook_id: idSeguro,
        nombre,
        url,
    };
}

function extraerIdGrupoFacebook(url) {
    if (!url) return null;

    const texto = String(url);

    // Caso 1: /groups/123456789/
    const matchNumerico = texto.match(/\/groups\/(\d+)/i);
    if (matchNumerico) return matchNumerico[1];

    // Caso 2: /groups/nombre-del-grupo/  -> usamos el slug
    const matchSlug = texto.match(/\/groups\/([^/?#]+)/i);
    if (matchSlug) {
        const slug = decodeURIComponent(matchSlug[1]).trim();
        // Evitamos rutas reservadas de Facebook.
        if (!/^(feed|joins|discover|create|notifications|settings)$/i.test(slug)) {
            return slug;
        }
    }

    return null;
}

async function descubrirGruposFacebookParaSincronizacion(page, timeout = 30000) {

    const rutas = [
        'https://www.facebook.com/groups/joins/',
        'https://www.facebook.com/groups/feed/'
    ];

    for (const ruta of rutas) {
        try {
            console.log(`[Facebook] Sincronización: abriendo ${ruta}`);

            await prepararNavegacionFacebook(page);
            await page.goto(ruta, {
                waitUntil: 'domcontentloaded',
                timeout: FACEBOOK_TIMEOUT_MS
            });

            // Facebook monta la lista mediante React después de domcontentloaded.
            await esperar(5000);

            if (/login/i.test(page.url())) {
                throw new Error('La sesión de Facebook no está autenticada.');
            }

            const grupos = [];
            const vistosGrupos = new Set();
            const inicioRuta = Date.now();

            for (let vuelta = 0; vuelta < 14 && Date.now() - inicioRuta < timeout + 25000; vuelta++) {

                const encontrados = await page.evaluate(() => {

                    const normalizar = valor => String(valor || '')
                        .replace(/[\u200B-\u200D\uFEFF]/g, '')
                        .replace(/\u00a0/g, ' ')
                        .replace(/\s+/g, ' ')
                        .trim();

                    const visible = el => {
                        if (!el) return false;
                        const r = el.getBoundingClientRect();
                        const s = getComputedStyle(el);
                        return r.width > 5 && r.height > 5 &&
                            s.display !== 'none' &&
                            s.visibility !== 'hidden' &&
                            s.opacity !== '0';
                    };

                    const salida = [];
                    const vistos = new Set();

                    const agregar = (href, texto, origen = '') => {
                        href = String(href || '').trim();
                        if (!href) return;

                        try {
                            href = new URL(href, location.origin).href;
                        } catch (_) {
                            return;
                        }

                        if (!/facebook\.com\/groups\//i.test(href)) return;

                        const limpioHref = href
                            .replace(/[?#].*$/, '')
                            .replace(/\/$/, '');

                        if (/\/groups\/(feed|joins|discover|create|notifications|settings)$/i.test(limpioHref)) {
                            return;
                        }

                        const idMatch = limpioHref.match(/\/groups\/(\d+)/i);
                        const facebookId = idMatch ? idMatch[1] : null;

                        // No usamos el texto completo del contenedor: Facebook mezcla
                        // nombre + "You last visited" + "See group" en el mismo nodo.
                        let nombre = normalizar(texto);

                        // No inventar nombres a partir del ID: el fallback genera
                        // entradas falsas como "Grupo Facebook 123..." en Filament.
                        if (!nombre || /^grupo\s+facebook(?:\s+\d+)?$/i.test(nombre)) return;

                        // Limpieza local adicional antes de enviar el registro al Node.
                        nombre = nombre
                            .replace(/\s+(?:you\s+last\s+visited|last\s+active|mostra\s+el\s+grup|see\s+group|show\s+group|ver\s+(?:el\s+)?grupo|mostrar\s+(?:el\s+)?grupo)\b.*$/i, '')
                            .replace(/\s+(?:mostra\s+el\s+grup|see\s+group|show\s+group|ver\s+(?:el\s+)?grupo|mostrar\s+(?:el\s+)?grupo)\s*$/i, '')
                            .trim();

                        if (!nombre) return;

                        const clave = facebookId || limpioHref;
                        if (vistos.has(clave)) return;
                        vistos.add(clave);

                        salida.push({
                            facebook_id: facebookId,
                            nombre: nombre.slice(0, 255),
                            url: limpioHref,
                            origen
                        });
                    };

                    // 1. Enlaces reales.
                    for (const a of document.querySelectorAll('a[href]')) {
                        if (!visible(a)) continue;
                        const href = a.href || a.getAttribute('href') || '';
                        if (!/facebook\.com\/groups\//i.test(href)) continue;

                        let texto = normalizar(a.innerText || a.textContent || '');
                        const nombrePorAtributo = normalizar(
                            a.querySelector('[dir="auto"]')?.innerText ||
                            a.getAttribute('title') ||
                            a.getAttribute('aria-label') ||
                            ''
                        );
                        // Algunas variantes de Facebook muestran solo "See group"
                        // como texto visible y guardan el nombre real en title/aria-label.
                        const primeraLinea = texto.split(/\n+/)[0] || '';
                        if (
                            !texto ||
                            /^(?:see group|show group|mostra el grup|ver (?:el )?grupo|mostrar (?:el )?grupo)$/i.test(primeraLinea)
                        ) {
                            texto = nombrePorAtributo;
                        }
                        // Si el enlace contiene varias líneas, normalmente la primera
                        // es el nombre del grupo.
                        if (texto.includes('\n')) texto = texto.split(/\n+/)[0];
                        agregar(href, texto, 'a[href]');
                    }

                    // 2. Elementos role=link. Facebook usa estos nodos en algunas
                    // versiones de la página aunque no sean <a>.
                    for (const el of document.querySelectorAll('[role="link"]')) {
                        if (!visible(el)) continue;
                        const candidatos = [
                            el.getAttribute('href'),
                            el.getAttribute('data-href'),
                            el.getAttribute('data-url'),
                            el.getAttribute('data-testid')
                        ];
                        const texto = normalizar(
                            el.innerText || el.textContent ||
                            el.getAttribute('title') || el.getAttribute('aria-label') || ''
                        );
                        for (const href of candidatos) {
                            if (/groups\//i.test(String(href || ''))) {
                                agregar(href, texto.split(/\n+/)[0], '[role=link]');
                            }
                        }
                    }

                    // 3. Cualquier atributo data-href/data-url con una ruta de grupo.
                    for (const el of document.querySelectorAll('[data-href], [data-url]')) {
                        if (!visible(el)) continue;
                        const href = el.getAttribute('data-href') || el.getAttribute('data-url') || '';
                        if (!/groups\//i.test(href)) continue;
                        agregar(
                            href,
                            normalizar(
                                el.innerText || el.textContent ||
                                el.getAttribute('title') || el.getAttribute('aria-label') || ''
                            ).split(/\n+/)[0],
                            'data-href'
                        );
                    }

                    // 4. Fallback: buscar URLs de grupos dentro del HTML/atributos.
                    // Esto cubre estados donde React todavía no convirtió la ruta en <a>.
                    const html = document.documentElement?.outerHTML || '';
                    const regex = /\/groups\/(\d+)/gi;
                    let match;
                    let contador = 0;
                    while ((match = regex.exec(html)) && contador < 300) {
                        const id = match[1];
                        agregar(`/groups/${id}/`, '', 'html');
                        contador++;
                    }

                    return salida;
                }).catch(error => {
                    console.warn(`[Facebook] Error inspeccionando DOM de grupos: ${error.message}`);
                    return [];
                });

                for (const grupo of encontrados) {
                    const normalizado = normalizarGrupoFacebookDescubierto(grupo);
                    if (!normalizado) continue;

                    const clave = normalizado.facebook_id || normalizado.url || normalizado.nombre;
                    if (!clave || vistosGrupos.has(clave)) continue;

                    vistosGrupos.add(clave);
                    grupos.push(normalizado);
                }

                if (encontrados.length > 0) {
                    console.log(`[Facebook] Sincronización: ${encontrados.length} candidato(s) detectado(s) en esta pasada; acumulados: ${grupos.length}.`);
                }

                // Desplazamos tanto la página como los contenedores internos. Facebook
                // utiliza listas virtualizadas y puede crear los enlaces únicamente
                // después del scroll.
                const desplazado = await page.evaluate(() => {
                    const elementos = Array.from(document.querySelectorAll('*'));
                    const scrollables = elementos
                        .filter(el => {
                            const r = el.getBoundingClientRect();
                            const s = getComputedStyle(el);
                            return r.width >= 250 && r.height >= 150 &&
                                s.display !== 'none' &&
                                s.visibility !== 'hidden' &&
                                el.scrollHeight > el.clientHeight + 60;
                        })
                        .sort((a, b) => {
                            const ar = a.getBoundingClientRect();
                            const br = b.getBoundingClientRect();
                            return (br.width * br.height) - (ar.width * ar.height);
                        });

                    let cambio = false;
                    for (const el of scrollables.slice(0, 8)) {
                        const antes = el.scrollTop;
                        const paso = Math.max(350, Math.floor(el.clientHeight * 0.75));
                        el.scrollTop = Math.min(el.scrollTop + paso, el.scrollHeight - el.clientHeight);
                        if (el.scrollTop > antes + 2) cambio = true;
                    }

                    const antesPagina = window.scrollY;
                    window.scrollTo(0, document.body.scrollHeight);
                    if (window.scrollY > antesPagina + 2) cambio = true;

                    return cambio;
                }).catch(() => false);

                if (desplazado) {
                    console.log(`[Facebook] Scroll ${vuelta + 1}: buscando más grupos...`);
                    await esperar(900);
                } else {
                    await esperar(1200);
                }
            }

            if (grupos.length) {
                console.log(`[Facebook] Sincronización: ${grupos.length} grupo(s) detectado(s) en ${ruta}.`);
                return grupos;
            }

            // Diagnóstico útil: no continuamos diciendo simplemente "no expuso grupos".
            const diagnostico = await page.evaluate(() => ({
                url: location.href,
                titulo: document.title,
                enlacesGrupo: document.querySelectorAll('a[href*="/groups/"]').length,
                enlacesRolGrupo: document.querySelectorAll('[role="link"][href*="/groups/"], [role="link"][data-href*="/groups/"]').length,
                dataHrefGrupo: document.querySelectorAll('[data-href*="/groups/"], [data-url*="/groups/"]').length,
                textoGrupos: /grupos|groups|joined|unidos|tus grupos|your groups/i.test(document.body?.innerText || ''),
                textoInicio: String(document.body?.innerText || '').slice(0, 500)
            })).catch(() => null);

            if (diagnostico) {
                console.warn(`[Facebook] Diagnóstico de ${ruta}:`, JSON.stringify(diagnostico));
            }

            console.warn('[Facebook] No se encontraron grupos reales en el DOM de esta ruta.');

        } catch (error) {
            console.warn(`[Facebook] No se pudo sincronizar desde ${ruta}: ${error.message}`);
        }
    }

    return [];
}

async function sincronizarGruposFacebookConLaravel(grupos) {
    if (!LARAVEL_API_URL || !LARAVEL_API_TOKEN) {
        throw new Error('La configuración de Laravel API está incompleta.');
    }

    const url = `${LARAVEL_API_URL}${FACEBOOK_GRUPOS_SYNC_ENDPOINT}`;

    const response = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(BOT_API_TIMEOUT_MS),
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${LARAVEL_API_TOKEN}`,
        },
        body: JSON.stringify({
            grupos,
            origen: 'wbot',
            sincronizado_en: new Date().toISOString(),
        }),
    });

    const body = await response.text();

    if (!response.ok) {
        throw new Error(
            `Laravel respondió HTTP ${response.status}: ${body.slice(0, 500)}`
        );
    }

    let datos = {};
    try {
        datos = body ? JSON.parse(body) : {};
    } catch (_) {}

    return datos;
}

async function sincronizarGruposFacebook() {
    if (!FACEBOOK_ENABLED || !facebookBrowser) {
        return { success: false, total: 0, motivo: 'facebook_no_disponible' };
    }

    console.log('');
    console.log('='.repeat(70));
    console.log('SINCRONIZANDO GRUPOS DE FACEBOOK CON LARAVEL');
    console.log('='.repeat(70));

    if (!facebookSyncPage || facebookSyncPage.isClosed()) {
        facebookSyncPage = await facebookBrowser.newPage();
        facebookSyncPage.setDefaultTimeout(FACEBOOK_TIMEOUT_MS);
        configurarDialogosFacebook(facebookSyncPage);
    }

    const grupos = await descubrirGruposFacebookParaSincronizacion(
        facebookSyncPage,
        FACEBOOK_TIMEOUT_MS
    );

    if (!grupos.length) {
        console.warn('[Facebook] No se encontraron grupos; Laravel no será sobrescrito.');
        return { success: false, total: 0, motivo: 'sin_grupos' };
    }

    const resultado = await sincronizarGruposFacebookConLaravel(grupos);

    ultimaSincronizacionGruposFacebook = new Date();

    console.log(
        `[Facebook] ✓ Catálogo sincronizado con Laravel: ${grupos.length} grupo(s).`
    );

    return {
        success: true,
        total: grupos.length,
        grupos,
        respuesta: resultado,
    };
}

function iniciarSincronizacionPeriodicaGruposFacebook() {
    if (temporizadorSincronizacionGruposFacebook) {
        clearInterval(temporizadorSincronizacionGruposFacebook);
    }

    temporizadorSincronizacionGruposFacebook = setInterval(async () => {
        try {
            await sincronizarGruposFacebook();
        } catch (error) {
            console.error('[Facebook] Error en sincronización periódica de grupos:', error.message);
        }
    }, FACEBOOK_SYNC_INTERVAL_MS);

    if (typeof temporizadorSincronizacionGruposFacebook.unref === 'function') {
        temporizadorSincronizacionGruposFacebook.unref();
    }

    console.log(
        `[Facebook] Sincronización automática de grupos cada ${Math.round(FACEBOOK_SYNC_INTERVAL_MS / 60000)} minuto(s).`
    );
}

function detenerSincronizacionPeriodicaGruposFacebook() {
    if (temporizadorSincronizacionGruposFacebook) {
        clearInterval(temporizadorSincronizacionGruposFacebook);
        temporizadorSincronizacionGruposFacebook = null;
    }
}

// ============================================================
// API LARAVEL
// ============================================================

let publicacionesCache = [];

let ultimaActualizacionApi = null;

async function obtenerPublicacionesDesdeLaravel() {

    if (
        !LARAVEL_API_URL ||
        !LARAVEL_API_TOKEN
    ) {

        throw new Error(
            'La configuración de Laravel API está incompleta.'
        );
    }

    const url =
    `${LARAVEL_API_URL}/api/bot/publicaciones`;

    console.log('');
    console.log(
        '='.repeat(70)
    );

    console.log(
        'CONSULTANDO API LARAVEL'
    );

    console.log(
        '='.repeat(70)
    );

    console.log(
        `URL: ${url}`
    );

    const controller =
    new AbortController();

    const timeout =
    setTimeout(
        () => controller.abort(),
               BOT_API_TIMEOUT_MS
    );

    try {

        const response =
        await fetch(
            url,
            {
                method: 'GET',

                headers: {
                    'Accept':
                    'application/json',

                    'Authorization':
                    `Bearer ${LARAVEL_API_TOKEN}`
                },

                signal:
                controller.signal
            }
        );

        if (!response.ok) {

            const body =
            await response
            .text()
            .catch(
                () => ''
            );

            throw new Error(
                `Laravel respondió HTTP ${response.status}: ` +
                `${body || response.statusText}`
            );
        }

        const payload =
        await response.json();

        if (
            !payload ||
            !Array.isArray(
                payload.data
            )
        ) {

            throw new Error(
                'Respuesta inválida de Laravel: ' +
                '"data" debe ser un array.'
            );
        }

        const publicacionesValidas =
        payload.data
        .filter(
            publicacion =>
            validarPublicacion(
                publicacion
            )
        );

        const ocurrencias = new Set();
        const publicaciones = publicacionesValidas.filter(publicacion => {
            const clave = publicacion.ocurrencia_id.trim();

            if (ocurrencias.has(clave)) {
                console.warn(`[API] Ocurrencia duplicada ignorada: ${clave}`);
                return false;
            }

            ocurrencias.add(clave);
            return true;
        }).sort(
            (a, b) => {

                const fechaA =
                `${a.fecha} ${a.hora}`;

                const fechaB =
                `${b.fecha} ${b.hora}`;

                return fechaA.localeCompare(
                    fechaB
                );
            }
        );

        console.log('');
        console.log(
            `Publicaciones recibidas: ${publicaciones.length}`
        );

        return publicaciones;

    } finally {

        clearTimeout(timeout);
    }
}

// ============================================================
// VALIDAR PUBLICACIÓN
// ============================================================

function validarPublicacion(publicacion) {

    if (
        !publicacion ||
        typeof publicacion !== 'object'
    ) {

        return false;
    }

    if (
        !Number.isInteger(
            publicacion.id
        )
    ) {

        console.warn(
            '[API] Publicación descartada: ID inválido.'
        );

        return false;
    }

    if (
        typeof publicacion.ocurrencia_id !== 'string' ||
        publicacion.ocurrencia_id.trim() === ''
    ) {

        console.warn(
            `[API] Publicación ${publicacion.id}: ` +
            'ocurrencia_id inválido o ausente.'
        );

        return false;
    }

    if (
        typeof publicacion.fecha !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(
            publicacion.fecha
        )
    ) {

        console.warn(
            `[API] Publicación ${publicacion.id}: ` +
            'fecha inválida.'
        );

        return false;
    }

    if (
        typeof publicacion.hora !== 'string' ||
        !/^\d{2}:\d{2}$/.test(
            publicacion.hora
        )
    ) {

        console.warn(
            `[API] Publicación ${publicacion.id}: ` +
            'hora inválida.'
        );

        return false;
    }

    if (
        typeof publicacion.texto !== 'string'
    ) {

        console.warn(
            `[API] Publicación ${publicacion.id}: ` +
            'texto inválido.'
        );

        return false;
    }

    if (
        typeof publicacion.imagen !== 'string' ||
        publicacion.imagen.length === 0
    ) {

        console.warn(
            `[API] Publicación ${publicacion.id}: ` +
            'imagen inválida.'
        );

        return false;
    }

    const destinos = obtenerDestinosPublicacion(publicacion);

    if (destinos.length === 0) {
        console.warn(
            `[API] Publicación ${publicacion.id}: no tiene un destino válido.`
        );
        return false;
    }

    return true;
}

// ============================================================
// ACTUALIZAR CACHE
// ============================================================

async function actualizarPublicaciones() {

    try {

        const publicaciones =
        await obtenerPublicacionesDesdeLaravel();

        publicacionesCache =
        publicaciones;

        ultimaActualizacionApi =
        new Date();

        console.log('');
        console.log(
            '='.repeat(70)
        );

        console.log(
            'PUBLICACIONES ACTUALIZADAS'
        );

        console.log(
            '='.repeat(70)
        );

        if (
            publicaciones.length === 0
        ) {

            console.log(
                'No hay publicaciones activas.'
            );

            return;
        }

        for (
            const publicacion
            of publicaciones
        ) {

            console.log(
                `- ID ${publicacion.id} | ` +
                `Ocurrencia: ${publicacion.ocurrencia_id} | ` +
                `${publicacion.fecha} ` +
                `${publicacion.hora} | ` +
                `Destino: ${obtenerDestinosPublicacion(publicacion).join(', ')}`
            );
        }

        console.log('');
        console.log(
            `Última actualización: ` +
            `${ultimaActualizacionApi.toLocaleString()}`
        );

    } catch (error) {

        console.error('');
        console.error(
            '='.repeat(70)
        );

        console.error(
            'ERROR ACTUALIZANDO PUBLICACIONES'
        );

        console.error(
            '='.repeat(70)
        );

        console.error(
            error.message
        );

        if (
            publicacionesCache.length > 0
        ) {

            console.log('');
            console.log(
                'Se conservará la última programación válida en memoria.'
            );

        } else {

            console.log('');
            console.log(
                'Todavía no existe una programación válida en memoria.'
            );
        }
    }
}

// ============================================================
// WHATSAPP - BUSCAR GRUPO
// ============================================================

async function buscarGrupo(client) {

    console.log('');
    console.log(
        '='.repeat(70)
    );

    console.log(
        'BUSCANDO GRUPO DE WHATSAPP'
    );

    console.log(
        '='.repeat(70)
    );

    console.log(
        `Nombre buscado: ${NOMBRE_GRUPO}`
    );

    const MAX_INTENTOS = 10;

    const ESPERA_ENTRE_INTENTOS = 5000;

    for (
        let intento = 1;
    intento <= MAX_INTENTOS;
    intento++
    ) {

        console.log('');

        console.log(
            `Intento ${intento}/${MAX_INTENTOS} - ` +
            `esperando sincronización de chats...`
        );

        try {

            const grupos =
            await client.listChats({
                onlyGroups: true
            });

            console.log(
                `Grupos recibidos: ${grupos.length}`
            );

            if (
                grupos.length > 0
            ) {

                const grupoEncontrado =
                grupos.find(
                    grupo => {

                        const nombre =
                        grupo.name ||
                        grupo.formattedTitle ||
                        grupo.groupMetadata?.subject ||
                        '';

        return (
            nombre.trim() ===
            NOMBRE_GRUPO.trim()
        );
                    }
                );

                if (
                    grupoEncontrado
                ) {

                    const grupoId =
                    grupoEncontrado.id?._serialized ||
                    grupoEncontrado.id?.user ||
                    grupoEncontrado.id;

                    console.log('');
                    console.log(
                        '='.repeat(70)
                    );

                    console.log(
                        'GRUPO DE WHATSAPP ENCONTRADO'
                    );

                    console.log(
                        '='.repeat(70)
                    );

                    console.log(
                        `Nombre: ${
                            grupoEncontrado.name ||
                            grupoEncontrado.formattedTitle ||
                            grupoEncontrado.groupMetadata?.subject ||
                            NOMBRE_GRUPO
                        }`
                    );

                    console.log(
                        `ID: ${grupoId}`
                    );

                    return grupoId;
                }

                console.log(
                    `Los grupos están disponibles, pero no aparece "${NOMBRE_GRUPO}".`
                );

            } else {

                console.log(
                    'Todavía no hay grupos disponibles para la API.'
                );
            }

        } catch (error) {

            console.error(
                `Error consultando grupos ` +
                `en intento ${intento}:`,
                error.message
            );
        }

        if (
            intento < MAX_INTENTOS
        ) {

            console.log(
                `Esperando ` +
                `${ESPERA_ENTRE_INTENTOS / 1000} segundos...`
            );

            await esperar(
                ESPERA_ENTRE_INTENTOS
            );
        }
    }

    throw new Error(
        `No se encontró el grupo "${NOMBRE_GRUPO}" ` +
        `después de ${MAX_INTENTOS} intentos.`
    );
}

// ============================================================
// IMÁGENES
// ============================================================

function obtenerNombreImagenDesdeUrl(url) {

    try {

        const urlObj =
        new URL(url);

        let nombre =
        path.basename(
            urlObj.pathname
        );

        if (
            !nombre ||
            nombre === '/'
        ) {

            nombre =
            `publicacion_${Date.now()}.jpg`;
        }

        nombre =
        nombre.replace(
            /[^a-zA-Z0-9._-]/g,
            '_'
        );

        return nombre;

    } catch (error) {

        return `publicacion_${Date.now()}.jpg`;
    }
}

async function descargarImagenDesdeLaravel(
    publicacion
) {

    const url =
    publicacion.imagen;

    if (!url) {

        throw new Error(
            `La publicación ${publicacion.id} ` +
            `no tiene imagen.`
        );
    }

    const nombreOriginal =
    obtenerNombreImagenDesdeUrl(
        url
    );

    const identificadorImagen =
    publicacion.ocurrencia_id ||
    `${publicacion.id}_${publicacion.fecha}_${publicacion.hora}`;

    const nombreArchivo =
    `${identificadorImagen}_${nombreOriginal}`
    .replace(
        /[^a-zA-Z0-9._-]/g,
        '_'
    );

    const rutaDestino =
    path.join(
        CARPETA_IMAGENES_API,
        nombreArchivo
    );

    if (
        fs.existsSync(rutaDestino)
    ) {

        const estadisticas =
        fs.statSync(
            rutaDestino
        );

        if (
            estadisticas.size > 0
        ) {

            console.log(
                `Imagen ya descargada: ${rutaDestino}`
            );

            return rutaDestino;
        }
    }

    console.log('');
    console.log(
        'DESCARGANDO IMAGEN'
    );

    console.log(
        `URL: ${url}`
    );

    console.log(
        `Destino: ${rutaDestino}`
    );

    const controller =
    new AbortController();

    const timeout =
    setTimeout(
        () => controller.abort(),
               30000
    );

    try {

        const response =
        await fetch(
            url,
            {
                method: 'GET',

                headers: {
                    'Accept':
                    'image/*'
                },

                signal:
                controller.signal
            }
        );

        if (!response.ok) {

            throw new Error(
                `HTTP ${response.status} ` +
                `${response.statusText}`
            );
        }

        const buffer =
        Buffer.from(
            await response.arrayBuffer()
        );

        if (
            buffer.length === 0
        ) {

            throw new Error(
                'Laravel devolvió una imagen vacía.'
            );
        }

        fs.writeFileSync(
            rutaDestino,
            buffer
        );

        console.log(
            `Imagen descargada correctamente: ` +
            `${buffer.length.toLocaleString()} bytes`
        );

        return rutaDestino;

    } finally {

        clearTimeout(timeout);
    }
}

function comprobarImagen(rutaImagen) {

    if (
        !fs.existsSync(rutaImagen)
    ) {

        throw new Error(
            `No existe la imagen:\n${rutaImagen}`
        );
    }

    const estadisticas =
    fs.statSync(
        rutaImagen
    );

    if (
        estadisticas.size === 0
    ) {

        throw new Error(
            `La imagen está vacía:\n${rutaImagen}`
        );
    }

    return estadisticas.size;
}

// ============================================================
// WHATSAPP - ENVÍO
// ============================================================

async function enviarImagenWhatsApp(
    client,
    grupoId,
    publicacion,
    rutaImagen
) {

    const texto =
    publicacion.texto || '';

    comprobarImagen(
        rutaImagen
    );

    console.log('');
    console.log(
        '='.repeat(70)
    );

    console.log(
        'ENVÍO DE PUBLICACIÓN A WHATSAPP'
    );

    console.log(
        '='.repeat(70)
    );

    console.log(
        `ID      : ${publicacion.id}`
    );

    console.log(
        `Grupo   : ${NOMBRE_GRUPO}`
    );

    console.log(
        `Imagen  : ${rutaImagen}`
    );

    console.log(
        `Texto   : ${texto}`
    );

    const resultado =
    await client.sendImage(
        grupoId,
        rutaImagen,
        path.basename(rutaImagen),
                           texto
    );

    console.log(
        'WhatsApp: publicación enviada.'
    );

    return resultado;
}

// ============================================================
// FACEBOOK - UTILIDADES DE SELECTORES
// ============================================================

async function esperarCualquierSelector(
    page,
    selectores,
    timeout = 15000
) {

    const inicio =
    Date.now();

    while (
        Date.now() - inicio < timeout
    ) {

        for (
            const selector
            of selectores
        ) {

            try {

                const elemento =
                await page.$(
                    selector
                );

                if (elemento) {
                    return elemento;
                }

            } catch (error) {
                // Continuar probando.
            }
        }

        await esperar(500);
    }

    return null;
}

function normalizarTextoFacebook(valor) {

    return String(valor || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

async function hacerClickPorTexto(
    page,
    textos,
    timeout = 15000,
    rootSelector = null
) {

    const inicio = Date.now();

    const textosNormalizados =
    textos
    .map(normalizarTextoFacebook)
    .filter(Boolean);

    while (Date.now() - inicio < timeout) {

        const encontrado = await page.evaluate(
            ({ textos, rootSelector }) => {

                const root =
                rootSelector
                ? document.querySelector(rootSelector)
                : document;

                if (!root) {
                    return false;
                }

                const candidatos =
                Array.from(
                    root.querySelectorAll(
                        [
                            'button',
                            '[role="button"]',
                            'a',
                            '[tabindex="0"]',
                            '[data-testid]',
                            'div',
                            'span'
                        ].join(',')
                    )
                );

                const normalizar = valor =>
                String(valor || '')
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase();

                const obtenerTexto = elemento => {

                    const valores = [
                        elemento.getAttribute('aria-label'),
                                               elemento.getAttribute('title'),
                                               elemento.getAttribute('data-testid'),
                                               elemento.innerText,
                                               elemento.textContent
                    ];

                    return normalizar(
                        valores
                        .filter(Boolean)
                        .join(' ')
                    );
                };

                const esVisible = elemento => {

                    const rect =
                    elemento.getBoundingClientRect();

                    const estilo =
                    window.getComputedStyle(elemento);

                    return (
                        rect.width > 2 &&
                        rect.height > 2 &&
                        estilo.display !== 'none' &&
                        estilo.visibility !== 'hidden' &&
                        estilo.opacity !== '0'
                    );
                };

                const esCandidatoInteractivo = elemento => {

                    const tag =
                    elemento.tagName.toLowerCase();

                    return (
                        tag === 'button' ||
                        tag === 'a' ||
                        elemento.getAttribute('role') === 'button' ||
                        elemento.getAttribute('tabindex') === '0' ||
                        elemento.hasAttribute('data-testid')
                    );
                };

                // Primero buscamos controles explícitamente interactivos.
                for (const elemento of candidatos) {

                    if (!esVisible(elemento)) {
                        continue;
                    }

                    if (!esCandidatoInteractivo(elemento)) {
                        continue;
                    }

                    const texto =
                    obtenerTexto(elemento);

                    if (!texto) {
                        continue;
                    }

                    if (
                        textos.some(
                            objetivo =>
                            texto === objetivo ||
                            texto.includes(objetivo)
                        )
                    ) {

                        elemento.scrollIntoView({
                            block: 'center',
                            inline: 'center'
                        });

                        elemento.click();

                        return true;
                    }
                }

                // Facebook a veces deja el texto del compositor dentro de
                // varios <span>/<div> sin role="button". En ese caso
                // buscamos el texto y subimos hasta el primer ancestro
                // realmente clicable.
                for (const elemento of candidatos) {

                    if (!esVisible(elemento)) {
                        continue;
                    }

                    const texto =
                    obtenerTexto(elemento);

                    if (!texto) {
                        continue;
                    }

                    const coincide =
                    textos.some(
                        objetivo =>
                        texto === objetivo ||
                        texto.includes(objetivo)
                    );

                    if (!coincide) {
                        continue;
                    }

                    let actual = elemento;

                    for (let nivel = 0; nivel < 5 && actual; nivel++) {

                        if (
                            esVisible(actual) &&
                            esCandidatoInteractivo(actual)
                        ) {

                            actual.scrollIntoView({
                                block: 'center',
                                inline: 'center'
                            });

                            actual.click();

                            return true;
                        }

                        actual = actual.parentElement;
                    }
                }

                return false;
            },
            {
                textos: textosNormalizados,
                rootSelector
            }
        );

        if (encontrado) {
            return true;
        }

        await esperar(400);
    }

    return false;
}

async function compositorFacebookYaAbierto(page) {

    return page.evaluate(() => {

        const visible = elemento => {
            if (!elemento) return false;
            const estilo = window.getComputedStyle(elemento);
            const rect = elemento.getBoundingClientRect();
            return rect.width > 5 && rect.height > 5 &&
            estilo.display !== 'none' &&
            estilo.visibility !== 'hidden' &&
            estilo.opacity !== '0';
        };

        const esEditor = elemento =>
        elemento.matches?.(
            '[contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"], textarea'
        );

        const tieneMarcaDeCompositor = elemento => {
            let actual = elemento;
            for (let nivel = 0; nivel < 8 && actual; nivel++, actual = actual.parentElement) {
                const atributos = [
                    actual.getAttribute?.('data-pagelet'),
                         actual.getAttribute?.('data-testid'),
                         actual.getAttribute?.('aria-label'),
                         actual.getAttribute?.('role'),
                         actual.getAttribute?.('id'),
                         typeof actual.className === 'string' ? actual.className : ''
                ].filter(Boolean).join(' ').toLowerCase();

                if (
                    atributos.includes('composer') ||
                    atributos.includes('create-post') ||
                    atributos.includes('create_post') ||
                    atributos.includes('post-composer') ||
                    atributos.includes('publication-composer')
                ) {
                    return true;
                }
            }
            return false;
        };

        // MUY IMPORTANTE:
        // Un contenteditable cualquiera de la página puede ser el campo
        // "Escribe un comentario" de una publicación existente. Nunca lo
        // consideramos como compositor por sí solo.
        const dialogos = Array.from(
            document.querySelectorAll('div[role="dialog"], [aria-modal="true"]')
        ).filter(visible);

        // En algunas versiones actuales de Facebook el diálogo del compositor
        // se monta primero sin un contenteditable visible. En ese momento sí
        // existen sus controles de publicación/imagen. Reconocemos el diálogo
        // por esas señales para no declarar falsamente que el compositor no
        // existe.
        for (const dialogo of dialogos) {
            const textoDialogo = String(
                dialogo.innerText || dialogo.textContent || ''
            ).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/\s+/g, ' ').trim().toLowerCase();

            const editorDialogo = Array.from(
                dialogo.querySelectorAll(
                    '[contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"], textarea'
                )
            ).find(visible);

            if (editorDialogo) return true;

            const tieneInputImagen = !!dialogo.querySelector('input[type="file"]');
            const tieneMarcaCompositor = /crear publicacion|crear una publicacion|create post|¿que estas pensando|what is on your mind|what's on your mind|en que penses|share a thought|foto\/?video|photo\/?video|publicar|post/.test(textoDialogo);

            if (tieneInputImagen || tieneMarcaCompositor) return true;
        }

        const candidatos = Array.from(
            document.querySelectorAll(
                '[contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"], textarea'
            )
        );

        return candidatos.some(elemento =>
        visible(elemento) &&
        esEditor(elemento) &&
        tieneMarcaDeCompositor(elemento)
        );

    }).catch(() => false);
}
async function abrirCompositorFacebook(page, timeout = 30000) {

    // ========================================================
    // REGLA CRÍTICA:
    // Nunca hacer un segundo clic sobre el disparador si el
    // primer clic pudo haber abierto el compositor.
    //
    // En Facebook el diálogo puede tardar en montar su editor.
    // Si se vuelve a hacer clic demasiado pronto, Facebook abre
    // un segundo "Crear publicación" encima del primero.
    // ========================================================

    if (await compositorFacebookYaAbierto(page)) {
        console.log('[Facebook] El compositor ya está abierto.');
        return true;
    }

    const inicio = Date.now();

    const etiquetas = [
        'crear publicación', 'crear publicacion',
        'crear una publicación', 'crear una publicacion',
        'crear post', 'create post',
        'publicar algo', 'publica algo',
        'escribe algo', 'escribe algo...',
        'en què penses?', 'en que penses?', 'en que penses',
        'share a thought', 'share a thought...',
        '¿qué estás pensando?', 'que estas pensando?',
        'qué estás pensando', 'que estas pensando',
        'what is on your mind', "what's on your mind",
        'write something', 'post something'
    ];

    // --------------------------------------------------------
    // 1. Localizar y pulsar UNA SOLA VEZ el disparador.
    // --------------------------------------------------------

    let clicRealizado = false;

    while (Date.now() - inicio < timeout) {

        if (await compositorFacebookYaAbierto(page)) {
            console.log('[Facebook] Compositor abierto.');
            return true;
        }

        const clic = await page.evaluate((etiquetas) => {

            const normalizar = valor =>
                String(valor || '')
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase();

            const visible = el => {
                if (!el) return false;

                const r = el.getBoundingClientRect();
                const s = window.getComputedStyle(el);

                return (
                    r.width > 3 &&
                    r.height > 3 &&
                    s.display !== 'none' &&
                    s.visibility !== 'hidden' &&
                    s.opacity !== '0'
                );
            };

            const interactivo = el => {
                if (!el) return false;

                const tag = el.tagName.toLowerCase();

                return (
                    tag === 'button' ||
                    tag === 'a' ||
                    el.getAttribute('role') === 'button' ||
                    el.getAttribute('tabindex') === '0'
                );
            };

            const objetivos = etiquetas.map(normalizar);
            const candidatos = [];

            // ------------------------------------------------
            // Prioridad: disparador "En què penses?"
            // ------------------------------------------------

            for (const el of Array.from(
                document.querySelectorAll(
                    'button,[role="button"],[tabindex="0"],div,span'
                )
            )) {

                if (!visible(el)) continue;

                const texto = normalizar([
                    el.getAttribute('aria-label'),
                    el.getAttribute('title'),
                    el.innerText,
                    el.textContent
                ].filter(Boolean).join(' '));

                if (
                    texto === 'en que penses?' ||
                    texto === 'en que penses' ||
                    texto === 'share a thought' ||
                    texto === 'share a thought...'
                ) {

                    let actual = el;

                    for (
                        let nivel = 0;
                        nivel < 6 && actual;
                        nivel++, actual = actual.parentElement
                    ) {

                        if (interactivo(actual)) {
                            actual.scrollIntoView({
                                block: 'center',
                                inline: 'center'
                            });

                            actual.click();

                            return true;
                        }
                    }
                }
            }

            // ------------------------------------------------
            // Resto de disparadores.
            // ------------------------------------------------

            for (const el of Array.from(
                document.querySelectorAll(
                    'button,[role="button"],a,[tabindex="0"]'
                )
            )) {

                if (!visible(el) || !interactivo(el)) {
                    continue;
                }

                const texto = normalizar([
                    el.getAttribute('aria-label'),
                    el.getAttribute('title'),
                    el.getAttribute('data-testid'),
                    el.innerText,
                    el.textContent
                ].filter(Boolean).join(' '));

                if (!texto) continue;

                let score = 0;

                for (const objetivo of objetivos) {

                    if (texto === objetivo) {
                        score += 120;
                    } else if (texto.includes(objetivo)) {
                        score += 70;
                    }
                }

                let anc = el;
                let datos = '';

                for (
                    let nivel = 0;
                    nivel < 6 && anc;
                    nivel++, anc = anc.parentElement
                ) {

                    datos += ' ' + [
                        anc.getAttribute?.('data-pagelet'),
                        anc.getAttribute?.('data-testid'),
                        anc.getAttribute?.('aria-label'),
                        anc.getAttribute?.('id'),
                        typeof anc.className === 'string'
                            ? anc.className
                            : ''
                    ]
                    .filter(Boolean)
                    .join(' ');
                }

                datos = normalizar(datos);

                if (datos.includes('composer')) {
                    score += 60;
                }

                if (
                    datos.includes('create-post') ||
                    datos.includes('create_post')
                ) {
                    score += 50;
                }

                if (
                    texto.includes('comentar') ||
                    texto.includes('comment')
                ) {
                    score -= 100;
                }

                if (
                    texto.includes('compartir') ||
                    texto.includes('share')
                ) {
                    score -= 30;
                }

                if (score > 0) {
                    candidatos.push({
                        el,
                        score
                    });
                }
            }

            candidatos.sort(
                (a, b) => b.score - a.score
            );

            if (!candidatos[0]) {
                return false;
            }

            candidatos[0].el.scrollIntoView({
                block: 'center',
                inline: 'center'
            });

            candidatos[0].el.click();

            return true;

        }, etiquetas).catch(() => false);

        if (clic) {
            clicRealizado = true;

            console.log(
                '[Facebook] Disparador del compositor pulsado UNA SOLA VEZ.'
            );

            break;
        }

        await esperar(500);
    }

    if (!clicRealizado) {
        return false;
    }

    // --------------------------------------------------------
    // 2. Después del clic NO volvemos a hacer clic.
    //
    // Esperamos a que Facebook termine de montar el diálogo.
    // --------------------------------------------------------

    const limiteConfirmacion =
        Date.now() + Math.min(
            15000,
            Math.max(5000, timeout)
        );

    while (Date.now() < limiteConfirmacion) {

        if (await compositorFacebookYaAbierto(page)) {
            console.log(
                '[Facebook] Compositor abierto correctamente.'
            );

            return true;
        }

        const estadoDialogo = await page.evaluate(() => {

            const visible = el => {

                if (!el) return false;

                const r = el.getBoundingClientRect();
                const s = window.getComputedStyle(el);

                return (
                    r.width > 20 &&
                    r.height > 20 &&
                    s.display !== 'none' &&
                    s.visibility !== 'hidden' &&
                    s.opacity !== '0'
                );
            };

            const dialogos = Array.from(
                document.querySelectorAll(
                    'div[role="dialog"], [aria-modal="true"]'
                )
            )
            .filter(visible);

            if (!dialogos.length) {
                return {
                    encontrado: false,
                    editor: false,
                    archivo: false
                };
            }

            const activo = dialogos[dialogos.length - 1];

            const editor = !!activo.querySelector(
                '[contenteditable="true"],' +
                '[contenteditable="plaintext-only"],' +
                '[role="textbox"], textarea'
            );

            const archivo = !!activo.querySelector(
                'input[type="file"]'
            );

            const texto = String(
                activo.innerText ||
                activo.textContent ||
                ''
            )
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();

            const esCreacion =
                archivo ||
                /crear publicacion|crear una publicacion|create post|what is on your mind|what's on your mind|en que penses|share a thought|publicar|foto\/?video|photo\/?video/.test(
                    texto
                );

            return {
                encontrado: true,
                editor,
                archivo,
                esCreacion
            };

        }).catch(() => ({
            encontrado: false,
            editor: false,
            archivo: false,
            esCreacion: false
        }));

        if (
            estadoDialogo.encontrado &&
            (
                estadoDialogo.editor ||
                estadoDialogo.archivo ||
                estadoDialogo.esCreacion
            )
        ) {

            console.log(
                '[Facebook] Diálogo de creación detectado; no se realizará ningún segundo clic.'
            );

            // Damos tiempo adicional para que aparezca el editor.
            await esperar(1000);

            return true;
        }

        await esperar(500);
    }

    console.warn(
        '[Facebook] El disparador fue pulsado, pero Facebook no confirmó el compositor dentro del tiempo esperado.'
    );

    // MUY IMPORTANTE:
    // No hacemos fallback sobre el mismo botón.
    // Reintentar el click aquí era la causa de los compositores
    // superpuestos observados en v48.
    return false;
}

async function obtenerDialogoFacebook(
    page,
    timeout = 10000
) {
    return esperarCualquierSelector(
        page,
        [
            'div[role="dialog"]',
            '[aria-modal="true"]'
        ],
        timeout
    );
}

async function obtenerInputImagenFacebook(
    page,
    timeout = 10000
) {
    return esperarCualquierSelector(
        page,
        [
            'div[role="dialog"] input[type="file"]',
            '[aria-modal="true"] input[type="file"]',
            'input[type="file"]'
        ],
        timeout
    );
}

async function obtenerEditorFacebook(
    page,
    timeout = 20000
) {
    const inicio = Date.now();

    while (Date.now() - inicio < timeout) {

        try {
            const handle = await page.evaluateHandle(() => {

                const visible = elemento => {
                    if (!elemento) return false;
                    const estilo = window.getComputedStyle(elemento);
                    if (
                        estilo.display === 'none' ||
                        estilo.visibility === 'hidden' ||
                        estilo.opacity === '0'
                    ) return false;

                    const rect = elemento.getBoundingClientRect();
                    return rect.width > 5 && rect.height > 5;
                };

                const normalizar = valor => String(valor || '')
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase();

                const esEditor = elemento => elemento.matches?.(
                    '[contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"], textarea'
                );

                const dialogos = Array.from(document.querySelectorAll('div[role="dialog"], [aria-modal="true"]'));
                const dialogo = dialogos.find(visible) || dialogos[0] || null;

                const candidatos = [];

                const agregar = (elemento, score, motivo) => {
                    if (!elemento || !esEditor(elemento) || !visible(elemento)) return;
                    if (candidatos.some(item => item.elemento === elemento)) return;
                    candidatos.push({ elemento, score, motivo });
                };

                const marcarAncestros = elemento => {
                    let actual = elemento;
                    let score = 0;
                    const marcas = [];

                    for (let nivel = 0; nivel < 8 && actual; nivel++, actual = actual.parentElement) {
                        const atributos = [
                            actual.getAttribute?.('data-pagelet'),
                                                     actual.getAttribute?.('data-testid'),
                                                     actual.getAttribute?.('aria-label'),
                                                     actual.getAttribute?.('role'),
                                                     actual.getAttribute?.('id'),
                                                     typeof actual.className === 'string' ? actual.className : ''
                        ].filter(Boolean).join(' ').toLowerCase();

                        if (atributos.includes('composer')) {
                            score += 100;
                            marcas.push('composer');
                        }
                        if (atributos.includes('create-post') || atributos.includes('create_post')) {
                            score += 100;
                            marcas.push('create-post');
                        }
                        if (atributos.includes('post-composer') || atributos.includes('publication-composer')) {
                            score += 100;
                            marcas.push('post-composer');
                        }
                    }

                    return { score, marcas };
                };

                // 1. Un diálogo de creación de publicación tiene prioridad absoluta.
                if (dialogo) {
                    for (const editor of dialogo.querySelectorAll(
                        '[contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"], textarea'
                    )) {
                        if (!visible(editor)) continue;

                        const texto = normalizar([
                            editor.getAttribute('aria-label'),
                                                 editor.getAttribute('placeholder'),
                                                 editor.getAttribute('data-placeholder')
                        ].filter(Boolean).join(' '));

                        let score = 1000;
                        if (
                            texto.includes('que estas pensando') ||
                            texto.includes('en que estas pensando') ||
                            texto.includes('escribe algo') ||
                            texto.includes('write something') ||
                            texto.includes('what is on your mind') ||
                            texto.includes("what's on your mind") ||
                            texto.includes('en que penses') ||
                            texto.includes('share a thought')
                        ) score += 200;

                        agregar(editor, score, 'dialog');
                    }
                }

                // 2. Variante inline: SOLO aceptamos editores cuyo ancestro
                //    tenga una marca inequívoca de composer. Esto evita que
                //    el campo de comentarios de la publicación más reciente
                //    sea confundido con el editor de una nueva publicación.
                for (const editor of document.querySelectorAll(
                    '[contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"], textarea'
                )) {
                    if (!visible(editor)) continue;

                    const marca = marcarAncestros(editor);
                    if (marca.score <= 0) continue;

                    const texto = normalizar([
                        editor.getAttribute('aria-label'),
                                             editor.getAttribute('placeholder'),
                                             editor.getAttribute('data-placeholder')
                    ].filter(Boolean).join(' '));

                    let score = marca.score;
                    if (
                        texto.includes('que estas pensando') ||
                        texto.includes('en que estas pensando') ||
                        texto.includes('escribe algo') ||
                        texto.includes('write something') ||
                        texto.includes('what is on your mind') ||
                        texto.includes("what's on your mind") ||
                        texto.includes('en que penses') ||
                        texto.includes('share a thought')
                    ) score += 200;

                    agregar(editor, score, marca.marcas.join(','));
                }

                // 3. Nunca devolvemos un editor genérico de la página.
                candidatos.sort((a, b) => b.score - a.score);
                const mejor = candidatos[0];

                if (!mejor) return null;

                mejor.elemento.scrollIntoView({
                    block: 'center',
                    inline: 'center'
                });

                return mejor.elemento;
            });

            const elemento = handle && handle.asElement ? handle.asElement() : null;

            if (elemento) {
                console.log('[Facebook] Editor de nueva publicación localizado.');
                return elemento;
            }
        } catch (error) {
            // Facebook cambia el DOM frecuentemente; continuamos esperando.
        }

        await esperar(500);
    }

    return null;
}
async function iniciarFacebook() {

    if (!FACEBOOK_ENABLED) {
        console.log('[Facebook] Integración desactivada.');
        return null;
    }

    if (!FACEBOOK_ORIGEN_URL) {
        throw new Error('FACEBOOK_ORIGEN_URL no está configurado.');
    }


    console.log('');
    console.log('='.repeat(70));
    console.log('INICIANDO FACEBOOK');
    console.log('='.repeat(70));
    console.log(`Perfil Chromium compartido: ${CARPETA_PERFIL_COMUN}`);
    console.log(`Modo headless: ${FACEBOOK_HEADLESS}`);
    console.log(`Origen: ${FACEBOOK_ORIGEN_URL}`);
    console.log(`Grupos destino: sincronizados desde Facebook y gestionados por Laravel/Filament`);

    if (!navegadorPrincipal) {
        throw new Error(
            '[Facebook] El navegador principal todavía no está iniciado.'
        );
    }

    facebookBrowser = navegadorPrincipal;

    const paginas = await facebookBrowser.pages();

    facebookPage =
    paginas.find(
        pagina =>
        pagina !== whatsappPage &&
        !/^https:\/\/web\.whatsapp\.com/i.test(pagina.url())
    ) ||
    await facebookBrowser.newPage();

    console.log(
        '[Facebook] Usando el mismo navegador de WhatsApp; se reutilizará una segunda pestaña.'
    );

    facebookPage.setDefaultTimeout(FACEBOOK_TIMEOUT_MS);
    configurarDialogosFacebook(facebookPage);

    if (datosMigracionFacebookPendientes) {
        const aplicada = await aplicarSesionFacebookMigrada(
            facebookPage,
            datosMigracionFacebookPendientes
        );

        if (aplicada) {
            marcarMigracionFacebookCompletada();
            datosMigracionFacebookPendientes = null;
        }
    }

    await facebookPage.goto(
        FACEBOOK_ORIGEN_URL,
        {
            waitUntil: 'domcontentloaded',
            timeout: FACEBOOK_TIMEOUT_MS
        }
    );

    await esperar(3000);

    let urlActual = facebookPage.url();

    console.log(`[Facebook] Página origen: ${await facebookPage.title().catch(() => '')}`);
    console.log(`[Facebook] URL origen: ${urlActual}`);

    if (/login/i.test(urlActual)) {
        console.warn('');
        console.warn('==========================================================');
        console.warn('[Facebook] SESIÓN NO INICIADA');
        console.warn('Inicia sesión manualmente en Facebook.');
        console.warn('==========================================================');

        if (FACEBOOK_HEADLESS) {
            throw new Error(
                'Facebook necesita una sesión iniciada. Ejecuta una vez con FACEBOOK_HEADLESS=false.'
            );
        }

        await esperar(60000);

        await facebookPage.goto(
            FACEBOOK_ORIGEN_URL,
            {
                waitUntil: 'domcontentloaded',
                timeout: FACEBOOK_TIMEOUT_MS
            }
        );

        await esperar(5000);

        urlActual = facebookPage.url();

        if (/login/i.test(urlActual)) {
            throw new Error('Facebook sigue solicitando inicio de sesión.');
        }
    }

    await asegurarModoPaginaFacebook(facebookPage, FACEBOOK_TIMEOUT_MS);

    console.log('[Facebook] Sesión disponible y actuando como la Página.');
    facebookDisponible = true;

    if (!facebookSyncPage || facebookSyncPage.isClosed()) {
        facebookSyncPage = await facebookBrowser.newPage();
        facebookSyncPage.setDefaultTimeout(FACEBOOK_TIMEOUT_MS);
        configurarDialogosFacebook(facebookSyncPage);
        console.log('[Facebook] Pestaña secundaria para sincronización de grupos creada.');
    }

    return facebookPage;
}

// ============================================================
// FACEBOOK - NORMALIZAR URL
// ============================================================

function normalizarUrlFacebook(url) {

    if (typeof url !== 'string' || !url.trim()) {
        return '';
    }

    try {
        const parsed = new URL(url);

        // Facebook puede añadir parámetros de navegación/tracking.
        // Para decidir si debemos navegar, solo nos interesa el origen
        // y la ruta principal.
        return `${parsed.origin}${parsed.pathname}`
        .replace(/\/+$/, '')
        .toLowerCase();
    } catch (_) {
        return url
        .trim()
        .replace(/[?#].*$/, '')
        .replace(/\/+$/, '')
        .toLowerCase();
    }
}



function normalizarUrlPublicacionFacebook(url) {
    if (typeof url !== 'string' || !url.trim()) return '';

    try {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
    } catch (_) {
        return String(url)
        .trim()
        .replace(/[?#].*$/, '')
        .replace(/\/+$/, '');
    }
}

function configurarDialogosFacebook(page) {
    if (!page || page.__facebookDialogHandlerInstalado) return;

    page.__facebookDialogHandlerInstalado = true;

    page.on('dialog', async dialog => {
        try {
            const tipo = dialog.type();
            const mensaje = String(dialog.message() || '').replace(/\s+/g, ' ').trim();

            if (tipo === 'beforeunload') {
                console.log('[Facebook] Diálogo beforeunload detectado; aceptando para continuar la navegación.');
                await dialog.accept();
                return;
            }

            console.log(`[Facebook] Diálogo del navegador detectado (${tipo}): ${mensaje}`);
            await dialog.dismiss();
        } catch (_) {
            // Facebook/Chromium puede cerrar el diálogo mientras lo atendemos.
        }
    });
}

async function cerrarAvisoAbandonarPaginaFacebook(page, timeout = 5000) {
    const inicio = Date.now();

    while (Date.now() - inicio < timeout) {
        try {
            const resultado = await page.evaluate(() => {
                const normalizar = valor => String(valor || '')
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase();

                const visible = el => {
                    if (!el) return false;
                    const r = el.getBoundingClientRect();
                    const s = getComputedStyle(el);
                    return r.width > 2 && r.height > 2 &&
                    s.display !== 'none' &&
                    s.visibility !== 'hidden' &&
                    s.opacity !== '0';
                };

                const dialogs = Array.from(document.querySelectorAll(
                    '[role="dialog"], [aria-modal="true"]'
                )).filter(visible);

                const dialogo = dialogs.find(el => {
                    const texto = normalizar(el.innerText || el.textContent || '');
                    return (
                        texto.includes('leave page') ||
                        texto.includes('leave site') ||
                        texto.includes('abandonar pagina') ||
                        texto.includes('abandonar la pagina') ||
                        texto.includes('salir de la pagina') ||
                        texto.includes('salir de la página') ||
                        texto.includes('discard changes') ||
                        texto.includes('descartar cambios')
                    );
                });

                if (!dialogo) return { encontrado: false, cerrado: false };

                const controles = Array.from(dialogo.querySelectorAll(
                    'button,[role="button"],[tabindex="0"]'
                )).filter(visible);

                const aceptar = controles.find(el => {
                    const texto = normalizar([
                        el.getAttribute('aria-label'),
                                             el.getAttribute('title'),
                                             el.innerText,
                                             el.textContent
                    ].filter(Boolean).join(' '));

                    return (
                        texto === 'leave' ||
                        texto.includes('leave page') ||
                        texto.includes('abandonar') ||
                        texto.includes('salir') ||
                        texto.includes('discard') ||
                        texto.includes('descartar')
                    );
                });

                if (!aceptar) return { encontrado: true, cerrado: false };

                aceptar.scrollIntoView({ block: 'center', inline: 'center' });
                aceptar.click();
                return { encontrado: true, cerrado: true };
            }).catch(() => ({ encontrado: false, cerrado: false }));

            if (!resultado.encontrado) return true;

            if (resultado.cerrado) {
                console.log('[Facebook] Aviso de abandono detectado y aceptado.');
                await esperar(800);
                return true;
            }
        } catch (_) {}

        await esperar(300);
    }

    return true;
}

async function prepararNavegacionFacebook(page) {
    if (!page || page.isClosed()) return;

    await cerrarAvisoAbandonarPaginaFacebook(page, 2500);
    await page.keyboard.press('Escape').catch(() => {});
    await esperar(400);
    await cerrarAvisoAbandonarPaginaFacebook(page, 2500);
}
// ============================================================
// FACEBOOK - PUBLICAR IMAGEN + TEXTO
// ============================================================


// V72: Se eliminaron por completo las funciones de Scheduling options.
// El bot nunca debe abrir, cerrar ni manipular ese flujo.

async function obtenerDialogoVisibleFacebook(page) {
    return page.evaluateHandle(() => {
        const visible = el => {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 20 && r.height > 20 &&
            s.display !== 'none' &&
            s.visibility !== 'hidden' &&
            s.opacity !== '0';
        };

        const dialogos = Array.from(document.querySelectorAll(
            'div[role="dialog"], [aria-modal="true"]'
        )).filter(visible);

        return dialogos.length ? dialogos[dialogos.length - 1] : null;
    }).catch(() => null);
}

async function seleccionarGrupoFacebookEnDialogo(page, nombreGrupo, timeout = 30000, urlGrupo = '', facebookIdGrupo = '') {
    const inicio = Date.now();

    const nombreLimpio = limpiarNombreGrupoFacebook(nombreGrupo);
    const objetivo = normalizarTextoFacebook(nombreLimpio);
    const idGrupo = String(
        facebookIdGrupo || extraerIdGrupoFacebook(urlGrupo) || ''
    ).trim();

    if (!objetivo && !idGrupo) return false;

    console.log(`[Facebook] Buscando grupo en "Share to groups": ${nombreLimpio || nombreGrupo}`);
    console.log(`[Facebook] Nombre normalizado: ${objetivo}`);
    if (idGrupo) console.log(`[Facebook] ID/slug configurado: ${idGrupo}`);

    // ------------------------------------------------------------
    // V66: mantener el diálogo abierto y pulsar el INPUT/checkbox real
    // grupo. El diálogo "Share to groups" debe permanecer abierto
    // durante toda la selección múltiple.
    // ------------------------------------------------------------

    const obtenerLista = async () => page.evaluate(() => {
        const normalizar = v => String(v || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[\u200B-\u200D\uFEFF]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();

        const visible = el => {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 250 &&
                r.height > 120 &&
                r.bottom > 0 &&
                r.right > 0 &&
                s.display !== 'none' &&
                s.visibility !== 'hidden' &&
                s.opacity !== '0';
        };

        const dialogos = Array.from(document.querySelectorAll(
            'div[role="dialog"], [aria-modal="true"]'
        )).filter(visible).filter(el =>
            /share to groups|select groups|compartir en grupos|seleccionar grupos/i
                .test(normalizar(el.innerText || el.textContent || ''))
        );

        if (!dialogos.length) {
            return { ok: false, motivo: 'sin-dialogo-grupos' };
        }

        const candidatos = [];

        for (const dialogo of dialogos) {
            const elementos = [dialogo, ...Array.from(dialogo.querySelectorAll('*'))]
                .filter(visible)
                .filter(el => el.scrollHeight > el.clientHeight + 30)
                .map(el => {
                    const r = el.getBoundingClientRect();
                    return {
                        el,
                        delta: el.scrollHeight - el.clientHeight,
                        area: r.width * r.height,
                        top: r.top,
                        left: r.left,
                        width: r.width,
                        height: r.height
                    };
                });

            candidatos.push(...elementos);
        }

        candidatos.sort((a, b) =>
            b.delta - a.delta ||
            b.area - a.area
        );

        const lista = candidatos.find(x =>
            x.width >= 300 &&
            x.height >= 180
        )?.el;

        if (!lista) {
            return { ok: false, motivo: 'sin-lista-virtualizada' };
        }

        return {
            ok: true,
            scrollTop: Math.round(lista.scrollTop),
            maxScrollTop: Math.max(0, Math.round(
                lista.scrollHeight - lista.clientHeight
            )),
            clientHeight: Math.round(lista.clientHeight)
        };
    }).catch(error => ({
        ok: false,
        motivo: error.message
    }));

    const localizarFila = async (hacerScroll = true) => page.evaluate(
        ({ objetivo, idGrupo, hacerScroll }) => {
            const normalizar = v => String(v || '')
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/[\u200B-\u200D\uFEFF]/g, '')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase();

            const limpiar = v => normalizar(v)
                .replace(/\s+(?:you\s+last\s+visited|last\s+active|mostra\s+el\s+grup|see\s+group|show\s+group|ver\s+(?:el\s+)?grupo|mostrar\s+(?:el\s+)?grupo)\b.*$/i, '')
                .trim();

            const visible = el => {
                if (!el || !el.isConnected) return false;
                const r = el.getBoundingClientRect();
                const st = getComputedStyle(el);
                return r.width > 2 && r.height > 2 &&
                    r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth &&
                    st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
            };

            const dialogs = Array.from(document.querySelectorAll('div[role="dialog"], [aria-modal="true"]'))
                .filter(visible)
                .filter(el => /share to groups|select groups|compartir en grupos|seleccionar grupos/i.test(
                    normalizar(el.innerText || el.textContent || '')
                ));

            if (!dialogs.length) return { encontrado:false, motivo:'sin-dialogo-grupos' };

            const root = dialogs.sort((a,b) => {
                const am = Math.max(0, a.scrollHeight-a.clientHeight);
                const bm = Math.max(0, b.scrollHeight-b.clientHeight);
                return bm-am;
            })[0];

            const scrollables = [root, ...Array.from(root.querySelectorAll('*'))]
                .filter(visible)
                .filter(el => el.scrollHeight > el.clientHeight + 30)
                .sort((a,b) => {
                    const ad=a.scrollHeight-a.clientHeight, bd=b.scrollHeight-b.clientHeight;
                    const aa=a.getBoundingClientRect(), ba=b.getBoundingClientRect();
                    return bd-ad || (ba.width*ba.height)-(aa.width*aa.height);
                });
            const lista = scrollables[0] || root;
            const ids = String(idGrupo || '').trim().toLowerCase();

            const estadoSeleccionado = el => !!el && (
                el.getAttribute('aria-checked') === 'true' ||
                el.getAttribute('aria-selected') === 'true' ||
                el.getAttribute('data-state') === 'checked' ||
                el.getAttribute('data-checked') === 'true' ||
                el.checked === true ||
                /\b(selected|checked|active|chosen)\b/i.test(String(el.className || ''))
            );

            const encontrarTexto = () => {
                let textoEl = null;
                if (ids) {
                    const posibles = Array.from(lista.querySelectorAll(
                        'a[href], [data-id], [data-group-id], [data-groupid], [data-testid], [aria-label]'
                    )).filter(visible);
                    for (const el of posibles) {
                        const vals = [el.getAttribute('href'), el.getAttribute('data-id'),
                            el.getAttribute('data-group-id'), el.getAttribute('data-groupid'),
                            el.getAttribute('data-testid'), el.getAttribute('aria-label')]
                            .filter(Boolean).map(normalizar);
                        if (vals.some(v => v === ids || v.includes(ids))) { textoEl = el; break; }
                    }
                }
                if (!textoEl) {
                    textoEl = Array.from(lista.querySelectorAll('span,div,a,[role="link"],label,p'))
                        .filter(visible)
                        .map(el => ({el, texto: limpiar(el.innerText || el.textContent || '')}))
                        .filter(x => x.texto === objetivo || (objetivo && x.texto.includes(objetivo) && x.texto.length <= objetivo.length + 100))
                        .sort((a,b) => {
                            const ar=a.el.getBoundingClientRect(), br=b.el.getBoundingClientRect();
                            return (a.texto === objetivo ? 0:1)-(b.texto === objetivo ? 0:1) ||
                                (ar.width*ar.height)-(br.width*br.height);
                        })[0]?.el || null;
                }
                return textoEl;
            };

            let textoEl = encontrarTexto();
            if (!textoEl) return {
                encontrado:false,
                motivo:'fila-no-visible',
                scrollTop:Math.round(lista.scrollTop),
                maxScrollTop:Math.max(0, Math.round(lista.scrollHeight-lista.clientHeight))
            };

            let fila = textoEl;
            for (let actual=textoEl; actual && actual!==root; actual=actual.parentElement) {
                if (!visible(actual)) continue;
                const r=actual.getBoundingClientRect();
                const txt=limpiar(actual.innerText || actual.textContent || '');
                const controles=Array.from(actual.querySelectorAll('input,[role="checkbox"],[role="radio"],[aria-checked],[aria-selected],button')).filter(visible);
                if (r.width>=260 && r.height>=32 && r.height<=220 &&
                    (txt===objetivo || txt.includes(objetivo)) && controles.length) {
                    fila=actual; break;
                }
            }

            // Facebook utiliza una lista virtualizada. Primero centramos la
            // fila como en las versiones estables anteriores. MUY IMPORTANTE:
            // después del scroll NO reutilizamos ni la fila, ni el control, ni
            // sus coordenadas, porque Facebook puede reciclar el DOM.
            if (hacerScroll) {
                fila.scrollIntoView({ block: 'center', inline: 'center' });

                return {
                    encontrado: false,
                    necesitaRefresco: true,
                    motivo: 'scroll-realizado',
                    scrollTop: Math.round(lista.scrollTop),
                    maxScrollTop: Math.max(0, Math.round(lista.scrollHeight - lista.clientHeight))
                };
            }

            // La fila ya está en viewport después del scroll. En esta segunda
            // lectura NO volvemos a desplazarla ni reciclamos el DOM. Ahora sí
            // extraemos el control físico y su estado actual.
            const filaRect = fila.getBoundingClientRect();
            const controles = Array.from(fila.querySelectorAll(
                'input,[role="checkbox"],[role="radio"],[aria-checked],[aria-selected],button'
            )).filter(visible);

            const control = controles.find(estadoSeleccionado) ||
                controles.find(el => {
                    const r = el.getBoundingClientRect();
                    return r.width >= 8 && r.height >= 8;
                }) || null;

            const yaMarcado = estadoSeleccionado(control) || estadoSeleccionado(fila);
            const cr = control ? control.getBoundingClientRect() : null;

            return {
                encontrado: true,
                yaMarcado,
                control: !!control,
                controlTag: control ? control.tagName : '',
                controlType: control ? (control.getAttribute('type') || '') : '',
                clickTarget: control ? 'control' : 'fila',
                clickX: control ? cr.left + cr.width / 2 : filaRect.left + filaRect.width / 2,
                clickY: control ? cr.top + cr.height / 2 : filaRect.top + filaRect.height / 2,
                x: filaRect.left + filaRect.width / 2,
                y: filaRect.top + filaRect.height / 2,
                filaRect: {
                    left: Math.round(filaRect.left),
                    top: Math.round(filaRect.top),
                    width: Math.round(filaRect.width),
                    height: Math.round(filaRect.height)
                },
                controlRect: cr ? {
                    left: Math.round(cr.left),
                    top: Math.round(cr.top),
                    width: Math.round(cr.width),
                    height: Math.round(cr.height)
                } : null,
                scrollTop: Math.round(lista.scrollTop),
                maxScrollTop: Math.max(0, Math.round(lista.scrollHeight - lista.clientHeight))
            };

            /* unreachable */
        },
        { objetivo, idGrupo, hacerScroll }
    ).catch(error => ({encontrado:false, motivo:error.message}));

    const desplazarLista = async direccion => page.evaluate(
        ({ direccion }) => {
            const normalizar = v => String(v || '')
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/[\u200B-\u200D\uFEFF]/g, '')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase();

            const visible = el => {
                if (!el) return false;
                const r = el.getBoundingClientRect();
                const s = getComputedStyle(el);
                return r.width > 250 &&
                    r.height > 120 &&
                    r.bottom > 0 &&
                    r.right > 0 &&
                    s.display !== 'none' &&
                    s.visibility !== 'hidden' &&
                    s.opacity !== '0';
            };

            const dialogos = Array.from(document.querySelectorAll(
                'div[role="dialog"], [aria-modal="true"]'
            ))
            .filter(visible)
            .filter(el =>
                /share to groups|select groups|compartir en grupos|seleccionar grupos/i
                    .test(normalizar(el.innerText || el.textContent || ''))
            );

            const candidatos = [];

            for (const dialogo of dialogos) {
                [dialogo, ...Array.from(dialogo.querySelectorAll('*'))]
                    .filter(visible)
                    .filter(el => el.scrollHeight > el.clientHeight + 30)
                    .forEach(el => {
                        const r = el.getBoundingClientRect();
                        candidatos.push({
                            el,
                            delta: el.scrollHeight - el.clientHeight,
                            area: r.width * r.height
                        });
                    });
            }

            candidatos.sort((a, b) =>
                b.delta - a.delta || b.area - a.area
            );

            const lista = candidatos.find(x =>
                x.area >= 50000
            )?.el || candidatos[0]?.el;

            if (!lista) return {
                ok: false,
                motivo: 'sin-lista'
            };

            const max = Math.max(
                0,
                lista.scrollHeight - lista.clientHeight
            );

            const antes = lista.scrollTop;
            const paso = Math.max(
                320,
                Math.floor(lista.clientHeight * 0.78)
            );

            let nuevo = direccion === 'down'
                ? Math.min(max, antes + paso)
                : Math.max(0, antes - paso);

            lista.scrollTop = nuevo;
            lista.dispatchEvent(
                new Event('scroll', { bubbles: true })
            );

            return {
                ok: true,
                antes: Math.round(antes),
                ahora: Math.round(lista.scrollTop),
                max: Math.round(max),
                cambio: Math.abs(lista.scrollTop - antes) > 2
            };
        },
        { direccion }
    ).catch(error => ({
        ok: false,
        motivo: error.message
    }));

    // Primero buscamos en la posición actual. Después avanzamos hacia abajo.
    // Solo si llegamos al final hacemos UNA vuelta al principio.
    let vueltas = 0;
    let pasos = 0;
    let ultimoScroll = -1;
    let sinCambio = 0;

    while (Date.now() - inicio < timeout) {
        const estadoLista = await obtenerLista();
        if (!estadoLista.ok) {
            console.warn(
                `[Facebook] Selector de grupos no disponible: ${estadoLista.motivo}`
            );
            return false;
        }

        let fila = await localizarFila(true);

        // Tras scrollIntoView, Facebook puede haber reciclado la fila. Hacemos
        // una nueva lectura COMPLETA del DOM antes de obtener el checkbox y
        // sus coordenadas. No es un segundo click; es solo una relectura.
        if (fila.necesitaRefresco) {
            await esperar(150);
            fila = await localizarFila(false);
        }

        if (fila.encontrado) {
            console.log(
                `[Facebook] Grupo localizado: "${nombreLimpio}" | ` +
                `control=${fila.control ? 'sí' : 'no'} | ` +
                `yaMarcado=${fila.yaMarcado ? 'sí' : 'no'}`
            );

            if (fila.filaRect) {
                console.log(
                    `[Facebook] Fila: x=${fila.filaRect.left} ` +
                    `y=${fila.filaRect.top} ` +
                    `w=${fila.filaRect.width} ` +
                    `h=${fila.filaRect.height}`
                );
            }

            if (fila.yaMarcado) {
                console.log(
                    `[Facebook] ✓ Grupo ya estaba seleccionado: ${nombreLimpio}`
                );
                return true;
            }

            // V82: Facebook selecciona el grupo haciendo click sobre la FILA completa, usando una zona izquierda segura de la fila.
            // No buscamos ni pulsamos el checkbox/input. La fila se vuelve a leer
            // después de scrollIntoView para evitar referencias a nodos reciclados.
            let clickX;
            let clickY;

            if (fila.filaRect && fila.filaRect.width > 0 && fila.filaRect.height > 0) {
                // V82: la interfaz mostrada por el usuario confirma que la
                // selección se realiza sobre la FILA del grupo, no sobre el
                // checkbox. Evitamos el centro del texto (SPAN) y el extremo
                // derecho del checkbox. El punto queda dentro de la zona
                // izquierda/interactiva de la propia fila.
                clickX = fila.filaRect.left + Math.min(90, Math.max(24, fila.filaRect.width * 0.18));
                clickY = fila.filaRect.top + (fila.filaRect.height / 2);
            } else {
                clickX = Number.isFinite(fila.x) ? fila.x : 0;
                clickY = Number.isFinite(fila.y) ? fila.y : 0;
            }

            // Comprobamos qué elemento recibe el puntero en el centro de la fila.
            // Esto es SOLO diagnóstico; el click físico siempre se realiza una vez
            // sobre las coordenadas calculadas de la fila.
            const puntoReal = await page.evaluate(({x, y}) => {
                const el = document.elementFromPoint(x, y);
                if (!el) return { ok: false };

                const norm = v => String(v || '').replace(/\s+/g, ' ').trim();
                const candidatos = [];
                let actual = el;

                for (let i = 0; actual && i < 8; i++, actual = actual.parentElement) {
                    const r = actual.getBoundingClientRect();
                    const st = getComputedStyle(actual);
                    candidatos.push({
                        tag: actual.tagName,
                        role: actual.getAttribute('role') || '',
                        type: actual.getAttribute('type') || '',
                        ariaChecked: actual.getAttribute('aria-checked') || '',
                        ariaLabel: norm(actual.getAttribute('aria-label')),
                        cursor: st.cursor,
                        pointerEvents: st.pointerEvents,
                        rect: {
                            left: Math.round(r.left),
                            top: Math.round(r.top),
                            width: Math.round(r.width),
                            height: Math.round(r.height)
                        }
                    });
                }

                return {
                    ok: true,
                    hit: candidatos[0],
                    candidatos
                };
            }, { x: clickX, y: clickY }).catch(() => ({ ok: false }));

            if (puntoReal?.ok) {
                console.log(
                    `[Facebook] Elemento bajo el punto de selección de la fila: ${puntoReal.hit?.tag || '?'} ` +
                    `role=${puntoReal.hit?.role || '-'} type=${puntoReal.hit?.type || '-'} ` +
                    `cursor=${puntoReal.hit?.cursor || '-'} ` +
                    `pointer-events=${puntoReal.hit?.pointerEvents || '-'}`
                );
            }

            console.log(
                `[Facebook] Click físico ÚNICO sobre la ZONA IZQUIERDA DE LA FILA del grupo: ` +
                `x=${Math.round(clickX)} y=${Math.round(clickY)}`
            );

            // ============================================================
            // V88 - CONFIRMACIÓN SEMÁNTICA REAL DE SELECCIÓN
            // ============================================================
            // El diagnóstico V86 demostró que Facebook NO actualiza
            // input.checked. La selección real se refleja en:
            //     INPUT[aria-checked="true"]
            //
            // El click sigue siendo ÚNICO y se hace sobre la FILA.
            // Después del click volvemos a localizar la fila porque la lista
            // virtualizada puede reciclar los nodos del DOM.
            await page.mouse.click(clickX, clickY, { clickCount: 1 });
            console.log('[Facebook][V88] Click físico ÚNICO sobre la fila realizado.');

            // Esperamos la actualización React/Facebook y re-leemos el nodo
            // actualmente conectado al DOM. No reutilizamos referencias previas.
            // ============================================================
            // V89 - CONFIRMACIÓN POR CONTROL SEMÁNTICO + TEXTO ASOCIADO
            // ============================================================
            // V86 demostró que Facebook refleja la selección en
            // INPUT[aria-checked="true"], mientras input.checked puede seguir
            // siendo false. Además, la lista es virtualizada y React puede
            // reciclar el nodo de la fila inmediatamente después del click.
            //
            // V88 fallaba porque intentaba subir desde el texto y después
            // buscar el INPUT exclusivamente dentro de esa fila. En algunos
            // renders Facebook deja temporalmente el INPUT fuera de ese
            // ancestro aunque el estado semántico ya cambió.
            //
            // V89 invierte la estrategia:
            //   1. busca INPUT visibles con aria-checked="true";
            //   2. intenta asociarlos al nombre del grupo por sus ancestros;
            //   3. si el texto está en un hermano/contenedor cercano, usa la
            //      estructura de la lista y la proximidad geométrica;
            //   4. NO hace ningún segundo click.
            const confirmarSeleccionSemantica = async () => {
                const inicioConfirmacion = Date.now();

                while (Date.now() - inicioConfirmacion < 6000) {
                    let estado;

                    try {
                        estado = await page.evaluate(
                            ({ objetivo, idGrupo }) => {
                                const normalizar = v => String(v || '')
                                    .normalize('NFD')
                                    .replace(/[\u0300-\u036f]/g, '')
                                    .replace(/[\u200B-\u200D\uFEFF]/g, '')
                                    .replace(/\s+/g, ' ')
                                    .trim()
                                    .toLowerCase();

                                const visible = el => {
                                    if (!el || !el.isConnected) return false;
                                    const r = el.getBoundingClientRect();
                                    const st = getComputedStyle(el);
                                    return r.width > 2 && r.height > 2 &&
                                        r.bottom > 0 && r.right > 0 &&
                                        r.top < innerHeight && r.left < innerWidth &&
                                        st.display !== 'none' &&
                                        st.visibility !== 'hidden' &&
                                        st.opacity !== '0';
                                };

                                const objetivoLimpio = normalizar(objetivo);
                                const idLimpio = normalizar(idGrupo || '');

                                const dialogos = Array.from(document.querySelectorAll(
                                    'div[role="dialog"], [aria-modal="true"]'
                                )).filter(visible).filter(el =>
                                    /share to groups|select groups|compartir en grupos|seleccionar grupos/i.test(
                                        normalizar(el.innerText || el.textContent || '')
                                    )
                                );

                                if (!dialogos.length) {
                                    return { encontrado: false, motivo: 'sin-dialogo-grupos' };
                                }

                                // Facebook puede reciclar la fila inmediatamente después
                                // del click. Por eso NO usamos referencias DOM anteriores.
                                // Buscamos nuevamente el nombre y los controles actuales.
                                for (const root of dialogos) {
                                    const controles = Array.from(root.querySelectorAll(
                                        'input[aria-checked], [role="checkbox"][aria-checked], [role="radio"][aria-checked]'
                                    )).filter(visible);

                                    const seleccionados = controles.filter(el =>
                                        el.getAttribute('aria-checked') === 'true'
                                    );

                                    if (!seleccionados.length) continue;

                                    // 1) Relación directa por ancestro: es la comprobación
                                    // más fiable cuando Facebook conserva la estructura.
                                    for (const control of seleccionados) {
                                        let ancestro = control;
                                        for (let nivel = 0; ancestro && ancestro !== root && nivel < 14; nivel++, ancestro = ancestro.parentElement) {
                                            if (!visible(ancestro)) continue;

                                            const textoAncestro = normalizar(
                                                ancestro.innerText || ancestro.textContent || ''
                                            );
                                            const rect = ancestro.getBoundingClientRect();

                                            if (
                                                rect.width >= 100 &&
                                                rect.height >= 24 &&
                                                rect.height <= 300 &&
                                                objetivoLimpio &&
                                                textoAncestro.includes(objetivoLimpio)
                                            ) {
                                                return {
                                                    encontrado: true,
                                                    seleccionado: true,
                                                    ariaChecked: 'true',
                                                    checked: control.checked === true,
                                                    ariaSelected: control.getAttribute('aria-selected'),
                                                    inputCount: seleccionados.length,
                                                    metodo: 'aria-checked-ancestro-texto'
                                                };
                                            }
                                        }
                                    }

                                    // 2) Localizar el texto actual del grupo y comparar
                                    // geométricamente con los controles seleccionados.
                                    const textos = Array.from(root.querySelectorAll(
                                        'span,div,a,label,p,[role="link"]'
                                    )).filter(visible).map(el => ({
                                        el,
                                        texto: normalizar(el.innerText || el.textContent || ''),
                                        rect: el.getBoundingClientRect()
                                    })).filter(x =>
                                        objetivoLimpio &&
                                        (x.texto === objetivoLimpio ||
                                         (x.texto.includes(objetivoLimpio) && x.texto.length <= objetivoLimpio.length + 120))
                                    );

                                    for (const textoItem of textos) {
                                        const tr = textoItem.rect;

                                        let mejor = null;
                                        let mejorDistancia = Infinity;

                                        for (const control of seleccionados) {
                                            const cr = control.getBoundingClientRect();
                                            const cx = cr.left + cr.width / 2;
                                            const cy = cr.top + cr.height / 2;
                                            const tx = tr.left + tr.width / 2;
                                            const ty = tr.top + tr.height / 2;
                                            const dx = cx - tx;
                                            const dy = cy - ty;
                                            const distancia = Math.sqrt(dx * dx + dy * dy);

                                            // El control y el texto de una fila de Facebook
                                            // normalmente están a poca distancia horizontal.
                                            if (Math.abs(dy) <= Math.max(45, tr.height * 1.8) && distancia < mejorDistancia) {
                                                mejor = control;
                                                mejorDistancia = distancia;
                                            }
                                        }

                                        if (mejor) {
                                            return {
                                                encontrado: true,
                                                seleccionado: true,
                                                ariaChecked: 'true',
                                                checked: mejor.checked === true,
                                                ariaSelected: mejor.getAttribute('aria-selected'),
                                                inputCount: seleccionados.length,
                                                metodo: 'aria-checked-proximidad-texto',
                                                distancia: Math.round(mejorDistancia)
                                            };
                                        }
                                    }

                                    // 3) Si existe exactamente un control seleccionado,
                                    // todavía podemos aceptar únicamente cuando el texto
                                    // del grupo aparece en alguno de sus contenedores cercanos.
                                    if (seleccionados.length === 1) {
                                        const control = seleccionados[0];
                                        let ancestro = control.parentElement;
                                        for (let nivel = 0; ancestro && ancestro !== root && nivel < 10; nivel++, ancestro = ancestro.parentElement) {
                                            const texto = normalizar(ancestro.innerText || ancestro.textContent || '');
                                            if (objetivoLimpio && texto.includes(objetivoLimpio)) {
                                                return {
                                                    encontrado: true,
                                                    seleccionado: true,
                                                    ariaChecked: 'true',
                                                    checked: control.checked === true,
                                                    ariaSelected: control.getAttribute('aria-selected'),
                                                    inputCount: 1,
                                                    metodo: 'aria-checked-unico-texto-cercano'
                                                };
                                            }
                                        }
                                    }

                                    // El ID solo sirve como diagnóstico; no aceptamos un
                                    // control seleccionado ambiguo por ID sin relación visual.
                                    if (idLimpio) {
                                        const coincidenciasId = Array.from(root.querySelectorAll(
                                            '[data-id],[data-group-id],[data-groupid],[data-testid],a[href]'
                                        )).filter(visible).filter(el => {
                                            const valores = [
                                                el.getAttribute('data-id'),
                                                el.getAttribute('data-group-id'),
                                                el.getAttribute('data-groupid'),
                                                el.getAttribute('data-testid'),
                                                el.getAttribute('href')
                                            ].filter(Boolean).map(normalizar);
                                            return valores.some(v => v === idLimpio || v.includes(idLimpio));
                                        });

                                        if (coincidenciasId.length === 1 && seleccionados.length === 1) {
                                            return {
                                                encontrado: true,
                                                seleccionado: true,
                                                ariaChecked: 'true',
                                                checked: seleccionados[0].checked === true,
                                                ariaSelected: seleccionados[0].getAttribute('aria-selected'),
                                                inputCount: 1,
                                                metodo: 'aria-checked-id-unico'
                                            };
                                        }
                                    }
                                }

                                return {
                                    encontrado: false,
                                    motivo: 'aria-checked-true-no-asociado-al-grupo'
                                };
                            },
                            { objetivo, idGrupo }
                        );
                    } catch (error) {
                        estado = {
                            encontrado: false,
                            motivo: `error-confirmacion: ${error.message}`
                        };
                    }

                    if (estado?.encontrado) {
                        console.log(
                            `[Facebook][V90] Estado semántico: ` +
                            `aria-checked=${estado.ariaChecked ?? '-'} ` +
                            `checked=${estado.checked ? 'true' : 'false'} ` +
                            `aria-selected=${estado.ariaSelected ?? '-'} ` +
                            `inputs=${estado.inputCount ?? 0} ` +
                            `método=${estado.metodo || '-'}${estado.distancia != null ? ` distancia=${estado.distancia}px` : ''}`
                        );

                        if (estado.seleccionado === true && estado.ariaChecked === 'true') {
                            return estado;
                        }
                    } else {
                        console.log(
                            `[Facebook][V90] Relectura: aún no confirmada (${estado?.motivo || 'sin motivo'}).`
                        );
                    }

                    await esperar(250);
                }

                return null;
            };

            const confirmacion = await confirmarSeleccionSemantica();

            if (confirmacion?.seleccionado === true) {
                console.log(
                    `[Facebook][V90] ✓ Grupo seleccionado y confirmado por aria-checked=true: ${nombreLimpio}`
                );
                return true;
            }

            console.warn(
                `[Facebook][V90] No fue posible confirmar aria-checked=true para: ${nombreLimpio}`
            );
            console.warn(
                '[Facebook][V90] NO se hará un segundo click. Se detiene aquí para evitar deseleccionar el grupo.'
            );
            return false;
        }

        const maxScroll = estadoLista.maxScrollTop;
        const actual = estadoLista.scrollTop;

        if (actual !== ultimoScroll) {
            ultimoScroll = actual;
            sinCambio = 0;
        } else {
            sinCambio++;
        }

        if (actual >= maxScroll - 5) {
            if (vueltas >= 1) {
                console.warn(
                    `[Facebook] Grupo no encontrado después de recorrer ` +
                    `toda la lista: ${nombreLimpio}`
                );
                return false;
            }

            // Una sola vuelta al principio. NO cerramos el diálogo.
            console.log(
                `[Facebook] Grupo no visible al final; ` +
                `regresando al principio de la lista sin cerrar "Share to groups".`
            );

            await page.evaluate(() => {
                const normalizar = v => String(v || '')
                    .normalize('NFD')
                    .replace(/[\u0300-\u036f]/g, '')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .toLowerCase();

                const visible = el => {
                    if (!el) return false;
                    const r = el.getBoundingClientRect();
                    const s = getComputedStyle(el);
                    return r.width > 250 &&
                        r.height > 120 &&
                        s.display !== 'none' &&
                        s.visibility !== 'hidden' &&
                        s.opacity !== '0';
                };

                const dialogos = Array.from(document.querySelectorAll(
                    'div[role="dialog"], [aria-modal="true"]'
                )).filter(visible).filter(el =>
                    /share to groups|select groups|compartir en grupos|seleccionar grupos/i
                        .test(normalizar(el.innerText || el.textContent || ''))
                );

                const candidatos = [];

                for (const dialogo of dialogos) {
                    [dialogo, ...Array.from(dialogo.querySelectorAll('*'))]
                        .filter(visible)
                        .filter(el => el.scrollHeight > el.clientHeight + 30)
                        .forEach(el => {
                            const r = el.getBoundingClientRect();
                            candidatos.push({
                                el,
                                delta: el.scrollHeight - el.clientHeight,
                                area: r.width * r.height
                            });
                        });
                }

                candidatos.sort((a, b) =>
                    b.delta - a.delta || b.area - a.area
                );

                const lista = candidatos[0]?.el;
                if (lista) {
                    lista.scrollTop = 0;
                    lista.dispatchEvent(
                        new Event('scroll', { bubbles: true })
                    );
                }
            }).catch(() => {});

            await esperar(700);
            vueltas++;
            ultimoScroll = -1;
            continue;
        }

        const desplazado = await desplazarLista('down');

        if (!desplazado.ok || !desplazado.cambio) {
            sinCambio++;

            if (sinCambio >= 3) {
                console.warn(
                    `[Facebook] La lista virtualizada no avanza mientras ` +
                    `se busca "${nombreLimpio}".`
                );
                return false;
            }
        } else {
            pasos++;

            if (
                pasos === 1 ||
                pasos % 3 === 0 ||
                desplazado.ahora >= desplazado.max - 5
            ) {
                console.log(
                    `[Facebook] Recorrido de búsqueda ${pasos}: ` +
                    `${desplazado.ahora}/${desplazado.max}`
                );
            }

            await esperar(500);
        }
    }

    console.warn(
        `[Facebook] Tiempo agotado buscando el grupo: ${nombreLimpio}`
    );

    return false;
}

async function hacerClickAtrasFacebook(page, timeout = 10000) {
    // En Facebook el botón "Fet/Done" puede aceptar el evento visual
    // pero mantener el nodo del diálogo anterior en el DOM durante unos
    // instantes. No debemos interpretar ese nodo residual como que el
    // usuario sigue en "Share to groups".
    //
    // IMPORTANTE: se identifica primero el control REAL por el texto
    // "Fet/Done/Listo" y SOLO después se realiza UN click físico sobre su
    // centro. Nunca se hacen clicks adicionales sobre la lista de grupos.
    const inicio = Date.now();
    let controlConfirmado = false;

    while (Date.now() - inicio < timeout) {
        const resultado = await page.evaluate(() => {
            const normalizar = valor => String(valor || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();

            const visible = el => {
                if (!el) return false;
                const r = el.getBoundingClientRect();
                const s = getComputedStyle(el);
                return r.width > 5 && r.height > 5 &&
                s.display !== 'none' &&
                s.visibility !== 'hidden' &&
                s.opacity !== '0';
            };

            const etiquetas = new Set([
                'fet', 'done', 'listo', 'hecho', 'finalizar', 'terminar'
            ]);

            const candidatos = Array.from(document.querySelectorAll('*'))
            .filter(visible)
            .map(el => ({
                el,
                texto: normalizar(el.innerText || el.textContent || ''),
                        rect: el.getBoundingClientRect()
            }))
            .filter(x => etiquetas.has(x.texto))
            .filter(x => x.rect.top >= window.innerHeight * 0.55)
            .filter(x => x.rect.width >= 10 && x.rect.height >= 8)
            .sort((a, b) => {
                return b.rect.bottom - a.rect.bottom ||
                (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height);
            });

            for (const candidato of candidatos) {
                let actual = candidato.el;
                let mejor = null;

                for (let nivel = 0; nivel < 12 && actual; nivel++) {
                    const r = actual.getBoundingClientRect();
                    const s = getComputedStyle(actual);
                    const tag = String(actual.tagName || '').toLowerCase();
                    const role = normalizar(actual.getAttribute?.('role'));
                    const aria = normalizar(actual.getAttribute?.('aria-label'));
                    const title = normalizar(actual.getAttribute?.('title'));
                    const interactivo =
                    tag === 'button' ||
                    role === 'button' ||
                    actual.hasAttribute?.('tabindex') ||
                    s.cursor === 'pointer' ||
                    aria === 'fet' || aria === 'done' || aria === 'listo' ||
                    title === 'fet' || title === 'done';

                    const pareceFooter =
                    r.top >= window.innerHeight * 0.50 &&
                    r.width >= 80 &&
                    r.height >= 24 &&
                    r.width < window.innerWidth * 0.95;

                    if (visible(actual) && interactivo && pareceFooter) {
                        mejor = actual;
                        break;
                    }

                    actual = actual.parentElement;
                }

                if (!mejor) continue;

                const r = mejor.getBoundingClientRect();
                if (r.width < 80 || r.height < 24 || r.top < window.innerHeight * 0.50) {
                    continue;
                }

                mejor.scrollIntoView({ block: 'nearest', inline: 'nearest' });

                return {
                    ok: true,
                    etiqueta: candidato.texto,
                    rect: {
                        left: r.left,
                        top: r.top,
                        width: r.width,
                        height: r.height
                    }
                };
            }

            return { ok: false };
        }).catch(() => ({ ok: false }));

        if (resultado && resultado.ok) {
            controlConfirmado = true;

            const x = resultado.rect.left + resultado.rect.width / 2;
            const y = resultado.rect.top + resultado.rect.height / 2;

            console.log(
                `[Facebook] Control REAL "Fet/Done" confirmado (${Math.round(resultado.rect.width)}x${Math.round(resultado.rect.height)}).`
            );
            console.log(
                `[Facebook] Pulsando UNA SOLA VEZ "Fet/Done" mediante click físico en (${Math.round(x)}, ${Math.round(y)}).`
            );

            // Un click físico reproduce el comportamiento real de un usuario
            // y evita que React/Facebook ignore un HTMLElement.click().
            await page.mouse.click(x, y);

            console.log('[Facebook] Click de "Fet/Done" realizado. Esperando transición a "Post settings"...');
            await esperar(1200);
            break;
        }

        await esperar(300);
    }

    if (!controlConfirmado) {
        console.warn('[Facebook] No se encontró el control REAL "Fet/Done/Listo". Se cancela el paso para evitar seleccionar accidentalmente otro grupo.');
        return false;
    }

    // Facebook puede tardar varios segundos en desmontar el diálogo de
    // "Share to groups". Consideramos correcto el regreso cuando el diálogo
    // activo de mayor z-index ya corresponde a "Post settings".
    const esperaFinal = Date.now();

    while (Date.now() - esperaFinal < Math.max(5000, timeout)) {
        const estado = await page.evaluate(() => {
            const normalizar = valor => String(valor || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();

            const visible = el => {
                if (!el) return false;
                const r = el.getBoundingClientRect();
                const s = getComputedStyle(el);
                return r.width > 20 && r.height > 20 &&
                s.display !== 'none' &&
                s.visibility !== 'hidden' &&
                s.opacity !== '0';
            };

            const dialogos = Array.from(document.querySelectorAll(
                'div[role="dialog"], [aria-modal="true"]'
            )).filter(visible);

            const datos = dialogos.map((el, indice) => {
                const r = el.getBoundingClientRect();
                const s = getComputedStyle(el);
                const texto = normalizar(el.innerText || el.textContent || '');
                const z = Number.parseInt(s.zIndex, 10);
                return {
                    indice,
                    texto,
                    z: Number.isFinite(z) ? z : 0,
                                       area: r.width * r.height,
                                       top: r.top,
                                       left: r.left
                };
            });

            const postSettings = datos.filter(d =>
            d.texto.includes('post settings') ||
            d.texto.includes('scheduling options') ||
            d.texto.includes('configuracion de publicacion') ||
            d.texto.includes('configuración de publicación') ||
            d.texto.includes('opciones de programacion') ||
            d.texto.includes('opciones de programación')
            );

            const share = datos.filter(d =>
            d.texto.includes('share to groups') ||
            d.texto.includes('compartir en grupos') ||
            d.texto.includes('select groups') ||
            d.texto.includes('seleccionar grupos')
            );

            const activoPost = postSettings.sort((a, b) =>
            b.z - a.z || b.area - a.area
            )[0] || null;

            const activoShare = share.sort((a, b) =>
            b.z - a.z || b.area - a.area
            )[0] || null;

            if (activoPost && (!activoShare || activoPost.z >= activoShare.z)) {
                return {
                    regreso: true,
                    postZ: activoPost.z,
                    shareZ: activoShare ? activoShare.z : null,
                    dialogos: datos.map(d => ({z:d.z, texto:d.texto.slice(0,180)}))
                };
            }

            return {
                regreso: false,
                postZ: activoPost ? activoPost.z : null,
                shareZ: activoShare ? activoShare.z : null,
                dialogos: datos.map(d => ({z:d.z, texto:d.texto.slice(0,180)}))
            };
        }).catch(() => ({ regreso: false }));

        if (estado.regreso) {
            console.log(
                `[Facebook] ✓ Regresó a "Post settings". Post settings z-index=${estado.postZ}; Share to groups z-index=${estado.shareZ === null ? 'no visible' : estado.shareZ}.`
            );
            return true;
        }

        await esperar(400);
    }

    console.warn('[Facebook] El click de "Fet/Done" fue realizado, pero Facebook no mostró "Post settings" como diálogo activo. No se hará ningún click adicional sobre la lista de grupos.');
    return false;
}

async function configurarGruposCompartirFacebook(page, grupos, timeout = 30000) {
    const gruposValidos = normalizarGruposFacebookPublicacion(grupos);

    if (gruposValidos.length === 0) {
        throw new Error(
            'La publicación no tiene grupos de Facebook seleccionados en Laravel.'
        );
    }

    console.log(
        `[Facebook] Seleccionando ${gruposValidos.length} grupo(s) seleccionados en Laravel.`
    );

    const shareGroupsAbierto = await hacerClickPorTexto(
        page,
        [
            'share to groups',
            'share in groups',
            'compartir en grupos',
            'compartir en un grupo'
        ],
        12000,
        null
    );

    if (!shareGroupsAbierto) {
        throw new Error(
            'No se encontró la opción "Share to groups" en Post settings.'
        );
    }

    await esperar(1500);

    for (const grupo of gruposValidos) {
        const nombre = limpiarNombreGrupoFacebook(grupo.nombre || grupo.name || '');
        const url = grupo.url || '';
        grupo.nombre = nombre;
        if (!grupo.facebook_id && url) grupo.facebook_id = extraerIdGrupoFacebook(url);

        const seleccionado = await seleccionarGrupoFacebookEnDialogo(
            page,
            nombre,
            timeout,
            url,
            grupo.facebook_id || grupo.facebookId || grupo.group_id || grupo.groupId || ''
        );

        if (!seleccionado) {
            throw new Error(
                `No se pudo seleccionar el grupo de Facebook "${nombre}".`
            );
        }

        console.log(`[Facebook] ✓ Grupo seleccionado: ${nombre}`);
    }

    // IMPORTANTE: todos los grupos se seleccionan dentro del MISMO
    // diálogo. Solo después de completar la selección se pulsa "Fet/Done"
    // una única vez para volver a Post settings.
    console.log(
        `[Facebook] ✓ Los ${gruposValidos.length} grupo(s) fueron seleccionados. ` +
        `Cerrando "Share to groups" una sola vez.`
    );

    const regresoPostSettings = await hacerClickAtrasFacebook(
        page,
        Math.min(timeout, 15000)
    );

    if (!regresoPostSettings) {
        throw new Error(
            'Facebook no confirmó el regreso a "Post settings" después de seleccionar los grupos.'
        );
    }

    return true;
}

async function hacerClickPublicarFacebook(page, timeout = 30000) {
    const inicio = Date.now();
    const etiquetasSiguiente = ['següent', 'seguent', 'siguiente', 'next'];
    let siguientePulsado = false;
    let intentoGlobalRealizado = false;

    // Facebook puede cambiar el contenedor del compositor. Primero se intenta
    // el diálogo habitual y luego se busca un control visible en toda la página.
    while (Date.now() - inicio < timeout) {
        const restante = Math.max(500, timeout - (Date.now() - inicio));
        let siguiente = await hacerClickPorTexto(
            page, etiquetasSiguiente, Math.min(1800, restante), 'div[role="dialog"]'
        );

        if (!siguiente) {
            siguiente = await hacerClickPorTexto(
                page, etiquetasSiguiente,
                Math.min(1200, Math.max(500, timeout - (Date.now() - inicio))), null
            );
            intentoGlobalRealizado = true;
        }

        if (siguiente) {
            console.log(`[Facebook] Botón "Següent/Siguiente/Next" localizado${intentoGlobalRealizado ? ' en la página completa' : ' en el diálogo'}.`);
            await esperar(1800);
            siguientePulsado = true;
            break;
        }
        await esperar(400);
    }

    if (!siguientePulsado) {
        const diagnostico = await page.evaluate(() => {
            const visible = el => {
                const r = el.getBoundingClientRect();
                const s = getComputedStyle(el);
                return r.width > 2 && r.height > 2 && s.display !== 'none' &&
                    s.visibility !== 'hidden' && s.opacity !== '0';
            };
            return Array.from(document.querySelectorAll('button,[role="button"],a,[tabindex="0"]'))
                .filter(visible)
                .map(el => ({
                    tag: el.tagName,
                    role: el.getAttribute('role'),
                    ariaLabel: el.getAttribute('aria-label'),
                    title: el.getAttribute('title'),
                    testId: el.getAttribute('data-testid'),
                    text: String(el.innerText || el.textContent || '').trim().slice(0, 100),
                    disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true')
                }))
                .filter(x => /següent|seguent|siguiente|next/i.test([x.ariaLabel, x.title, x.testId, x.text].filter(Boolean).join(' ')))
                .slice(0, 20);
        }).catch(error => [{ error: error.message }]);
        console.warn('[Facebook] No se localizó "Següent". Controles candidatos visibles:', JSON.stringify(diagnostico));
        return false;
    }

    return true;
}

async function cerrarModalInformacionFacebook(page, timeout = 10000) {
    const inicio = Date.now();
    let detectado = false;

    const inspeccionarModal = async () => page.evaluate(() => {
        const norm = v => String(v || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();

        const visible = el => {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 2 && r.height > 2 &&
            s.display !== 'none' &&
            s.visibility !== 'hidden' &&
            s.opacity !== '0';
        };

        const candidatos = Array.from(
            document.querySelectorAll('[role="dialog"], [aria-modal="true"]')
        ).filter(visible);

        const modal = candidatos.find(el => {
            const t = norm(el.innerText || el.textContent || '');
            return (
                t.includes('to keep facebook safe') ||
                t.includes("we're showing information about people and their profiles") ||
                t.includes('showing information about people and their profiles') ||
                t.includes('para mantener facebook seguro') ||
                t.includes('estamos mostrando informacion sobre las personas y sus perfiles') ||
                t.includes('informacion sobre las personas y sus perfiles')
            );
        });

        if (!modal) {
            return { detectado: false, cerrado: false };
        }

        const controles = Array.from(
            modal.querySelectorAll('button,[role="button"],[aria-label],[title]')
        ).filter(visible);

        const cerrar = controles.find(el => {
            const valores = [
                el.getAttribute('aria-label'),
                                      el.getAttribute('title'),
                                      el.innerText,
                                      el.textContent
            ].filter(Boolean).map(norm);

            return valores.some(t =>
            t === 'close' ||
            t === 'cerrar' ||
            t === 'close dialog' ||
            t === 'cerrar dialogo' ||
            t === 'cerrar el dialogo' ||
            t === 'dismiss' ||
            t === 'dismiss dialog'
            );
        });

        if (cerrar) {
            cerrar.scrollIntoView({ block: 'center', inline: 'center' });
            cerrar.dispatchEvent(new MouseEvent('mousedown', {
                bubbles: true,
                cancelable: true,
                view: window
            }));
            cerrar.dispatchEvent(new MouseEvent('mouseup', {
                bubbles: true,
                cancelable: true,
                view: window
            }));
            cerrar.click();
            return { detectado: true, cerrado: true };
        }

        // Algunas variantes de Facebook no exponen texto en el botón de cierre.
        // En ese caso buscamos un control pequeño situado en la cabecera del modal.
        const pequenos = controles.filter(el => {
            const r = el.getBoundingClientRect();
            return r.width >= 20 && r.width <= 70 && r.height >= 20 && r.height <= 70;
        });

        if (pequenos.length) {
            pequenos.sort((a, b) => {
                const ra = a.getBoundingClientRect();
                const rb = b.getBoundingClientRect();
                return ra.top - rb.top || rb.left - ra.left;
            });

            const posibleCerrar = pequenos[0];
            posibleCerrar.click();
            return { detectado: true, cerrado: true };
        }

        return { detectado: true, cerrado: false };
    }).catch(() => ({ detectado: false, cerrado: false }));

    while (Date.now() - inicio < timeout) {
        const resultado = await inspeccionarModal();

        if (!resultado.detectado) {
            if (detectado) {
                console.log('[Facebook] Modal informativo cerrado correctamente.');
            }
            return true;
        }

        if (resultado.detectado) {
            if (!detectado) {
                console.log('[Facebook] Detectado modal informativo de seguridad de Facebook.');
                console.log('[Facebook] Cerrando el modal para continuar...');
                detectado = true;
            }

            if (resultado.cerrado) {
                await esperar(800);
            } else {
                await esperar(500);
            }
            continue;
        }

        await esperar(500);
    }

    if (detectado) {
        throw new Error(
            'Facebook mostró el modal informativo de seguridad, pero no fue posible cerrarlo automáticamente.'
        );
    }

    return true;
}

async function asegurarModoPaginaFacebook(page, timeout = 30000) {
    // La sesión persistente define la identidad de Facebook. No hacemos clic
    // en "Switch Now" ni en controles de identidad: podrían cambiar el perfil.
    // El aviso puede permanecer en el DOM durante toda la sesión, por lo que
    // esperarlo en un bucle solo bloquea el bot y repite el mismo mensaje.
    if (!page || page.isClosed()) {
        throw new Error('La pestaña de Facebook no está disponible.');
    }

    console.log('[Facebook] Verificando sesión de la Página...');
    await cerrarModalInformacionFacebook(page, Math.min(timeout, 10000));

    const estado = await page.evaluate(() => {
        const normalizar = valor => String(valor || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();

        const visible = el => {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            const s = window.getComputedStyle(el);
            return r.width > 2 && r.height > 2 &&
                s.display !== 'none' && s.visibility !== 'hidden' &&
                s.opacity !== '0';
        };

        // Buscar primero dentro de diálogos visibles para evitar que una
        // mención residual en cualquier parte del DOM active falsos positivos.
        const dialogos = Array.from(document.querySelectorAll(
            '[role="dialog"], [aria-modal="true"]'
        )).filter(visible);
        const textosDialogo = dialogos.map(el => normalizar(el.innerText || el.textContent || ''));
        const fraseObjetivo = textosDialogo.some(texto =>
            texto.includes('switch into cerveceria clasico dubai') ||
            texto.includes('cambiar a cerveceria clasico dubai')
        );

        // Facebook puede mostrar el aviso fuera de un diálogo. En ese caso
        // solo se considera detectado si la frase está realmente visible.
        const textoVisible = normalizar(document.body?.innerText || '');
        const avisoVisible = fraseObjetivo ||
            textoVisible.includes('switch into cerveceria clasico dubai') ||
            textoVisible.includes('cambiar a cerveceria clasico dubai');

        return {
            url: location.href,
            titulo: document.title || '',
            avisoVisible,
            enLogin: /\/(login|checkpoint)(\/|$)/i.test(location.pathname)
        };
    }).catch(() => ({
        url: page.url(),
        titulo: '',
        avisoVisible: false,
        enLogin: /login|checkpoint/i.test(page.url())
    }));

    if (estado.enLogin) {
        throw new Error('Facebook requiere autenticación o revisión de seguridad; no se cambiará la identidad automáticamente.');
    }

    if (estado.avisoVisible) {
        // Advertencia única: no repetirla ni esperar 30 s por un aviso que
        // requiere una decisión explícita del usuario en la interfaz.
        if (!asegurarModoPaginaFacebook._avisoIdentidadRegistrado) {
            console.warn('[Facebook] Facebook muestra el aviso para cambiar a Cervecería Clásico Dubai. No se hará clic automáticamente; se continuará con la identidad de la sesión persistente.');
            asegurarModoPaginaFacebook._avisoIdentidadRegistrado = true;
        }
    } else {
        asegurarModoPaginaFacebook._avisoIdentidadRegistrado = false;
        console.log('[Facebook] No se detectó un aviso de cambio de identidad. Se conserva la identidad de la sesión persistente.');
    }

    return true;
}

async function obtenerUrlPublicacionOrigenFacebook(page, texto, timeout = 20000) {
    if (!page || page.isClosed()) return '';

    const inicio = Date.now();
    const textoNormalizado = String(texto || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);

    while (Date.now() - inicio < timeout) {
        try {
            const candidatos = await page.evaluate((textoBuscado) => {
                const normalizar = valor => String(valor || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

                const resultado = [];
                const vistos = new Set();

                for (const a of document.querySelectorAll('a[href]')) {
                    const href = String(a.href || '');
                    if (!/^https?:\/\/(www\.)?facebook\.com\//i.test(href)) continue;
                        if (!/(\/posts\/|\/permalink\.php|story_fbid=|\/photos\/)/i.test(href)) continue;

                        const contenedor = a.closest('[role="article"]') || a.parentElement;
                    const textoArticulo = normalizar(
                        contenedor ? (contenedor.innerText || contenedor.textContent || '') : (a.innerText || '')
                    );

                    const score =
                    (textoBuscado && textoArticulo.includes(textoBuscado)) ? 100 :
                    /\/posts\//i.test(href) ? 50 : 10;

                    const canonica = href.replace(/[?#].*$/, '').replace(/\/$/, '');
                    if (!vistos.has(canonica)) {
                        vistos.add(canonica);
                        resultado.push({ href: canonica, score, texto: textoArticulo.slice(0, 300) });
                    }
                }

                return resultado.sort((a, b) => b.score - a.score).slice(0, 20);
            }, textoNormalizado);

            if (Array.isArray(candidatos) && candidatos.length) {
                const elegido = candidatos[0];
                console.log(`[Facebook] URL de la publicación origen detectada: ${elegido.href}`);
                return normalizarUrlPublicacionFacebook(elegido.href);
            }
        } catch (_) {}

        await esperar(1000);
    }

    console.warn('[Facebook] No se pudo localizar la URL de la publicación origen; la publicación ya fue aceptada por Facebook.');
    return '';
}

async function cerrarCompositoresFacebook(page, motivo = '') {

    if (!page || page.isClosed()) {
        return;
    }

    try {
        console.log(
            `[Facebook] Cerrando diálogos/compositor pendientes${motivo ? `: ${motivo}` : ''}.`
        );

        // Escape cierra el diálogo superior. Repetimos unas pocas veces
        // para limpiar también un diálogo superpuesto dejado por Facebook.
        for (let i = 0; i < 4; i++) {
            await page.keyboard.press('Escape').catch(() => {});
            await esperar(350);

            const quedan = await page.evaluate(() => {
                const visibles = el => {
                    if (!el) return false;

                    const r = el.getBoundingClientRect();
                    const s = window.getComputedStyle(el);

                    return (
                        r.width > 20 &&
                        r.height > 20 &&
                        s.display !== 'none' &&
                        s.visibility !== 'hidden' &&
                        s.opacity !== '0'
                    );
                };

                return Array.from(
                    document.querySelectorAll(
                        'div[role="dialog"], [aria-modal="true"]'
                    )
                )
                .filter(visibles)
                .some(dialogo => {
                    const texto = String(
                        dialogo.innerText ||
                        dialogo.textContent ||
                        ''
                    )
                    .normalize('NFD')
                    .replace(/[\u0300-\u036f]/g, '')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .toLowerCase();

                    return (
                        !!dialogo.querySelector('input[type="file"]') ||
                        /crear publicacion|crear una publicacion|create post|what is on your mind|what's on your mind|en que penses|share a thought|post settings|share to groups/.test(texto)
                    );
                });
            }).catch(() => false);

            if (!quedan) {
                break;
            }
        }

    } catch (error) {
        console.warn(
            `[Facebook] No se pudo limpiar completamente el compositor: ${error.message}`
        );
    }
}


async function diagnosticarPublicaPostSettingsFacebook(page) {
    const ruta = path.join(
        __dirname,
        'facebook_publica_diagnostico_v91.json'
    );

    const datos = await page.evaluate(() => {
        const normalizar = valor => String(valor || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[\u200B-\u200D\uFEFF]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();

        const visible = el => {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return (
                r.width > 0 &&
                r.height > 0 &&
                r.bottom > 0 &&
                r.right > 0 &&
                s.display !== 'none' &&
                s.visibility !== 'hidden' &&
                s.opacity !== '0'
            );
        };

        const rutaElemento = el => {
            const partes = [];
            let actual = el;
            let nivel = 0;

            while (actual && nivel < 7) {
                let parte = actual.tagName || '';
                if (actual.id) parte += `#${actual.id}`;
                if (actual.getAttribute) {
                    const role = actual.getAttribute('role');
                    const aria = actual.getAttribute('aria-label');
                    if (role) parte += `[role="${role}"]`;
                    if (aria) parte += `[aria-label="${aria.slice(0,80)}"]`;
                }
                partes.push(parte);
                actual = actual.parentElement;
                nivel++;
            }

            return partes.join(' <- ');
        };

        const informacionElemento = (el, indice, textoOrigen) => {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);

            const attrs = {};
            [
                'role',
                'aria-label',
                'aria-describedby',
                'aria-expanded',
                'aria-haspopup',
                'aria-disabled',
                'tabindex',
                'type',
                'name',
                'value',
                'data-testid',
                'data-action',
                'data-visualcompletion'
            ].forEach(nombre => {
                const valor = el.getAttribute(nombre);
                if (valor !== null) attrs[nombre] = valor;
            });

            return {
                indice,
                tag: el.tagName,
                texto: String(
                    el.innerText ||
                    el.textContent ||
                    ''
                ).replace(/\s+/g, ' ').trim().slice(0, 500),
                textoOrigen,
                attrs,
                disabled: !!el.disabled,
                className: String(el.className || '').slice(0, 500),
                rect: {
                    x: Math.round(r.x),
                    y: Math.round(r.y),
                    width: Math.round(r.width),
                    height: Math.round(r.height)
                },
                style: {
                    display: cs.display,
                    visibility: cs.visibility,
                    opacity: cs.opacity,
                    pointerEvents: cs.pointerEvents,
                    cursor: cs.cursor,
                    position: cs.position,
                    zIndex: cs.zIndex
                },
                ruta: rutaElemento(el)
            };
        };

        const dialogos = Array.from(
            document.querySelectorAll(
                'div[role="dialog"], [aria-modal="true"]'
            )
        ).filter(visible);

        const candidatos = [];
        const patrones = [
            'publica',
            'publicar',
            'publish',
            'post',
            'programar',
            'programación',
            'programacion',
            'schedule',
            'scheduling'
        ];

        dialogos.forEach((dialogo, dialogoIndex) => {
            const elementos = Array.from(
                dialogo.querySelectorAll(
                    'button, [role="button"], input[type="button"], input[type="submit"], a, div[tabindex], span[role="button"]'
                )
            ).filter(visible);

            elementos.forEach((el, indice) => {
                const aria = normalizar(el.getAttribute('aria-label') || '');
                const title = normalizar(el.getAttribute('title') || '');
                const texto = normalizar(el.innerText || el.textContent || '');
                const contenido = `${aria} ${title} ${texto}`;

                if (!patrones.some(p => contenido.includes(p))) return;

                const info = informacionElemento(
                    el,
                    indice,
                    `dialogo-${dialogoIndex}`
                );

                info.dialogoIndex = dialogoIndex;
                info.coincidencias = patrones.filter(
                    p => contenido.includes(p)
                );

                // Capturamos hasta tres ancestros para descubrir cuál
                // es el control accionable real, sin ejecutar ninguna acción.
                info.ancestros = [];
                let ancestro = el.parentElement;
                for (let i = 0; ancestro && i < 4; i++, ancestro = ancestro.parentElement) {
                    if (!visible(ancestro)) continue;
                    const ar = ancestro.getBoundingClientRect();
                    const acs = getComputedStyle(ancestro);

                    info.ancestros.push({
                        nivel: i + 1,
                        tag: ancestro.tagName,
                        role: ancestro.getAttribute('role'),
                        ariaLabel: ancestro.getAttribute('aria-label'),
                        texto: String(
                            ancestro.innerText ||
                            ancestro.textContent ||
                            ''
                        ).replace(/\s+/g, ' ').trim().slice(0, 500),
                        rect: {
                            x: Math.round(ar.x),
                            y: Math.round(ar.y),
                            width: Math.round(ar.width),
                            height: Math.round(ar.height)
                        },
                        cursor: acs.cursor,
                        pointerEvents: acs.pointerEvents,
                        className: String(ancestro.className || '').slice(0, 500)
                    });
                }

                candidatos.push(info);
            });
        });

        const dialogResumen = dialogos.map((dialogo, indice) => {
            const r = dialogo.getBoundingClientRect();
            const s = getComputedStyle(dialogo);
            const texto = String(
                dialogo.innerText ||
                dialogo.textContent ||
                ''
            ).replace(/\s+/g, ' ').trim();

            return {
                indice,
                texto: texto.slice(0, 1200),
                rect: {
                    x: Math.round(r.x),
                    y: Math.round(r.y),
                    width: Math.round(r.width),
                    height: Math.round(r.height)
                },
                zIndex: s.zIndex,
                pointerEvents: s.pointerEvents,
                className: String(dialogo.className || '').slice(0, 500)
            };
        });

        return {
            url: location.href,
            timestamp: new Date().toISOString(),
            dialogos: dialogResumen,
            candidatos
        };
    });

    fs.writeFileSync(
        ruta,
        JSON.stringify(datos, null, 2),
        'utf8'
    );

    console.log('');
    console.log('='.repeat(70));
    console.log('[Facebook][V91] DIAGNÓSTICO NO INVASIVO DE "POST SETTINGS"');
    console.log('[Facebook][V91] NO se pulsó "Publica".');
    console.log('[Facebook][V91] NO se pulsó "Scheduling options".');
    console.log(`[Facebook][V91] Candidatos detectados: ${datos.candidatos.length}`);

    datos.candidatos.forEach((c, i) => {
        console.log(
            `[Facebook][V91] #${i + 1} ` +
            `tag=${c.tag} role=${c.attrs.role || '-'} ` +
            `aria-label=${c.attrs['aria-label'] || '-'} ` +
            `texto="${c.texto.slice(0, 140)}" ` +
            `rect=${c.rect.width}x${c.rect.height} ` +
            `x=${c.rect.x} y=${c.rect.y} ` +
            `cursor=${c.style.cursor} ` +
            `pointerEvents=${c.style.pointerEvents} ` +
            `disabled=${c.disabled} ` +
            `coincidencias=${c.coincidencias.join(',')}`
        );
    });

    console.log(`[Facebook][V91] Archivo completo: ${ruta}`);
    console.log('='.repeat(70));

    return ruta;
}

async function crearPublicacionOrigenFacebook(
    publicacion,
    rutaImagen,
    gruposDestino = [],
    estado = null
) {
    comprobarImagen(rutaImagen);

    const texto = publicacion.texto || '';

    const gruposSeleccionados = normalizarGruposFacebookPublicacion(gruposDestino);
    if (gruposSeleccionados.length === 0) {
        throw new Error('La publicación no tiene grupos de Facebook seleccionados en Laravel.');
    }

    console.log('');
    console.log('='.repeat(70));
    console.log('CREANDO PUBLICACIÓN ORIGEN EN FACEBOOK');
    console.log('='.repeat(70));
    console.log(`ID     : ${publicacion.id}`);
    console.log(`Origen : ${FACEBOOK_ORIGEN_URL}`);
    console.log(`Imagen : ${rutaImagen}`);
    console.log(`Grupos : ${gruposSeleccionados.map(g => g.nombre).join(' | ')} (seleccionados en Laravel)`);
    console.log(`Texto  : ${texto}`);

    await cerrarModalInformacionFacebook(facebookPage, Math.min(FACEBOOK_TIMEOUT_MS, 10000));

    const urlActual = facebookPage.url();

    if (
        normalizarUrlFacebook(urlActual) !==
        normalizarUrlFacebook(FACEBOOK_ORIGEN_URL)
    ) {
        await prepararNavegacionFacebook(facebookPage);

        await facebookPage.goto(
            FACEBOOK_ORIGEN_URL,
            {
                waitUntil: 'domcontentloaded',
                timeout: FACEBOOK_TIMEOUT_MS
            }
        );

        await esperar(3000);
    } else {
        await esperar(1000);
    }

    if (/login/i.test(facebookPage.url())) {
        facebookDisponible = false;
        throw new Error('La sesión de Facebook expiró o no está autenticada.');
    }

    await asegurarModoPaginaFacebook(facebookPage, Math.min(FACEBOOK_TIMEOUT_MS, 30000));

    await facebookPage.keyboard.press('Escape').catch(() => {});
    await esperar(500);

    const compositorAbierto = await abrirCompositorFacebook(facebookPage, 25000);
    if (!compositorAbierto) {
        throw new Error('No se encontró el compositor de publicaciones de Facebook en el origen.');
    }

    await esperar(1500);

    const dialogo = await obtenerDialogoFacebook(facebookPage, 10000);
    const selectorRaiz = dialogo ? 'div[role="dialog"]' : null;

    let inputFile = await obtenerInputImagenFacebook(facebookPage, 3000);

    if (!inputFile) {
        const fotoVideoAbierto = await hacerClickPorTexto(
            facebookPage,
            [
                'foto/video',
                'foto o vídeo',
                'photo/video',
                'photo or video',
                'add photos/videos'
            ],
            10000,
            selectorRaiz
        );

        if (!fotoVideoAbierto) {
            throw new Error('No se encontró la opción para agregar la imagen en Facebook.');
        }

        await esperar(1000);
        inputFile = await obtenerInputImagenFacebook(facebookPage, 15000);
    }

    if (!inputFile) {
        throw new Error('Facebook no mostró el selector de archivo para la imagen.');
    }

    await inputFile.uploadFile(rutaImagen);
    await esperar(3000);

    const editor = await obtenerEditorFacebook(facebookPage, 15000);
    if (!editor) {
        throw new Error('No se encontró el campo de texto de la publicación de Facebook.');
    }

    if (texto && texto.trim()) {
        console.log('[Facebook] Limpiando el editor antes de introducir el texto...');

        try {
            await editor.evaluate(el => {
                el.focus();
                if (typeof el.scrollIntoView === 'function') {
                    el.scrollIntoView({ block: 'center', inline: 'center' });
                }
            });

            await esperar(300);

            await facebookPage.keyboard.down('Control');
            await facebookPage.keyboard.press('A');
            await facebookPage.keyboard.up('Control');
            await esperar(150);
            await facebookPage.keyboard.press('Backspace');
            await esperar(250);

            const cdp = await facebookPage.target().createCDPSession();
            try {
                await cdp.send('Input.insertText', { text: String(texto) });
            } finally {
                try { await cdp.detach(); } catch (_) {}
            }
            await esperar(700);

            const textoEditor = await editor.evaluate(el =>
            String(el.innerText || el.textContent || '')
            ).catch(() => '');

            const normalizarTexto = valor => String(valor || '')
            .replace(/\u00a0/g, ' ')
            .replace(/\r\n/g, '\n')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

            const esperadoNormalizado = normalizarTexto(texto);
            const editorNormalizado = normalizarTexto(textoEditor);

            if (editorNormalizado !== esperadoNormalizado) {
                console.warn('[Facebook] El contenido del editor no coincide con el texto de Laravel. Reintentando...');
                console.warn(`[Facebook] Texto detectado en editor: ${textoEditor.slice(0, 300)}`);

                await editor.evaluate(el => el.focus());
                await facebookPage.keyboard.down('Control');
                await facebookPage.keyboard.press('A');
                await facebookPage.keyboard.up('Control');
                await facebookPage.keyboard.press('Backspace');
                await esperar(250);

                const cdpReintento = await facebookPage.target().createCDPSession();
                try {
                    await cdpReintento.send('Input.insertText', { text: String(texto) });
                } finally {
                    try { await cdpReintento.detach(); } catch (_) {}
                }
                await esperar(700);
            }

            console.log('[Facebook] Texto de la publicación colocado sin contenido adicional.');
        } catch (error) {
            throw new Error(`No se pudo introducir correctamente el texto de Facebook: ${error.message}`);
        }
    }

    await esperar(1000);

    // PRIMER PASO: Següent -> Post settings.
    const siguiente = await hacerClickPublicarFacebook(facebookPage, 20000);
    if (!siguiente) {
        throw new Error('No se encontró el botón "Següent/Siguiente/Next" de Facebook.');
    }

    // SEGUNDO PASO: Post settings -> Share to groups -> seleccionar grupos -> volver.
    await configurarGruposCompartirFacebook(
        facebookPage,
        gruposDestino,
        Math.min(FACEBOOK_TIMEOUT_MS, 30000)
    );

    // PUNTO DE CONTROL DEL FLUJO
    // ------------------------------------------------------------
    // En esta versión NO se pulsa "Publica".
    // El objetivo es detenernos exactamente aquí para refinar y validar
    // todo el flujo anterior: compositor -> imagen -> texto ->
    // Següent/Siguiente -> Post settings -> Share to groups ->
    // selección de grupos -> regreso a Post settings.
    //
    // IMPORTANTE:
    // - No se toca "Scheduling options".
    // - No se toca "Publica".
    // - No se cierra Post settings.
    // - No se marca la publicación como enviada.
    // - No se guarda facebookOrigenPublicado.
    // - No se guarda facebookOrigenUrl.
    // - El navegador queda abierto en Post settings para inspección.
    facebookFlujoPausadoEnPostSettings = false;

    // V96: publicación real controlada.
    // Hace UN SOLO click físico sobre el control exacto "Publica" y luego
    // espera a que Facebook termine de procesar la publicación.
    //
    // IMPORTANTE:
    // - NO se pulsa "Scheduling options".
    // - NO se marca la publicación como enviada mientras Facebook esté
    //   mostrando "Posting" / "Carregant...".
    // - Solo se considera éxito si el procesamiento fue observado y el
    //   compositor desaparece sin una señal explícita de error.
    // - Si Facebook no permite confirmar el resultado, el flujo se detiene
    //   sin escribir facebookOrigenUrl ni publicaciones_enviadas.json.
    try {
        console.log('');
        console.log('='.repeat(70));
        console.log('[Facebook][V97] PUBLICACIÓN REAL CONTROLADA');
        console.log('[Facebook][V97] Selector exacto: [role="button"][aria-label="Publica"]');
        console.log('[Facebook][V97] Se hará UN SOLO click físico sobre "Publica".');
        console.log('[Facebook][V97] NO se pulsará "Scheduling options".');
        console.log('[Facebook][V97] Se esperará a que termine "Posting / Carregant...".');

        const controlPublica = await facebookPage.evaluate(() => {
            const visible = el => {
                if (!el) return false;
                const r = el.getBoundingClientRect();
                const s = getComputedStyle(el);
                return r.width > 20 && r.height > 20 &&
                    s.display !== 'none' &&
                    s.visibility !== 'hidden' &&
                    s.opacity !== '0' &&
                    s.pointerEvents !== 'none';
            };

            const candidatos = Array.from(
                document.querySelectorAll('[role="button"][aria-label="Publica"]')
            ).filter(visible).filter(el =>
                el.getAttribute('aria-disabled') !== 'true' && !el.hasAttribute('disabled')
            );

            if (!candidatos.length) return null;

            const el = candidatos[candidatos.length - 1];
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return {
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
                ariaLabel: el.getAttribute('aria-label'),
                role: el.getAttribute('role'),
                ariaDisabled: el.getAttribute('aria-disabled'),
                cursor: s.cursor,
                pointerEvents: s.pointerEvents
            };
        });

        if (!controlPublica) {
            throw new Error('No se encontró el control exacto [role="button"][aria-label="Publica"] habilitado.');
        }

        const clickX = Math.round(controlPublica.x + controlPublica.width / 2);
        const clickY = Math.round(controlPublica.y + controlPublica.height / 2);

        console.log(
            `[Facebook][V96] Control confirmado: role=${controlPublica.role} ` +
            `aria-label=${controlPublica.ariaLabel} ` +
            `rect=${Math.round(controlPublica.width)}x${Math.round(controlPublica.height)} ` +
            `x=${Math.round(controlPublica.x)} y=${Math.round(controlPublica.y)} ` +
            `cursor=${controlPublica.cursor}`
        );
        console.log(`[Facebook][V96] Click físico ÚNICO en (${clickX}, ${clickY}).`);

        await facebookPage.mouse.click(clickX, clickY);
        console.log('[Facebook][V96] ✓ Click físico realizado UNA SOLA VEZ.');
        console.log('[Facebook][V96] Esperando transición de "Posting" a resultado final...');

        const diagnostico = await (async () => {
            const limite = Date.now() + 30000;
            const muestras = [];
            let procesamientoDetectado = false;
            let ultimoUrl = '';

            while (Date.now() < limite) {
                const estado = await facebookPage.evaluate(() => {
                    const normalizar = valor => String(valor || '')
                        .normalize('NFD')
                        .replace(/[\u0300-\u036f]/g, '')
                        .replace(/[\u200B-\u200D\uFEFF]/g, '')
                        .replace(/\s+/g, ' ')
                        .trim()
                        .toLowerCase();

                    const visible = el => {
                        if (!el) return false;
                        const r = el.getBoundingClientRect();
                        const s = getComputedStyle(el);
                        return r.width > 5 && r.height > 5 &&
                            s.display !== 'none' &&
                            s.visibility !== 'hidden' &&
                            s.opacity !== '0';
                    };

                    const texto = el => String(el?.innerText || el?.textContent || '')
                        .replace(/\s+/g, ' ')
                        .trim();

                    const dialogs = Array.from(
                        document.querySelectorAll('div[role="dialog"], [aria-modal="true"]')
                    ).filter(visible);

                    const dialogTexts = dialogs.map(d => texto(d));
                    const bodyText = String(document.body?.innerText || '')
                        .replace(/\s+/g, ' ')
                        .trim();

                    const todo = normalizar(dialogTexts.join(' '));
                    const cuerpo = normalizar(bodyText);

                    const posting = /\bposting\b/.test(todo) || /\bpublicando\b/.test(todo);
                    const loading = Array.from(document.querySelectorAll('[role="status"], [aria-label]'))
                        .filter(visible)
                        .some(el => {
                            const a = normalizar(el.getAttribute('aria-label') || '');
                            const t = normalizar(texto(el));
                            return /carregant|loading|cargando|posting|publicando/.test(`${a} ${t}`);
                        });

                    const postSettings = /post settings|configuracio[nó] de publicacio[nó]/.test(todo);
                    const shareGroups = /share to groups|compartir en grupos|select groups|seleccionar grupos/.test(todo);
                    const createPost = /create post|crear publicacio[nó]|nueva publicacio[nó]|new post/.test(todo);
                    const publicaVisible = Array.from(
                        document.querySelectorAll('[role="button"][aria-label="Publica"]')
                    ).filter(visible).length;

                    const errores = [
                        'something went wrong',
                        'algo salio mal',
                        'algo salió mal',
                        'no se pudo publicar',
                        'couldn\'t post',
                        'could not post',
                        'error al publicar',
                        'try again',
                        'intenta de nuevo'
                    ].filter(x => cuerpo.includes(x));

                    const exito = [
                        'your post was published',
                        'post published',
                        'publicacion publicada',
                        'publicación publicada',
                        'published successfully',
                        'publicado correctamente'
                    ].filter(x => cuerpo.includes(x));

                    return {
                        timestamp: new Date().toISOString(),
                        url: location.href,
                        title: document.title,
                        dialogCount: dialogs.length,
                        dialogTexts: dialogTexts.slice(0, 4).map(t => t.slice(0, 1000)),
                        posting,
                        loading,
                        processing: posting || loading,
                        postSettings,
                        shareGroups,
                        createPost,
                        publicaVisible,
                        errores,
                        exito,
                        bodyTail: bodyText.slice(-1800)
                    };
                }).catch(error => ({
                    timestamp: new Date().toISOString(),
                    url: ultimoUrl,
                    processing: true,
                    errorLectura: error.message
                }));

                ultimoUrl = estado.url || ultimoUrl;
                muestras.push(estado);

                if (estado.processing) {
                    if (!procesamientoDetectado) {
                        console.log('[Facebook][V96] ✓ Facebook está procesando: Posting/Carregant...');
                    }
                    procesamientoDetectado = true;
                }

                if (estado.errores && estado.errores.length) {
                    console.warn(`[Facebook][V96] ✗ Facebook reportó posible error: ${estado.errores.join(', ')}`);
                    return {
                        confirmado: false,
                        motivo: 'error-facebook',
                        procesamientoDetectado,
                        muestras,
                        estadoFinal: estado
                    };
                }

                // Éxito explícito: suficiente por sí mismo, pero siempre
                // exigimos que el click haya iniciado el procesamiento.
                if (procesamientoDetectado && estado.exito && !estado.processing) {
                    console.log('[Facebook][V96] ✓ Facebook mostró una confirmación explícita de publicación.');
                    return {
                        confirmado: true,
                        motivo: 'confirmacion-explicita',
                        procesamientoDetectado,
                        muestras,
                        estadoFinal: estado
                    };
                }

                // V96: Facebook puede mantener un indicador global "Posting"
                // aunque el compositor ya haya sido desmontado. En V94 se
                // observó exactamente ese estado: dialogs=0, Post settings=0
                // y Publica=0 durante 30s, pero processing seguía true.
                // Por eso la desaparición completa del compositor pasa a ser
                // una señal estructural de finalización, siempre que NO exista
                // un mensaje explícito de error.
                if (
                    procesamientoDetectado &&
                    !estado.postSettings &&
                    !estado.shareGroups &&
                    !estado.createPost &&
                    estado.publicaVisible === 0 &&
                    estado.dialogCount === 0
                ) {
                    console.log('[Facebook][V96] ✓ El compositor desapareció completamente.');
                    console.log('[Facebook][V96] ✓ No hay diálogo de error visible.');
                    console.log('[Facebook][V96] ✓ Se considera finalizada la operación aunque el indicador Posting persista.');
                    return {
                        confirmado: true,
                        motivo: 'compositor-desaparecio-indicador-residual',
                        procesamientoDetectado,
                        indicadorProcessingResidual: !!estado.processing,
                        muestras,
                        estadoFinal: estado
                    };
                }

                if (muestras.length === 1 || muestras.length % 5 === 0) {
                    console.log(
                        `[Facebook][V96] estado t=${muestras.length}s ` +
                        `processing=${estado.processing} postSettings=${estado.postSettings} ` +
                        `Publica=${estado.publicaVisible} dialogs=${estado.dialogCount}`
                    );
                }

                await esperar(1000);
            }

            const estadoFinal = muestras[muestras.length - 1] || {};
            return {
                confirmado: false,
                motivo: procesamientoDetectado ? 'timeout-sin-confirmacion' : 'no-se-detecto-procesamiento',
                procesamientoDetectado,
                muestras,
                estadoFinal
            };
        })();

        const rutaDiagnostico = path.join(
            __dirname,
            'facebook_publicacion_diagnostico_v97.json'
        );

        const documentoDiagnostico = {
            timestamp: new Date().toISOString(),
            version: 'V97',
            publicacionId: publicacion.id,
            gruposSeleccionados: gruposDestino.length,
            controlPublica,
            resultado: diagnostico
        };

        fs.writeFileSync(
            rutaDiagnostico,
            JSON.stringify(documentoDiagnostico, null, 2),
            'utf8'
        );

        console.log(`[Facebook][V96] Diagnóstico guardado en: ${rutaDiagnostico}`);

        if (!diagnostico.confirmado) {
            console.log('[Facebook][V96] ⏸ Publicación NO confirmada. Se detiene el flujo para evitar duplicados.');
            console.log('[Facebook][V96] ⛔ No se guardará facebookOrigenUrl.');
            console.log('[Facebook][V96] ⛔ No se marcará ningún grupo como enviado.');
            console.log('[Facebook][V96] ⛔ No se avanzará a la siguiente ocurrencia.');
        } else {
            console.log(`[Facebook][V97] ✓ PUBLICACIÓN CONFIRMADA (${diagnostico.motivo}).`);
            console.log('[Facebook][V96] Se devuelve control al flujo principal para que registre el resultado.');
        }

        console.log('='.repeat(70));

        return {
            detenidoEnPostSettings: !diagnostico.confirmado,
            publicacionConfirmada: diagnostico.confirmado,
            publicacionConfirmadaV94: diagnostico.confirmado,
            diagnosticoPublicacionV94: true,
            motivoConfirmacionV96: diagnostico.motivo,
            publicacionId: publicacion.id,
            gruposSeleccionados: gruposDestino.length,
            diagnosticoRuta: rutaDiagnostico,
            estadoDespues: diagnostico.estadoFinal,
            // V97: Facebook puede no exponer el permalink inmediatamente
            // después de desmontar el compositor. No se inventa ninguno.
            urlPublicacion: null
        };
    } catch (error) {
        console.error(`[Facebook][V93] Error durante el diagnóstico controlado: ${error.message}`);
        throw error;
    }
}

// Publica una copia independiente directamente en el muro de cada grupo.
// No crea una publicación en la Página de origen ni utiliza "Share to groups".
async function publicarDirectamenteEnMuroGrupoFacebook(publicacion, rutaImagen, grupo, page = facebookPage) {
    if (!grupo?.url) throw new Error(`El grupo "${grupo?.nombre || 'desconocido'}" no tiene URL.`);
    comprobarImagen(rutaImagen);

    console.log(`[Facebook][Muro] Abriendo grupo: ${grupo.nombre} (${grupo.url})`);
    await cerrarCompositoresFacebook(page, 'antes de abrir el grupo').catch(() => {});
    await prepararNavegacionFacebook(page);
    await page.goto(grupo.url, { waitUntil: 'domcontentloaded', timeout: FACEBOOK_TIMEOUT_MS });
    await esperar(3500);

    if (/login/i.test(page.url())) {
        facebookDisponible = false;
        throw new Error('La sesión de Facebook no está autenticada.');
    }

    await page.keyboard.press('Escape').catch(() => {});
    await esperar(500);
    const abierto = await abrirCompositorFacebook(page, 20000);
    if (!abierto) throw new Error(`No se encontró el compositor para publicar en el muro de "${grupo.nombre}".`);
    await esperar(1200);

    let inputFile = await obtenerInputImagenFacebook(page, 2500);
    if (!inputFile) {
        const fotoVideo = await hacerClickPorTexto(page,
            ['foto/video', 'foto o vídeo', 'photo/video', 'photo or video', 'add photos/videos'],
            8000, 'div[role="dialog"]');
        if (!fotoVideo) throw new Error(`No se encontró "Foto/video" en el compositor de "${grupo.nombre}".`);
        await esperar(800);
        inputFile = await obtenerInputImagenFacebook(page, 12000);
    }
    if (!inputFile) throw new Error(`Facebook no mostró el selector de imagen para "${grupo.nombre}".`);
    await inputFile.uploadFile(rutaImagen);
    await esperar(2200);

    const editor = await obtenerEditorFacebook(page, 12000);
    if (!editor) throw new Error(`No se encontró el editor de texto en "${grupo.nombre}".`);
    const texto = String(publicacion.texto || '');
    await editor.evaluate(el => { el.focus(); el.scrollIntoView({ block: 'center' }); });
    if (texto.trim()) {
        await page.keyboard.down('Control');
        await page.keyboard.press('A');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
        const cdp = await page.target().createCDPSession();
        try { await cdp.send('Input.insertText', { text: texto }); }
        finally { try { await cdp.detach(); } catch (_) {} }
    }
    await esperar(900);

    // V7: nunca aceptar el disparador "Crea una publicació" como botón final.
    // Esperar a que exista un botón final exacto y esté habilitado dentro del
    // mismo diálogo que contiene el editor del contenido.
    const obtenerBotonFinalPublicar = async () => page.evaluate(() => {
        const norm = v => String(v || '').normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
        const visible = el => {
            if (!el || !el.isConnected) return false;
            const r = el.getBoundingClientRect(), s = getComputedStyle(el);
            return r.width > 15 && r.height > 15 && s.display !== 'none' &&
                s.visibility !== 'hidden' && s.opacity !== '0' &&
                r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
        };
        const dialogos = Array.from(document.querySelectorAll('div[role="dialog"], [aria-modal="true"]')).filter(visible);
        const tieneEditor = el => !!el.querySelector(
            '[contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"], textarea'
        );
        const raiz = [...dialogos].reverse().find(tieneEditor);
        if (!raiz) return { ready: false, reason: 'dialogo-con-editor-no-encontrado', dialogs: dialogos.length };
        const elementos = Array.from(raiz.querySelectorAll('button,[role="button"],input[type="submit"]')).filter(visible);
        const candidatos = elementos.map(el => {
            const aria = norm(el.getAttribute('aria-label'));
            const texto = norm(el.innerText || el.textContent || el.value);
            const exacto = /^(publica|publicar|publish|post|compartir|share|publicar ahora|share now|post now)$/.test(aria) ||
                /^(publica|publicar|publish|post|compartir|share|publicar ahora|share now|post now)$/.test(texto);
            const disabled = !!el.disabled || el.getAttribute('aria-disabled') === 'true' ||
                el.getAttribute('data-disabled') === 'true';
            return { el, aria, texto, exacto, disabled };
        }).filter(x => x.exacto);
        // aria-label exacto "Publica" tiene prioridad; nunca se aceptan labels
        // como "Crea una publicació" o "Create a public post…".
        candidatos.sort((a,b) => (a.aria === 'publica' ? 2 : 0) - (b.aria === 'publica' ? 2 : 0));
        const elegido = candidatos.find(x => !x.disabled);
        if (!elegido) return {
            ready: false,
            reason: candidatos.length ? 'boton-final-aun-deshabilitado' : 'boton-final-exacto-no-encontrado',
            dialogs: dialogos.length,
            candidates: candidatos.map(x => ({aria:x.aria, texto:x.texto, disabled:x.disabled}))
        };
        const r = elegido.el.getBoundingClientRect();
        return { ready: true, x:r.x+r.width/2, y:r.y+r.height/2, label:elegido.aria || elegido.texto, dialogs:dialogos.length };
    });

    let publicar = null;
    const limitePreparacion = Date.now() + 45000;
    let ultimoEstadoBoton = null;
    while (Date.now() < limitePreparacion) {
        publicar = await obtenerBotonFinalPublicar().catch(e => ({ ready:false, reason:e.message }));
        ultimoEstadoBoton = publicar;
        if (publicar?.ready) break;
        await esperar(1000);
    }
    if (!publicar?.ready) {
        console.warn(`[Facebook][Muro][V7] Botón final no habilitado/localizado en "${grupo.nombre}": ${JSON.stringify(ultimoEstadoBoton)}`);
        throw new Error(`El botón final "Publica" no llegó a estar habilitado en "${grupo.nombre}". No se hizo clic; revisar carga de imagen/compositor.`);
    }
    console.log(`[Facebook][Muro][V7] Botón final exacto "${publicar.label}" habilitado dentro del compositor (${publicar.dialogs} diálogo(s)). Se hará un único clic.`);
    await page.mouse.click(Math.round(publicar.x), Math.round(publicar.y));
    // Desde este punto Facebook pudo haber aceptado el post aunque falle la confirmación.
    page.__wbotFacebookPostClickRealizado = true;

    // Esperar explícitamente a que el compositor real desaparezca antes de
    // continuar al siguiente grupo. Facebook puede tardar en enviar la imagen.
    // Se identifica por el editor y/o el botón accesible "Close composer dialog",
    // no por el texto visible, que cambia según el idioma de la interfaz.
    const limite = Date.now() + 60000;
    let sondeosSinCompositor = 0;
    let confirmado = false;
    while (Date.now() < limite) {
        await esperar(1000);
        const estado = await page.evaluate(() => {
            const norm = v => String(v || '').normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '').toLowerCase()
                .replace(/\s+/g, ' ').trim();
            const visible = el => {
                if (!el) return false;
                const r = el.getBoundingClientRect(), s = getComputedStyle(el);
                return r.width > 0 && r.height > 0 &&
                    s.display !== 'none' && s.visibility !== 'hidden' &&
                    s.opacity !== '0';
            };
            const dialogos = Array.from(document.querySelectorAll(
                'div[role="dialog"], [aria-modal="true"]'
            )).filter(visible);
            const esCompositor = d => {
                const tieneEditor = !!d.querySelector(
                    '[contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"], textarea'
                );
                const tieneCierreCompositor = !!d.querySelector(
                    '[aria-label*="Close composer"], [aria-label*="Tanca el compositor"], [aria-label*="Cerrar compositor"]'
                );
                const texto = norm(d.innerText || d.textContent);
                const tieneTextoCompositor = /crear una publicacion|crea una publicacio|create a post|create post|write something|escribe algo/.test(texto);
                return tieneEditor && (tieneCierreCompositor || tieneTextoCompositor) ||
                    tieneCierreCompositor;
            };
            const compositorVisible = dialogos.some(esCompositor);
            const errores = dialogos.map(d => norm(d.innerText || d.textContent)).join(' ');
            const cuerpo = norm(document.body?.innerText || '');
            const error = /no se pudo publicar|couldn't post|something went wrong|error al publicar|no s'ha pogut publicar/.test(
                errores.slice(-2500) + ' ' + cuerpo.slice(-1200)
            );
            return { compositorVisible, error, dialogos: dialogos.length };
        }).catch(() => ({ compositorVisible: true, error: false, dialogos: -1 }));

        if (estado.error) {
            throw new Error(`Facebook mostró un error al publicar en "${grupo.nombre}".`);
        }

        if (estado.compositorVisible) {
            sondeosSinCompositor = 0;
        } else {
            // Exigir dos comprobaciones consecutivas para evitar avanzar si el
            // diálogo solo se oculta momentáneamente durante una actualización.
            sondeosSinCompositor += 1;
            if (sondeosSinCompositor >= 2) {
                confirmado = true;
                break;
            }
        }
    }
    if (!confirmado) {
        // V6: capturar evidencia del estado real antes de cerrar la pestaña.
        // No se reintenta el clic automáticamente porque podría duplicar una
        // publicación que Facebook sí haya aceptado pero cuyo diálogo siga abierto.
        let diagnostico = null;
        try {
            diagnostico = await page.evaluate(() => {
                const visible = el => {
                    if (!el) return false;
                    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
                    return r.width > 0 && r.height > 0 && s.display !== 'none' &&
                        s.visibility !== 'hidden' && s.opacity !== '0';
                };
                const norm = v => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 180);
                const dialogos = Array.from(document.querySelectorAll('div[role="dialog"], [aria-modal="true"]'))
                    .filter(visible).map((d, i) => ({
                        indice: i,
                        texto: norm(d.innerText || d.textContent),
                        editores: Array.from(d.querySelectorAll('[contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"], textarea')).filter(visible).length,
                        botones: Array.from(d.querySelectorAll('button,[role="button"],[aria-label]')).filter(visible).map(b => ({
                            texto: norm(b.innerText || b.textContent),
                            aria: b.getAttribute('aria-label'),
                            disabled: !!b.disabled || b.getAttribute('aria-disabled') === 'true',
                            testid: b.getAttribute('data-testid')
                        })).slice(-18)
                    }));
                const cuerpo = norm(document.body?.innerText).slice(-1400);
                return { url: location.href, titulo: document.title, dialogos, cuerpo };
            });
        } catch (e) {
            diagnostico = { errorDiagnostico: e.message };
        }
        console.error(`[Facebook][Muro][Diagnóstico V6] Estado tras 60 s en "${grupo.nombre}": ${JSON.stringify(diagnostico)}`);
        try {
            const nombreSeguro = String(grupo.facebook_id || grupo.nombre || 'grupo').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 70);
            const archivo = path.join(__dirname, `facebook_error_envio_${Date.now()}_${nombreSeguro}.png`);
            await page.screenshot({ path: archivo, fullPage: false });
            console.error(`[Facebook][Muro][Diagnóstico V6] Captura guardada: ${archivo}`);
        } catch (e) {
            console.warn(`[Facebook][Muro][Diagnóstico V6] No se pudo guardar captura: ${e.message}`);
        }
        throw new Error(`El formulario de publicación siguió abierto tras 60 segundos en "${grupo.nombre}". Se guardó diagnóstico V6; no se reintentó el clic para evitar duplicados. La publicación queda pendiente de verificación.`);
    }
    console.log(`[Facebook][Muro] El formulario desapareció y Facebook terminó el envío en "${grupo.nombre}".`);

    return true;
}

async function compartirPublicacionFacebookEnGrupo(
    urlPublicacion,
    grupo
) {
    if (!urlPublicacion) {
        throw new Error('No existe URL de la publicación origen.');
    }

    console.log('');
    console.log(
        `[Facebook] Compartiendo publicación origen en: ${grupo.nombre}`
    );

    const urlPublicacionCanonica =
    normalizarUrlPublicacionFacebook(urlPublicacion);

    if (!urlPublicacionCanonica) {
        throw new Error('La URL de la publicación origen no es válida.');
    }

    console.log(`[Facebook] URL canónica de origen: ${urlPublicacionCanonica}`);

    await prepararNavegacionFacebook(facebookPage);

    await facebookPage.goto(
        urlPublicacionCanonica,
        {
            waitUntil: 'domcontentloaded',
            timeout: FACEBOOK_TIMEOUT_MS
        }
    );

    await esperar(3000);

    if (/login/i.test(facebookPage.url())) {
        facebookDisponible = false;
        throw new Error('La sesión de Facebook expiró.');
    }

    await facebookPage.keyboard.press('Escape').catch(() => {});
    await esperar(500);

    const shareAbierto =
    await hacerClickPorTexto(
        facebookPage,
        [
            'compartir',
            'share'
        ],
        15000
    );

    if (!shareAbierto) {
        throw new Error(
            'No se encontró el botón "Compartir" de la publicación origen.'
        );
    }

    await esperar(1500);

    const compartirGrupo =
    await hacerClickPorTexto(
        facebookPage,
        [
            'compartir en un grupo',
            'compartir en grupo',
            'share to a group',
            'share in a group'
        ],
        10000,
        'div[role="dialog"]'
    );

    if (!compartirGrupo) {
        throw new Error(
            'Facebook no mostró la opción "Compartir en un grupo".'
        );
    }

    await esperar(1500);

    const dialogo =
    await obtenerDialogoFacebook(
        facebookPage,
        10000
    );

    const selectorRaiz =
    dialogo
    ? 'div[role="dialog"]'
    : null;

    const buscador =
    await obtenerEditorBusquedaGrupoFacebook(
        facebookPage,
        10000
    );

    if (buscador) {
        await buscador.click();
        await buscador.focus().catch(() => {});
        await facebookPage.keyboard.down('Control').catch(() => {});
        await facebookPage.keyboard.press('A').catch(() => {});
        await facebookPage.keyboard.up('Control').catch(() => {});
        await facebookPage.keyboard.type(grupo.nombre);
        await esperar(2000);
    }

    const grupoSeleccionado =
    await hacerClickPorTexto(
        facebookPage,
        [
            grupo.nombre
        ],
        10000,
        selectorRaiz
    );

    if (!grupoSeleccionado) {
        throw new Error(
            `No se encontró el grupo destino "${grupo.nombre}" en el selector de Facebook.`
        );
    }

    await esperar(1000);

    const compartirFinal =
    await hacerClickPorTexto(
        facebookPage,
        [
            'compartir',
            'share',
            'compartir ahora',
            'share now'
        ],
        15000,
        'div[role="dialog"]'
    );

    if (!compartirFinal) {
        throw new Error(
            `No se encontró el botón final para compartir en "${grupo.nombre}".`
        );
    }

    await esperar(5000);

    console.log(
        `[Facebook] Compartido correctamente en: ${grupo.nombre}`
    );

    return true;
}

async function publicarEnFacebookConReintentos(
    publicacion,
    urlOrigen,
    grupo
) {
    let ultimoError = null;

    if (!urlOrigen) {
        throw new Error(`No existe una URL de publicación origen para compartir en "${grupo.nombre}".`);
    }

    for (let intento = 1; intento <= FACEBOOK_REINTENTOS; intento++) {
        try {
            console.log('');
            console.log(`[Facebook] Grupo "${grupo.nombre}" - intento ${intento}/${FACEBOOK_REINTENTOS}`);
            console.log(`[Facebook] Reutilizando publicación origen: ${urlOrigen}`);

            const resultado = await compartirPublicacionFacebookEnGrupo(urlOrigen, grupo);
            if (resultado) return true;
        } catch (error) {
            ultimoError = error;
            console.error('');
            console.error(`[Facebook] Falló el intento ${intento} para "${grupo.nombre}":`);
            console.error(error.message);

            try {
                if (facebookPage && !facebookPage.isClosed()) {
                    await facebookPage.keyboard.press('Escape').catch(() => {});
                    await esperar(500);
                }
            } catch (_) {}

            if (intento < FACEBOOK_REINTENTOS) {
                registrarReintento();
                console.log(`[Facebook] Esperando ${FACEBOOK_ESPERA_REINTENTO_MS / 1000} segundos...`);
                await esperar(FACEBOOK_ESPERA_REINTENTO_MS);
            }
        }
    }

    throw new Error(
        `Facebook agotó ${FACEBOOK_REINTENTOS} intentos para "${grupo.nombre}". ` +
        `${ultimoError ? ultimoError.message : ''}`
    );
}

async function obtenerOCrearPublicacionOrigenFacebook(publicacion, rutaImagen, estado, gruposDestino = []) {
    const registro = obtenerRegistroEstado(estado, publicacion);

    // V97: facebookOrigenUrl significa EXCLUSIVAMENTE la Página de origen.
    // La URL real del post, si alguna vez puede obtenerse, vive en
    // facebookUrlPublicacion. Nunca se reutiliza una URL de Página como
    // si fuera el permalink de una publicación.
    registro.facebookOrigenUrl = FACEBOOK_ORIGEN_URL;

    if (registro.facebookOrigenPublicado === true) {
        console.log(`[Facebook][V97] La publicación origen ya fue confirmada para la ocurrencia ${obtenerClavePublicacion(publicacion)}.`);
        return {
            yaPublicada: true,
            publicacionConfirmada: true,
            urlPublicacion: registro.facebookUrlPublicacion || null
        };
    }

    console.log('');
    console.log(`[Facebook][V97] Creando UNICA publicación origen para ID ${publicacion.id}.`);

    const resultadoOrigen = await crearPublicacionOrigenFacebook(
        publicacion,
        rutaImagen,
        gruposDestino,
        estado
    );

    if (
        resultadoOrigen &&
        typeof resultadoOrigen === 'object' &&
        resultadoOrigen.detenidoEnPostSettings === true
    ) {
        return resultadoOrigen;
    }

    if (
        !resultadoOrigen ||
        typeof resultadoOrigen !== 'object' ||
        resultadoOrigen.publicacionConfirmada !== true
    ) {
        throw new Error('Facebook no confirmó la publicación origen en el flujo V97.');
    }

    registro.facebookOrigenUrl = FACEBOOK_ORIGEN_URL;
    registro.facebookOrigenPublicado = true;
    registro.facebookUrlPublicacion =
        typeof resultadoOrigen.urlPublicacion === 'string' && resultadoOrigen.urlPublicacion
            ? normalizarUrlPublicacionFacebook(resultadoOrigen.urlPublicacion)
            : null;
    registro.facebookAuditoriaV97 = {
        version: 'V97',
        confirmado: true,
        motivo: resultadoOrigen.motivoConfirmacionV96 || null,
        fechaConfirmacion: new Date().toISOString(),
        urlPublicacionDisponible: !!registro.facebookUrlPublicacion
    };

    estado[obtenerClavePublicacion(publicacion)] = registro;
    guardarJson(ARCHIVO_ESTADO, estado);

    console.log('[Facebook][V97] ✓ Estado de publicación origen registrado como CONFIRMADO.');
    console.log(`[Facebook][V97] URL origen (Página): ${FACEBOOK_ORIGEN_URL}`);
    console.log(`[Facebook][V97] URL publicación real: ${registro.facebookUrlPublicacion || 'no disponible'}`);

    return {
        yaPublicada: false,
        publicacionConfirmada: true,
        urlPublicacion: registro.facebookUrlPublicacion,
        motivoConfirmacionV96: resultadoOrigen.motivoConfirmacionV96 || null
    };
}

// ============================================================
// PROCESAMIENTO DE PUBLICACIONES
// ============================================================
async function iniciarEjecucionSeguro(publicacion, channel, targetKey, facebookGroupId = null) {
    try {
        return await iniciarEjecucion(
            publicacion,
            channel,
            targetKey,
            facebookGroupId
        );
    } catch (error) {
        console.warn(
            '[Laravel] No se pudo registrar el inicio de ejecución (no bloquea el intento de publicación):',
            error.message
        );
        return null;
    }
}

async function completarEjecucionSeguro(executionId, externalId = null) {
    if (!executionId) return;

    try {
        await completarEjecucion(executionId, externalId);
    } catch (error) {
        console.warn(
            '[Laravel] No se pudo registrar la ejecución exitosa #' + executionId + ':',
            error.message
        );
    }
}

async function fallarEjecucionSeguro(executionId, error) {
    if (!executionId) return;

    try {
        await fallarEjecucion(executionId, error?.message || String(error));
    } catch (reportError) {
        console.warn(
            '[Laravel] No se pudo registrar la ejecución fallida #' + executionId + ':',
            reportError.message
        );
    }
}

async function ejecutarComandoLaravel(client, grupoId, estado, comando) {
    const payload = comando?.payload || {};
    if (comando.type !== 'retry_publication') {
        throw new Error('Tipo de comando no soportado: ' + comando.type);
    }

    const occurrenceId = String(payload.occurrence_id || '');
    const channel = String(payload.channel || '');
    const targetKey = String(payload.target_key || '');
    if (!occurrenceId || !['whatsapp', 'facebook'].includes(channel) || !targetKey) {
        throw new Error('Comando de reintento inválido: faltan occurrence_id, channel o target_key.');
    }

    let publicacionActual = publicacionesCache.find(item => String(item.ocurrencia_id) === occurrenceId);
    if (!publicacionActual) {
        await actualizarPublicaciones();
        publicacionActual = publicacionesCache.find(item => String(item.ocurrencia_id) === occurrenceId);
        if (!publicacionActual) {
            throw new Error('La ocurrencia solicitada no está disponible en Laravel: ' + occurrenceId);
        }
    }

    // Validar el destino contra los grupos asociados a la publicación en Laravel
    // ANTES de tocar el estado local.
    let grupoLocal = null;
    if (channel === 'facebook') {
        const gruposSeleccionados = obtenerGruposFacebookPublicacion(publicacionActual);
        grupoLocal = gruposSeleccionados.find(grupo =>
            String(grupo.facebook_id || '') === targetKey ||
            obtenerClaveFacebookGrupo(grupo) === targetKey
        );
        if (!grupoLocal) {
            throw new Error(`El destino Facebook "${targetKey}" no está seleccionado en la publicación de Laravel; no se modificó el estado ni se publicó.`);
        }
        if (!FACEBOOK_ENABLED || !facebookDisponible) {
            throw new Error('Facebook no está disponible para ejecutar el reintento.');
        }
    }

    const registro = obtenerRegistroEstado(estado, publicacionActual);
    if (channel === 'whatsapp') {
        registro.whatsapp = false;
        registro.enviada = false;
        guardarJson(ARCHIVO_ESTADO, estado);
        await procesarPublicaciones(client, grupoId, estado, { occurrenceId, channel, targetKey });
    } else {
        const claveGrupo = obtenerClaveFacebookGrupo(grupoLocal);
        registro.facebookGrupos[claveGrupo] = false;
        registro.facebook = false;
        registro.enviada = false;
        guardarJson(ARCHIVO_ESTADO, estado);
        await procesarPublicaciones(client, grupoId, estado, { occurrenceId, channel, targetKey });
    }

    const actualizado = obtenerRegistroEstado(estado, publicacionActual);
    const exitoso = channel === 'whatsapp'
        ? actualizado.whatsapp === true
        : actualizado.facebookGrupos?.[obtenerClaveFacebookGrupo(grupoLocal)] === true;
    if (!exitoso) {
        throw new Error('WBot terminó el procesamiento sin confirmar el reintento de ' + channel + ' para ' + occurrenceId + '.');
    }
    return { occurrence_id: occurrenceId, channel, target_key: targetKey, success: true };
}

async function revisarComandosLaravel(client, grupoId, estado) {
    try {
        const respuesta = await reclamarComando();
        const comando = respuesta?.data;

        if (!comando) {
            return false;
        }

        console.log(
            '[Laravel] Comando reclamado #' + comando.id +
            ' (' + comando.type + ')'
        );

        let resultado;
        try {
            resultado = await ejecutarComandoLaravel(client, grupoId, estado, comando);
        } catch (error) {
            // Si el clic final pudo haberse realizado, no reencolar a ciegas.
            const retry = error?.outcomeUncertain !== true;
            try {
                await fallarComando(comando.id, error.message, retry);
            } catch (reportError) {
                console.error(`[Laravel] No se pudo reportar el fallo del comando #${comando.id}: ${reportError.message}`);
            }
            console.error('[Laravel] Comando #' + comando.id + ' falló:', error.message);
            return true;
        }

        try {
            await completarComando(comando.id, resultado);
            console.log('[Laravel] Comando #' + comando.id + ' completado.');
        } catch (ackError) {
            // La publicación ya fue confirmada. No llamar fallarComando: podría provocar duplicados.
            console.error(`[Laravel] La publicación del comando #${comando.id} terminó, pero no se pudo confirmar el comando: ${ackError.message}. No se republicará automáticamente.`);
        }

        return true;
    } catch (error) {
        console.error('[Laravel] Error consultando comandos:', error.message);
        return false;
    }
}


async function procesarPublicaciones(
    client,
    grupoId,
    estado,
    forcedExecution = null
) {

    try {

        const fechaActual =
        obtenerFechaActual();

        const horaActual =
        obtenerHoraActual();

        if (
            !fechaActual ||
            !horaActual
        ) {

            console.log(
                `[${horaActual || '--:--'}] ` +
                `No se pudo obtener fecha/hora actual.`
            );

            return;
        }

        const ahoraClave =
        `${fechaActual} ${horaActual}`;

        // ----------------------------------------------------
        // PUBLICACIONES PENDIENTES
        // ----------------------------------------------------

        const publicacionesPendientes =
        publicacionesCache
        .filter(
            publicacion => {

                if (!publicacion) {
                    return false;
                }

                const isForced = !!forcedExecution && String(forcedExecution.occurrenceId) === String(publicacion.ocurrencia_id);

                if (!isForced && publicacion.fecha !== fechaActual) {
                    return false;
                }

                const fechaHoraPublicacion =
                `${publicacion.fecha} ` +
                `${publicacion.hora}`;

                if (!isForced && fechaHoraPublicacion > ahoraClave) {
                    return false;
                }

                // Un reintento explícito debe procesarse aunque el agregado de estado
                // de Laravel indique que todos sus destinos ya fueron completados.
                if (isForced) return true;

                /*
                 * Una publicación sigue pendiente mientras
                 * exista al menos un destino habilitado que
                 * todavía no haya sido completado.
                 */

                const whatsappPendiente =
                requiereDestino(publicacion, 'whatsapp') &&
                !destinoFueEnviado(
                    estado,
                    publicacion,
                    'whatsapp'
                );

                const facebookPendiente =
                requiereDestino(publicacion, 'facebook') &&
                !facebookPublicacionFueEnviada(
                    estado,
                    publicacion
                );

                return (
                    whatsappPendiente ||
                    facebookPendiente
                );
            }
        )
        .sort(
            (a, b) => {

                const fechaHoraA =
                `${a.fecha} ${a.hora}`;

                const fechaHoraB =
                `${b.fecha} ${b.hora}`;

                return fechaHoraA.localeCompare(
                    fechaHoraB
                );
            }
        );

        if (
            publicacionesPendientes.length === 0
        ) {

            const publicacionesDeHoy =
            publicacionesCache
            .filter(
                publicacion =>
                publicacion &&
                publicacion.fecha ===
                fechaActual
            )
            .sort(
                (a, b) =>
                `${a.hora}`.localeCompare(
                    `${b.hora}`
                )
            );

            const siguiente =
            publicacionesDeHoy.find(
                publicacion => {

                    const whatsappPendiente =
                    requiereDestino(publicacion, 'whatsapp') &&
                    (!forcedExecution || forcedExecution.channel === 'whatsapp') &&
                    !destinoFueEnviado(
                        estado,
                        publicacion,
                        'whatsapp'
                    );

                    const facebookPendiente =
                    requiereDestino(publicacion, 'facebook') &&
                    (!forcedExecution || forcedExecution.channel === 'facebook') &&
                    !facebookPublicacionFueEnviada(
                        estado,
                        publicacion
                    );

                    return (
                        (
                            whatsappPendiente ||
                            facebookPendiente
                        ) &&
                        `${publicacion.fecha} ` +
                        `${publicacion.hora}` >
                        ahoraClave
                    );
                }
            );

            if (siguiente) {
                actualizarEstadoHeartbeat({
                    nextPublication: siguiente,
                });

                console.log(
                    `[${horaActual}] ` +
                    `No hay publicaciones pendientes. ` +
                    `Próxima: ID ${siguiente.id} ` +
                    `a las ${siguiente.hora}.`
                );

            } else {
                actualizarEstadoHeartbeat({
                    nextPublication: null,
                });

                console.log(
                    `[${horaActual}] ` +
                    `No hay publicaciones programadas ` +
                    `pendientes para hoy.`
                );
            }

            return;
        }

        console.log('');
        console.log(
            '='.repeat(70)
        );

        actualizarEstadoHeartbeat({
            nextPublication: publicacionesPendientes[0] || null,
        });
        console.log(
            `[${horaActual}] ` +
            `PUBLICACIONES PENDIENTES: ` +
            `${publicacionesPendientes.length}`
        );

        console.log(
            '='.repeat(70)
        );

        // ----------------------------------------------------
        // PROCESAR CADA PUBLICACIÓN
        // ----------------------------------------------------

        for (
            const publicacion
            of publicacionesPendientes
        ) {

            try {

                console.log('');
                console.log(
                    '-'.repeat(70)
                );

                console.log(
                    'PUBLICACIÓN PROGRAMADA / PENDIENTE'
                );

                console.log(
                    `ID: ${publicacion.id}`
                );

                console.log(
                    `Ocurrencia: ${publicacion.ocurrencia_id}`
                );

                console.log(
                    `Fecha: ${publicacion.fecha}`
                );

                console.log(
                    `Hora programada: ${publicacion.hora}`
                );

                console.log(
                    '-'.repeat(70)
                );

                /*
                 * Descargamos una sola vez la imagen.
                 */

                const rutaImagen =
                await descargarImagenDesdeLaravel(
                    publicacion
                );

                // ------------------------------------------------
                // WHATSAPP
                // ------------------------------------------------

                if (
                    requiereDestino(publicacion, 'whatsapp') &&
                    (!forcedExecution || forcedExecution.channel === 'whatsapp') &&
                    !destinoFueEnviado(
                        estado,
                        publicacion,
                        'whatsapp'
                    )
                ) {

                    let executionIdWhatsApp = null;

                    try {

                        console.log(
                            'Procesando destino: WHATSAPP'
                        );

                        const targetKeyWhatsApp = NOMBRE_GRUPO;
                        const ejecucionWhatsApp = await iniciarEjecucionSeguro(
                            publicacion,
                            'whatsapp',
                            targetKeyWhatsApp
                        );

                        if (ejecucionWhatsApp?.data?.status === 'succeeded') {
                            marcarDestinoComoEnviado(
                                estado,
                                publicacion,
                                'whatsapp'
                            );

                            console.log(
                                'WHATSAPP: Laravel ya registra esta ejecución como exitosa; se omite el envío duplicado.'
                            );

                            continue;
                        }

                        executionIdWhatsApp = ejecucionWhatsApp?.data?.id || null;

                        const resultadoWhatsApp =
                        await enviarImagenWhatsApp(
                            client,
                            grupoId,
                            publicacion,
                            rutaImagen
                        );

                        if (
                            resultadoWhatsApp
                        ) {

                            marcarDestinoComoEnviado(
                                estado,
                                publicacion,
                                'whatsapp'
                            );

                            console.log(
                                `WHATSAPP: ID ${publicacion.id} ` +
                                `registrada como enviada.`
                            );

                            await completarEjecucionSeguro(
                                executionIdWhatsApp,
                                null
                            );
                        }

                    } catch (error) {
                        await fallarEjecucionSeguro(
                            executionIdWhatsApp,
                            error
                        );
                        registrarPublicacionFallida(
                            publicacion,
                            'whatsapp',
                            error
                        );

                        console.error('');
                        console.error(
                            `ERROR WHATSAPP - ID ${publicacion.id}:`
                        );

                        console.error(
                            error.message
                        );

                        /*
                         * NO detenemos Facebook.
                         * Se intentará nuevamente en el siguiente ciclo.
                         */
                    }

                } else if (requiereDestino(publicacion, 'whatsapp')) {

                    console.log(
                        'WHATSAPP: ya enviada. Se omite.'
                    );
                } else {

                    console.log(
                        'WHATSAPP: no es un destino de esta publicación.'
                    );
                }

                // ------------------------------------------------
                // FACEBOOK
                // ------------------------------------------------

                if (requiereDestino(publicacion, 'facebook') && (!forcedExecution || forcedExecution.channel === 'facebook')) {

                    // Cada publicación solo se envía a los grupos seleccionados en Laravel.
                    const gruposFacebook = obtenerGruposFacebookPublicacion(publicacion);

                    if (!FACEBOOK_ENABLED || !facebookDisponible) {

                        console.warn(
                            `[Facebook] ID ${publicacion.id} requiere Facebook, ` +
                            `pero no está disponible. Se reintentará en el próximo ciclo.`
                        );

                    } else if (gruposFacebook.length === 0) {

                        console.warn(
                            `[Facebook] ID ${publicacion.id} no tiene grupos de Facebook seleccionados en Laravel.`
                        );

                    } else {

                        let gruposPendientes = gruposFacebook.filter(
                            grupoFacebook =>
                                (!forcedExecution ||
                                    String(grupoFacebook.facebook_id) === String(forcedExecution.targetKey) ||
                                    obtenerClaveFacebookGrupo(grupoFacebook) === String(forcedExecution.targetKey)) &&
                                !facebookGrupoFueEnviado(
                                    estado,
                                    publicacion,
                                    grupoFacebook
                                )
                        );

                        if (gruposPendientes.length === 0) {
                            console.log(
                                `[Facebook] Todos los grupos de ID ${publicacion.id} ya fueron procesados.`
                            );
                            continue;
                        }

                        // Encolar cada grupo en una cola global con concurrencia limitada.
                        // tareas simultáneas. Cada tarea obtiene su propia pestaña para
                        // que la navegación y el compositor no interfieran entre grupos.
                        const promesasTrabajosFacebook = [];
                        for (const grupoFacebook of gruposPendientes) {
                            const claveTrabajo = `${publicacion.ocurrencia_id || publicacion.id}:${obtenerClaveFacebookGrupo(grupoFacebook)}`;
                            const promesaTrabajo = encolarTrabajoFacebook(claveTrabajo, async (pageTrabajo) => {
                                let executionIdFacebook = null;
                                let clicPublicarRealizado = false;
                                try {
                                    console.log(`[Laravel][Facebook][IDs] grupo="${grupoFacebook.nombre}" idRegistro=${grupoFacebook.id ?? 'null'} facebook_id=${grupoFacebook.facebook_id ?? 'null'} targetKey=${String(grupoFacebook.facebook_id ?? '')}`);
                                    const ejecucionFacebook = await iniciarEjecucionSeguro(
                                        publicacion, 'facebook', String(grupoFacebook.facebook_id), grupoFacebook.id ?? null
                                    );
                                    if (ejecucionFacebook?.data?.status === 'succeeded') {
                                        marcarFacebookGrupoComoEnviado(estado, publicacion, grupoFacebook);
                                        return { success: true, targetKey: obtenerClaveFacebookGrupo(grupoFacebook), alreadySucceeded: true };
                                    }
                                    executionIdFacebook = ejecucionFacebook?.data?.id || null;
                                    // La función solo retorna cuando confirma que Facebook aceptó la publicación.
                                    await publicarDirectamenteEnMuroGrupoFacebook(publicacion, rutaImagen, grupoFacebook, pageTrabajo);
                                    marcarFacebookGrupoComoEnviado(estado, publicacion, grupoFacebook);
                                    await completarEjecucionSeguro(executionIdFacebook, null);
                                    console.log(`[Facebook][Muro] ✓ Publicación confirmada: ${grupoFacebook.nombre}`);
                                    return { success: true, targetKey: obtenerClaveFacebookGrupo(grupoFacebook) };
                                } catch (error) {
                                    if (pageTrabajo?.__wbotFacebookPostClickRealizado) {
                                        error.outcomeUncertain = true;
                                        error.message = 'Resultado incierto: se hizo clic en Publicar, pero no se pudo confirmar el resultado en Facebook. ' + error.message;
                                    }
                                    await fallarEjecucionSeguro(executionIdFacebook, error);
                                    registrarPublicacionFallida(publicacion, 'facebook', error);
                                    console.error(`[Facebook][Muro] Falló "${grupoFacebook.nombre}": ${error.message}`);
                                    await cerrarCompositoresFacebook(pageTrabajo, `fallo en ${grupoFacebook.nombre}`).catch(() => {});
                                    throw error;
                                }
                            });
                            if (forcedExecution && forcedExecution.channel === 'facebook') {
                                promesasTrabajosFacebook.push(promesaTrabajo);
                            }
                        }
                        if (forcedExecution && forcedExecution.channel === 'facebook') {
                            const resultados = await Promise.all(promesasTrabajosFacebook);
                            if (!resultados.some(resultado => resultado?.success && resultado.targetKey === String(forcedExecution.targetKey))) {
                                throw new Error(`La cola no confirmó el trabajo Facebook para ${forcedExecution.targetKey}.`);
                            }
                        }
                        continue;

                        const registroFacebook = obtenerRegistroEstado(
                            estado,
                            publicacion
                        );

                        let urlOrigenFacebook = registroFacebook.facebookUrlPublicacion || '';
                        const facebookExecutionIds = new Map();

                        // V97: facebookOrigenUrl es la Página de origen, no el permalink.
                        registroFacebook.facebookOrigenUrl = FACEBOOK_ORIGEN_URL;

                        // La publicación puede haber sido aceptada por Facebook
                        // aunque no haya sido posible extraer su URL. En ese
                        // caso NUNCA volvemos a abrir el compositor: hacerlo
                        // produciría una publicación duplicada.
                        if (registroFacebook.facebookOrigenPublicado === true) {
                            if (gruposPendientes.length > 0) {
                                console.log('[Facebook][V97] La publicación origen ya fue confirmada. No se volverá a crear.');
                                console.log('[Facebook][V97] Los grupos seleccionados en la publicación confirmada se consideran procesados.');

                                for (const grupoFacebook of gruposPendientes) {
                                    marcarFacebookGrupoComoEnviado(estado, publicacion, grupoFacebook);
                                    console.log(`FACEBOOK: ID ${publicacion.id} -> estado confirmado para "${grupoFacebook.nombre}".`);
                                }
                            }
                            continue;
                        }

                        // ----------------------------------------------------
                        // V96: ELIMINADO EL BLOQUEO DE REFINAMIENTO
                        // ----------------------------------------------------
                        // Post settings es ahora una etapa normal del flujo.
                        // La publicación solo se detiene si Facebook devuelve
                        // un error real o si la confirmación V96/V96 falla.
                        if (facebookFlujoPausadoEnPostSettings) {
                            console.log('[Facebook][V96] Estado de refinamiento heredado ignorado; continuando flujo operativo.');
                            facebookFlujoPausadoEnPostSettings = false;
                        }

                        // ----------------------------------------------------
                        // PRIMERA PUBLICACIÓN:
                        // Facebook permite seleccionar los grupos dentro de
                        // "Post settings" antes de pulsar "Publica". Usamos
                        // ese flujo para crear el post de la Página y
                        // compartirlo simultáneamente en los grupos.
                        // ----------------------------------------------------
                        if (!urlOrigenFacebook) {
                            try {
                                const gruposConEjecucion = [];

                                for (const grupoFacebook of gruposPendientes) {
                                    const ejecucionFacebook = await iniciarEjecucionSeguro(
                                        publicacion,
                                        'facebook',
                                        String(grupoFacebook.facebook_id),
                                        grupoFacebook.id
                                    );

                                    if (ejecucionFacebook?.data?.status === 'succeeded') {
                                        marcarFacebookGrupoComoEnviado(
                                            estado,
                                            publicacion,
                                            grupoFacebook
                                        );
                                        continue;
                                    }

                                    facebookExecutionIds.set(
                                        obtenerClaveFacebookGrupo(grupoFacebook),
                                        ejecucionFacebook?.data?.id || null
                                    );
                                    gruposConEjecucion.push(grupoFacebook);
                                }

                                gruposPendientes = gruposConEjecucion;

                                if (gruposPendientes.length === 0) {
                                    continue;
                                }

                                console.log(
                                    `[Facebook] Creando publicación origen y compartiendo directamente en ${gruposPendientes.length} grupo(s).`
                                );

                                const resultadoOrigen = await obtenerOCrearPublicacionOrigenFacebook(
                                    publicacion,
                                    rutaImagen,
                                    estado,
                                    gruposPendientes
                                );

                                // PUNTO DE CONTROL:
                                // la publicación todavía NO existe en Facebook.
                                // No marcar grupos, no guardar URL y no continuar
                                // con ningún paso posterior.
                                if (
                                    resultadoOrigen &&
                                    typeof resultadoOrigen === 'object' &&
                                    resultadoOrigen.detenidoEnPostSettings === true
                                ) {
                                    console.log(
                                        `[Facebook] ID ${publicacion.id}: ejecución detenida en Post settings ` +
                                        `después de seleccionar ${resultadoOrigen.gruposSeleccionados} grupo(s).`
                                    );
                                    console.log(
                                        '[Facebook] La publicación permanece pendiente y el compositor queda abierto para refinamiento.'
                                    );
                                    return;
                                }

                                if (!resultadoOrigen || resultadoOrigen.publicacionConfirmada !== true) {
                                    throw new Error('Facebook no devolvió una confirmación válida de la publicación origen.');
                                }

                                urlOrigenFacebook = resultadoOrigen.urlPublicacion || '';

                                // V97: la publicación ya fue confirmada dentro del
                                // compositor con todos los grupos pendientes seleccionados.
                                // Registramos cada grupo sin crear un segundo post.
                                for (const grupoFacebook of gruposPendientes) {
                                    marcarFacebookGrupoComoEnviado(
                                        estado,
                                        publicacion,
                                        grupoFacebook
                                    );

                                    await completarEjecucionSeguro(
                                        facebookExecutionIds.get(
                                            obtenerClaveFacebookGrupo(grupoFacebook)
                                        ),
                                        resultadoOrigen.urlPublicacion || null
                                    );

                                    console.log(
                                        `FACEBOOK: ID ${publicacion.id} compartida en "${grupoFacebook.nombre}" y registrada como enviada.`
                                    );
                                }

                                continue;

                            } catch (error) {
                                for (const executionId of facebookExecutionIds.values()) {
                                    await fallarEjecucionSeguro(executionId, error);
                                }

                                registrarPublicacionFallida(
                                    publicacion,
                                    'facebook',
                                    error
                                );
                                console.error('');
                                console.error(
                                    `ERROR FACEBOOK - ID ${publicacion.id}: no se pudo crear/publicar en el flujo de grupos.`
                                );
                                console.error(error.message);

                                // No dejar el compositor abierto. Si Facebook
                                // queda con un diálogo pendiente, la siguiente
                                // ocurrencia puede reutilizarlo y terminar
                                // escribiendo sobre una publicación anterior.
                                await cerrarCompositoresFacebook(
                                    facebookPage,
                                    `fallo de publicación ID ${publicacion.id}`
                                );

                                continue;
                            }
                        }

                        // ----------------------------------------------------
                        // PUBLICACIÓN ORIGEN YA EXISTE:
                        // Si quedaron grupos pendientes de una ejecución
                        // anterior, conservamos el mecanismo de compartir
                        // individualmente como respaldo, sin crear otro post
                        // de origen.
                        // ----------------------------------------------------
                        for (const grupoFacebook of gruposPendientes) {
                            let executionIdFacebook = null;

                            try {
                                console.log(
                                    `Procesando destino pendiente: FACEBOOK -> ${grupoFacebook.nombre}`
                                );

                                const ejecucionFacebook = await iniciarEjecucionSeguro(
                                    publicacion,
                                    'facebook',
                                    String(grupoFacebook.facebook_id),
                                    grupoFacebook.id
                                );

                                if (ejecucionFacebook?.data?.status === 'succeeded') {
                                    marcarFacebookGrupoComoEnviado(
                                        estado,
                                        publicacion,
                                        grupoFacebook
                                    );
                                    continue;
                                }

                                executionIdFacebook = ejecucionFacebook?.data?.id || null;

                                const resultadoFacebook =
                                await publicarEnFacebookConReintentos(
                                    publicacion,
                                    urlOrigenFacebook,
                                    grupoFacebook
                                );

                                if (resultadoFacebook) {
                                    marcarFacebookGrupoComoEnviado(
                                        estado,
                                        publicacion,
                                        grupoFacebook
                                    );

                                    await completarEjecucionSeguro(
                                        executionIdFacebook,
                                        null
                                    );

                                    console.log(
                                        `FACEBOOK: ID ${publicacion.id} compartida en "${grupoFacebook.nombre}" y registrada como enviada.`
                                    );
                                }

                            } catch (error) {
                                await fallarEjecucionSeguro(
                                    executionIdFacebook,
                                    error
                                );

                                registrarPublicacionFallida(
                                    publicacion,
                                    'facebook',
                                    error
                                );
                                console.error('');
                                console.error(
                                    `ERROR FACEBOOK - ID ${publicacion.id} GRUPO "${grupoFacebook.nombre}":`
                                );
                                console.error(error.message);
                            }
                        }
                    }
                }

            } catch (error) {
                registrarPublicacionFallida(
                    publicacion,
                    'bot',
                    error
                );

                console.error('');
                console.error(
                    `ERROR PROCESANDO PUBLICACIÓN ` +
                    `ID ${publicacion.id}:`
                );

                console.error(
                    error.message
                );

                console.error(
                    error.stack
                );
            }
        }

        console.log('');
        console.log(
            '='.repeat(70)
        );

        console.log(
            'FIN DE PROCESAMIENTO'
        );

        console.log(
            '='.repeat(70)
        );

        console.log('');

    } catch (error) {

        console.error('');
        console.error(
            'ERROR GENERAL EN procesarPublicaciones():'
        );

        console.error(
            error.message
        );

        console.error(
            error.stack
        );
        // En un reintento forzado el llamador debe recibir el resultado real de la cola.
        if (forcedExecution) throw error;
    }
}

// ============================================================
// CERRAR NAVEGADOR PRINCIPAL COMPARTIDO
// ============================================================

async function cerrarNavegadorPrincipal() {

    if (!navegadorPrincipal) {
        return;
    }

    try {
        await navegadorPrincipal.close();
    } catch (error) {
        console.error(
            '[Chromium] Error cerrando navegador compartido:',
            error.message
        );
    }

    navegadorPrincipal = null;
    whatsappBrowser = null;
    whatsappPage = null;
    facebookBrowser = null;
    facebookPage = null;
}

// ============================================================
// CERRAR WHATSAPP
// ============================================================

async function cerrarWhatsApp() {

    if (whatsappClient) {
        try {
            if (typeof whatsappClient.close === 'function') {
                await whatsappClient.close();
            }
        } catch (error) {
            console.error(
                '[WhatsApp] Error cerrando cliente:',
                error.message
            );
        }
    }

    whatsappClient = null;

    // El navegador se comparte con Facebook y se cierra una sola vez.
    whatsappBrowser = null;
    whatsappPage = null;
}

// ============================================================
// CERRAR FACEBOOK
// ============================================================

async function cerrarFacebook() {
    detenerSincronizacionPeriodicaGruposFacebook();
    if (facebookSyncPage) {
        try { await facebookSyncPage.close(); } catch (_) {}
        facebookSyncPage = null;
    }

    // Facebook comparte el navegador principal con WhatsApp.
    // No se cierra el navegador aquí; se cierra una sola vez al finalizar el bot.
    facebookPage = null;
    facebookBrowser = null;
}

// ============================================================
// INICIO
// ============================================================

async function iniciar() {

    crearCarpetas();
    adquirirBloqueoWhatsApp();

    validarConfiguracion();

    console.log('');
    console.log(
        '='.repeat(70)
    );

    console.log(
        'BOT DE VENTAS MAYORISTA - NODE.JS'
    );

    console.log(
        '='.repeat(70)
    );

    console.log('');

    console.log(
        'Fuente de publicaciones: Laravel API'
    );

    console.log(
        `API: ${LARAVEL_API_URL}/api/bot/publicaciones`
    );

    console.log(
        `Grupo WhatsApp: ${NOMBRE_GRUPO}`
    );

    if (FACEBOOK_ENABLED) {

        console.log(
            `Facebook origen: ${FACEBOOK_ORIGEN_URL}`
        );

        console.log(
            `Facebook grupos destino: seleccionados desde Laravel/Filament`
        );
    }

    console.log('');

    // ========================================================
    // WHATSAPP
    // ========================================================

    console.log(
        'Iniciando WPPConnect...'
    );

    console.log(
        `Sesión: ${CARPETA_SESION}`
    );

    // --------------------------------------------------------
    // Si existe la sesión antigua de Facebook, la extraemos antes
    // de abrir el navegador compartido. El perfil de WhatsApp se
    // respalda primero y nunca se sobrescribe con archivos de Facebook.
    // --------------------------------------------------------
    let datosMigracionFacebook = null;

    if (FACEBOOK_ENABLED) {
        datosMigracionFacebook = await prepararMigracionFacebook();
        datosMigracionFacebookPendientes = datosMigracionFacebook;
    }

    // --------------------------------------------------------
    // Igual que Facebook: el navegador lo crea el propio bot y
    // WPPConnect recibe la página existente. Así evitamos que
    // WPPConnect lance otro Chromium/pestaña por su cuenta.
    // --------------------------------------------------------
    if (!navegadorPrincipal) {
        navegadorPrincipal =
        await puppeteer.launch({
            //executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            headless: false,
            userDataDir: CARPETA_PERFIL_COMUN,
            defaultViewport: {
                width: 1366,
                height: 900
            },
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-background-networking',
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
                '--disable-notifications',
                '--disable-popup-blocking'
            ]
        });
    }

    whatsappBrowser = navegadorPrincipal;

    const paginasWhatsApp =
    await whatsappBrowser.pages();

    whatsappPage =
    paginasWhatsApp[0] ||
    await whatsappBrowser.newPage();

    whatsappPage.setDefaultTimeout(120000);

    console.log(
        `[WhatsApp] Navegador principal iniciado; usando la pestaña ${paginasWhatsApp.length > 0 ? 'existente' : 'creada'}.`
    );

    const client =
    await wppconnect.create({

        session: 'whatsapp-bot',

        page: whatsappPage,

        catchQR: (
            base64Qr,
            asciiQR
        ) => {

            console.log('');

            console.log(
                '========================================'
            );

            console.log(
                'ESCANEA EL CÓDIGO QR'
            );

            console.log(
                '========================================'
            );

            console.log(
                asciiQR
            );

            console.log('');
        },

        statusFind: (
            statusSession,
            session
        ) => {

            console.log(
                `[WPPConnect] ` +
                `Estado: ${statusSession} ` +
                `Sesión: ${session}`
            );

            const estadoWpp = String(statusSession || '').toLowerCase();

            if (
                ['islogged', 'inchat', 'qrreadsuccess'].includes(estadoWpp)
            ) {
                actualizarEstadoHeartbeat({
                    whatsapp: 'connected',
                    status: 'online',
                    message: 'WhatsApp conectado',
                });
            } else if (
                [
                    'desconnectedmobile',
                    'browserclose',
                    'device_not_connected',
                    'devicenotconnected',
                    'serverwssnotconnected',
                    'delete_token',
                    'deletetoken',
                ].includes(estadoWpp)
            ) {
                actualizarEstadoHeartbeat({
                    whatsapp: 'disconnected',
                    status: 'error',
                    message: 'WhatsApp desconectado: ' + statusSession,
                    lastError: 'WhatsApp desconectado: ' + statusSession,
                    lastErrorAt: new Date().toISOString(),
                });
            }
        },

        disableWelcome: true,

        autoClose: 0,

        whatsappVersion:
        '2.3000.1049101571-alpha',

        tokenStore: 'file',

        folderNameToken:
        CARPETA_SESION
    });

    whatsappClient = client;

    actualizarEstadoHeartbeat({
        whatsapp: 'connected',
        status: 'online',
        message: 'WhatsApp conectado correctamente',
    });

    iniciarHeartbeat('online');

    // ========================================================
    // LARAVEL
    // ========================================================

    await actualizarPublicaciones();

    // ========================================================
    // ESTADO
    // ========================================================

    const estado =
    cargarJson(
        ARCHIVO_ESTADO,
        {}
    );

    console.log('');

    console.log(
        `Estado de publicaciones cargado: ` +
        `${Object.keys(estado).length} registros.`
    );

    // V97: auditar y normalizar sin borrar publicaciones_enviadas.json.
    auditarEstadoV97(estado);

    // ========================================================
    // FACEBOOK
    // ========================================================

    if (
        FACEBOOK_ENABLED
    ) {

        try {
            await iniciarFacebook();

            actualizarEstadoHeartbeat({
                facebook: 'connected',
                status: 'online',
                message: 'WhatsApp y Facebook conectados',
            });

            try {
                await sincronizarGruposFacebook();
                iniciarSincronizacionPeriodicaGruposFacebook();
            } catch (error) {
            actualizarEstadoHeartbeat({
                facebook: 'error',
                status: 'error',
                message: 'Facebook no disponible: ' + error.message,
                lastError: 'Facebook: ' + error.message,
                lastErrorAt: new Date().toISOString(),
            });
                console.error('[Facebook] Error durante la sincronización inicial de grupos:', error.message);
            }
        } catch (error) {
            facebookDisponible = false;

            console.error('');
            console.error(
                '[Facebook] No se pudo iniciar Facebook.'
            );
            console.error(error.message);
            console.error(
                '[Facebook] WhatsApp continuará funcionando normalmente.'
            );
        }
    }

    // ========================================================
    // VALIDACIÓN INICIAL
    // ========================================================

    if (
        publicacionesCache.length === 0
    ) {

        console.warn('');

        console.warn(
            'ADVERTENCIA: Laravel no devolvió publicaciones.'
        );

        console.warn(
            'El bot continuará ejecutándose y volverá a intentar.'
        );
    }

    // ========================================================
    // BUSCAR GRUPO WHATSAPP
    // ========================================================

    const grupoId =
    await buscarGrupo(
        client
    );

    actualizarEstadoHeartbeat({
        whatsapp: 'connected',
        facebook: facebookDisponible
            ? 'connected'
            : (FACEBOOK_ENABLED ? 'error' : 'disabled'),
        status:
            facebookDisponible || !FACEBOOK_ENABLED
                ? 'online'
                : 'error',
        message:
            facebookDisponible
                ? 'WhatsApp y Facebook conectados'
                : (!FACEBOOK_ENABLED
                    ? 'WhatsApp conectado; Facebook desactivado'
                    : 'WhatsApp conectado; Facebook no disponible'),
    });

    // ========================================================
    // BOT LISTO
    // ========================================================

    console.log('');

    console.log(
        '=========================================='
    );

    console.log(
        'BOT LISTO'
    );

    console.log(
        '=========================================='
    );

    console.log(
        `WhatsApp: ${NOMBRE_GRUPO}`
    );

    console.log(
        `ID:       ${grupoId}`
    );

    console.log(
        `Facebook: ${
            facebookDisponible
            ? `grupos seleccionados desde Laravel/Filament`
            : 'no disponible'
        }`
    );

    console.log(
        `Publicaciones cargadas: ` +
        `${publicacionesCache.length}`
    );

    console.log('');

    console.log(
        'El bot revisará la programación cada minuto.'
    );

    console.log(
        `Laravel se actualizará cada ` +
        `${INTERVALO_ACTUALIZACION_API / 1000} segundos.`
    );

    console.log('');

    // ========================================================
    // BUCLE PRINCIPAL
    // ========================================================

    let ultimaRevision =
    null;

    let ultimaActualizacion =
    Date.now();

    while (true) {

        try {

            const ahora =
            Date.now();

            // ------------------------------------------------
            // ACTUALIZAR LARAVEL
            // ------------------------------------------------

            if (
                ahora - ultimaActualizacion >=
                INTERVALO_ACTUALIZACION_API
            ) {

                ultimaActualizacion =
                ahora;

                await actualizarPublicaciones();
            }

            // ------------------------------------------------
            // REVISAR PUBLICACIONES
            // ------------------------------------------------

            const hora =
            obtenerHoraActual();

            if (
                hora !== ultimaRevision
            ) {

                ultimaRevision =
                hora;

                await revisarComandosLaravel(client, grupoId, estado);

                await procesarPublicaciones(
                    client,
                    grupoId,
                    estado
                );
            }

        } catch (error) {
            actualizarEstadoHeartbeat({
                status: 'error',
                message: 'Error en el ciclo principal: ' + error.message,
                lastError: error.message,
                lastErrorAt: new Date().toISOString(),
            });

            console.error('');

            console.error(
                'ERROR EN EL CICLO PRINCIPAL:'
            );

            console.error(
                error.message
            );

            console.error(
                'El bot continuará ejecutándose.'
            );
        }

        await esperar(1000);
    }
}

// ============================================================
// MANEJO DE ERRORES
// ============================================================

process.on(
    'unhandledRejection',
    error => {

        actualizarEstadoHeartbeat({
            status: 'error',
            message: 'Unhandled rejection',
            lastError: error?.message || String(error),
            lastErrorAt: new Date().toISOString(),
        });

        void enviarHeartbeat('error');

        console.error('');
        console.error(
            'UNHANDLED REJECTION:'
        );

        console.error(error);
    }
);

process.on(
    'uncaughtException',
    error => {

        actualizarEstadoHeartbeat({
            status: 'error',
            message: 'Uncaught exception',
            lastError: error?.message || String(error),
            lastErrorAt: new Date().toISOString(),
        });

        void enviarHeartbeat('error');

        console.error('');
        console.error(
            'UNCAUGHT EXCEPTION:'
        );

        console.error(
            'Esto normalmente indica un error no controlado.'
        );

        console.error(error);
    }
);

// ============================================================
// CIERRE LIMPIO
// ============================================================

async function cerrarBot() {

    console.log('');
    console.log(
        'Cerrando bot...'
    );

    actualizarEstadoHeartbeat({
        status: 'stopping',
        message: 'Cerrando bot',
    });

    await detenerHeartbeat();
    await cerrarWhatsApp();
    await cerrarFacebook();
    await cerrarNavegadorPrincipal();
    liberarBloqueoWhatsApp();

    process.exit(0);
}

process.on(
    'SIGINT',
    cerrarBot
);

process.on(
    'SIGTERM',
    cerrarBot
);

// ============================================================
// EJECUTAR
// ============================================================

iniciar()
.catch(
    async error => {

        console.error('');

        console.error(
            'ERROR FATAL AL INICIAR EL BOT:'
        );

        console.error(
            error
        );

        await detenerHeartbeat();
        await cerrarWhatsApp();
        await cerrarFacebook();
        await cerrarNavegadorPrincipal();
        liberarBloqueoWhatsApp();

        process.exit(1);
    }
);
