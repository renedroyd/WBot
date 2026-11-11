'use strict';

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = __dirname;
const WORKER_SCRIPT = path.join(ROOT, 'bot.js');
const MAX_RESTART_DELAY_MS = 60000;
const STABLE_RUNTIME_MS = 60000;

function requiredString(value, label) {
    const result = String(value ?? '').trim();
    if (!result) throw new Error(label + ' es obligatorio.');
    return result;
}

function accountId(value, label) {
    const valueString = String(value ?? '').trim();
    if (!/^[1-9]\d*$/.test(valueString)) {
        throw new Error(label + ' debe ser un ID numérico positivo.');
    }
    return valueString;
}

function resolvePath(baseDir, value, fallback) {
    return path.resolve(baseDir, value || fallback);
}

function buildInstanceDefinitions(config, baseEnv = process.env, baseDir = ROOT) {
    if (!config || !Array.isArray(config.instances) || config.instances.length === 0) {
        throw new Error('instances.json debe contener al menos una instancia en "instances".');
    }

    if (!baseEnv.LARAVEL_API_URL) {
        throw new Error('LARAVEL_API_URL es obligatorio para ejecutar instancias administradas.');
    }

    const ids = new Set();
    const keys = new Set();
    const tokens = new Set();
    const tokenNames = new Set();
    const whatsappAccounts = new Set();
    const facebookAccounts = new Set();
    const sessionNames = new Set();
    const runtimePaths = new Set();

    return config.instances.map((raw, index) => {
        const label = 'instances[' + index + ']';
        const id = requiredString(raw?.id, label + '.id');
        const key = requiredString(raw?.key || id, label + '.key');
        const tokenEnv = requiredString(raw?.tokenEnv, label + '.tokenEnv');

        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(key)) {
            throw new Error(label + '.key solo puede contener letras, números, guiones y guiones bajos.');
        }
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tokenEnv)) {
            throw new Error(label + '.tokenEnv no es un nombre de variable válido.');
        }
        if (ids.has(id)) throw new Error('BOT_INSTANCE_ID duplicado: ' + id);
        if (keys.has(key.toLowerCase())) throw new Error('Clave de instancia duplicada: ' + key);
        if (tokenNames.has(tokenEnv)) throw new Error('Cada instancia debe usar una variable tokenEnv diferente: ' + tokenEnv);

        const token = requiredString(baseEnv[tokenEnv], tokenEnv + ' (token de SocialPublicator)');
        if (tokens.has(token)) throw new Error('No se permite reutilizar el mismo token de agente entre instancias.');

        const whatsapp = raw.whatsapp;
        if (!whatsapp || typeof whatsapp !== 'object') {
            throw new Error(label + '.whatsapp es obligatorio; cada worker necesita una cuenta WhatsApp propia.');
        }

        const whatsappAccountId = accountId(whatsapp.socialAccountId, label + '.whatsapp.socialAccountId');
        if (whatsappAccounts.has(whatsappAccountId)) {
            throw new Error('La cuenta WhatsApp #' + whatsappAccountId + ' está asignada a más de una instancia.');
        }

        const sessionName = requiredString(whatsapp.sessionName || ('whatsapp-' + key), label + '.whatsapp.sessionName');
        if (sessionNames.has(sessionName.toLowerCase())) {
            throw new Error('Nombre de sesión WhatsApp duplicado: ' + sessionName);
        }

        let facebook = null;
        if (raw.facebook) {
            const facebookAccountId = accountId(raw.facebook.socialAccountId, label + '.facebook.socialAccountId');
            if (facebookAccounts.has(facebookAccountId)) {
                throw new Error('La cuenta Facebook #' + facebookAccountId + ' está asignada a más de una instancia.');
            }
            const originUrl = requiredString(
                raw.facebook.originUrl || baseEnv.FACEBOOK_ORIGEN_URL,
                label + '.facebook.originUrl'
            );
            facebook = {
                socialAccountId: facebookAccountId,
                originUrl,
                headless: raw.facebook.headless === undefined ? true : Boolean(raw.facebook.headless),
                sessionDir: resolvePath(baseDir, raw.facebook.sessionDir, './runtime/' + key + '/facebook/session'),
                profileDir: resolvePath(baseDir, raw.facebook.profileDir, './runtime/' + key + '/facebook/profile'),
                backupDir: resolvePath(baseDir, raw.facebook.backupDir, './runtime/' + key + '/facebook/backups'),
            };
            facebookAccounts.add(facebookAccountId);
        }

        const dataDir = resolvePath(baseDir, raw.dataDir, './runtime/' + key + '/data');
        const stateFile = resolvePath(baseDir, raw.stateFile, path.join(dataDir, 'publicaciones_enviadas.json'));
        const whatsappConfig = {
            socialAccountId: whatsappAccountId,
            sessionName,
            sessionDir: resolvePath(baseDir, whatsapp.sessionDir, './runtime/' + key + '/whatsapp/session'),
            profileDir: resolvePath(baseDir, whatsapp.profileDir, './runtime/' + key + '/whatsapp/profile'),
            tokenDir: resolvePath(baseDir, whatsapp.tokenDir, './runtime/' + key + '/whatsapp/tokens'),
            lockFile: resolvePath(baseDir, whatsapp.lockFile, './runtime/' + key + '/whatsapp/session.lock'),
        };

        const paths = [
            dataDir,
            stateFile,
            whatsappConfig.sessionDir,
            whatsappConfig.profileDir,
            whatsappConfig.tokenDir,
            whatsappConfig.lockFile,
            ...(facebook ? [facebook.sessionDir, facebook.profileDir, facebook.backupDir] : []),
        ];

        for (const item of paths) {
            const normalized = path.normalize(item).toLowerCase();
            if (runtimePaths.has(normalized)) {
                throw new Error('Ruta de runtime compartida entre instancias: ' + item);
            }
            runtimePaths.add(normalized);
        }

        ids.add(id);
        keys.add(key.toLowerCase());
        tokens.add(token);
        tokenNames.add(tokenEnv);
        whatsappAccounts.add(whatsappAccountId);
        sessionNames.add(sessionName.toLowerCase());

        return {
            id,
            key,
            tokenEnv,
            token,
            botName: raw.botName || baseEnv.BOT_NAME || 'WBot',
            dataDir,
            stateFile,
            whatsapp: whatsappConfig,
            facebook,
        };
    });
}

