'use strict';

const defaultSleep = milliseconds =>
    new Promise(resolve => setTimeout(resolve, milliseconds));

/**
 * Serializes Facebook publishing tasks and inserts a configurable pause between
 * attempts. Pacing reduces bursts; it does not guarantee that a platform will
 * not restrict an account.
 */
function createFacebookPacer({
    minDelayMs = 10000,
    maxDelayMs = 15000,
    random = Math.random,
    sleep = defaultSleep,
    onWait = () => {},
} = {}) {
    if (!Number.isInteger(minDelayMs) || minDelayMs < 0) {
        throw new TypeError('minDelayMs debe ser un entero no negativo.');
    }

    if (!Number.isInteger(maxDelayMs) || maxDelayMs < minDelayMs) {
        throw new TypeError('maxDelayMs debe ser un entero mayor o igual que minDelayMs.');
    }

    let queue = Promise.resolve();
    let hasRunTask = false;

    function run(task) {
        if (typeof task !== 'function') {
            return Promise.reject(new TypeError('La tarea de Facebook debe ser una función.'));
        }

        const result = queue.then(async () => {
            if (hasRunTask) {
                const delayMs = Math.min(
                    maxDelayMs,
                    minDelayMs + Math.floor(random() * (maxDelayMs - minDelayMs + 1))
                );

                onWait(delayMs);
                await sleep(delayMs);
            }

            hasRunTask = true;
            return task();
        });

        // Una tarea fallida no debe bloquear las siguientes publicaciones.
        queue = result.then(() => undefined, () => undefined);
        return result;
    }

    return { run };
}

module.exports = { createFacebookPacer };