function buildWorkerEnv(definition, baseEnv = process.env, allDefinitions = []) {
    const env = { ...baseEnv };

    // Do not expose other workers' agent tokens to this child process.
    for (const item of allDefinitions) {
        delete env[item.tokenEnv];
    }
    delete env.BOT_INSTANCES_CONFIG;

    const facebook = definition.facebook;
    env.BOT_NAME = definition.botName;
    env.BOT_INSTANCE_ID = definition.id;
    env.LARAVEL_API_TOKEN = definition.token;
    env.SOCIAL_ACCOUNT_ID = definition.whatsapp.socialAccountId;
    env.FACEBOOK_SOCIAL_ACCOUNT_ID = facebook?.socialAccountId || '';
    env.BOT_MANAGED_INSTANCE = 'true';

    env.BOT_DATA_DIR = definition.dataDir;
    env.BOT_STATE_FILE = definition.stateFile;

    env.WHATSAPP_SESSION_NAME = definition.whatsapp.sessionName;
    env.WHATSAPP_SESSION_DIR = definition.whatsapp.sessionDir;
    env.WHATSAPP_PROFILE_DIR = definition.whatsapp.profileDir;
    env.WHATSAPP_TOKEN_DIR = definition.whatsapp.tokenDir;
    env.WHATSAPP_LOCK_FILE = definition.whatsapp.lockFile;

    env.FACEBOOK_ENABLED = facebook ? 'true' : 'false';
    env.FACEBOOK_ORIGEN_URL = facebook?.originUrl || '';
    env.FACEBOOK_HEADLESS = facebook ? String(facebook.headless) : 'true';
    env.FACEBOOK_SESSION_DIR = facebook?.sessionDir || path.join(definition.dataDir, 'facebook-disabled');
    env.BROWSER_PROFILE_DIR = facebook?.profileDir || definition.whatsapp.profileDir;
    env.BROWSER_PROFILE_BACKUP_DIR = facebook?.backupDir || path.join(definition.dataDir, 'browser-backups');

    return env;
}

function ensureRuntimeDirectories(definition) {
    const directories = [
        definition.dataDir,
        path.dirname(definition.stateFile),
        definition.whatsapp.sessionDir,
        definition.whatsapp.profileDir,
        definition.whatsapp.tokenDir,
        path.dirname(definition.whatsapp.lockFile),
    ];

    if (definition.facebook) {
        directories.push(
            definition.facebook.sessionDir,
            definition.facebook.profileDir,
            definition.facebook.backupDir,
        );
    }

    for (const directory of directories) {
        fs.mkdirSync(directory, { recursive: true });
    }
}

function startManagedWorkers(definitions, baseEnv = process.env) {
    let stopping = false;
    const workers = new Map();
    const restartTimers = new Set();

    function scheduleRestart(definition, runtimeMs) {
        if (stopping) return;

        const worker = workers.get(definition.id);
        if (!worker || worker.restartScheduled) return;

        if (runtimeMs >= STABLE_RUNTIME_MS) {
            worker.restartDelayMs = 1000;
        }

        const delay = worker.restartDelayMs || 1000;
        worker.restartDelayMs = Math.min(delay * 2, MAX_RESTART_DELAY_MS);
        worker.restartScheduled = true;

        console.warn('[Manager] Reiniciando ' + definition.id + ' en ' + delay + ' ms.');
        const timer = setTimeout(() => {
            restartTimers.delete(timer);
            if (stopping) return;
            worker.restartScheduled = false;
            launch(definition);
        }, delay);
        timer.unref?.();
        restartTimers.add(timer);
    }

    function launch(definition) {
        if (stopping) return;

        const worker = workers.get(definition.id) || { restartDelayMs: 1000, restartScheduled: false };
        workers.set(definition.id, worker);
        const startedAt = Date.now();

        console.log(
            '[Manager] Iniciando ' + definition.id +
            ' (WhatsApp #' + definition.whatsapp.socialAccountId +
            (definition.facebook ? ', Facebook #' + definition.facebook.socialAccountId : '') + ').'
        );

        const child = spawn(process.execPath, [WORKER_SCRIPT], {
            cwd: ROOT,
            env: buildWorkerEnv(definition, baseEnv, definitions),
            stdio: 'inherit',
            windowsHide: false,
        });

        worker.child = child;
        worker.restartScheduled = false;

        child.once('error', error => {
            console.error('[Manager] No se pudo iniciar ' + definition.id + ': ' + error.message);
            scheduleRestart(definition, Date.now() - startedAt);
        });

        child.once('exit', (code, signal) => {
            worker.child = null;
            if (stopping) return;
            console.warn(
                '[Manager] ' + definition.id + ' terminó (code=' + code + ', signal=' + signal + ').'
            );
            scheduleRestart(definition, Date.now() - startedAt);
        });
    }

    for (const definition of definitions) {
        ensureRuntimeDirectories(definition);
        launch(definition);
    }

    function stop(signal = 'SIGTERM') {
        if (stopping) return;
        stopping = true;

        for (const timer of restartTimers) clearTimeout(timer);
        restartTimers.clear();

        for (const [id, worker] of workers) {
            if (worker.child && !worker.child.killed) {
                console.log('[Manager] Deteniendo ' + id + '...');
                worker.child.kill(signal);
            }
        }

        const forceTimer = setTimeout(() => {
            for (const worker of workers.values()) {
                if (worker.child && !worker.child.killed) worker.child.kill('SIGKILL');
            }
        }, 10000);
        forceTimer.unref?.();
    }

    return { stop };
}

function main() {
    const configPath = path.resolve(ROOT, process.env.BOT_INSTANCES_CONFIG || 'instances.json');
    let config;

    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const definitions = buildInstanceDefinitions(config, process.env, ROOT);
        console.log('[Manager] Configuración válida: ' + definitions.length + ' instancia(s).');

        const manager = startManagedWorkers(definitions, process.env);
        process.once('SIGINT', () => manager.stop('SIGINT'));
        process.once('SIGTERM', () => manager.stop('SIGTERM'));
    } catch (error) {
        console.error('[Manager] No se pudo iniciar el runtime multi-instancia:', error.message);
        process.exitCode = 1;
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    buildInstanceDefinitions,
    buildWorkerEnv,
    ensureRuntimeDirectories,
    startManagedWorkers,
};
