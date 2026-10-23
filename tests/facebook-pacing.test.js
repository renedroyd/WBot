'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFacebookPacer } = require('../facebook-pacing');

test('no espera antes de la primera publicación', async () => {
    const delays = [];
    const pacer = createFacebookPacer({
        minDelayMs: 10000,
        maxDelayMs: 15000,
        sleep: async delay => delays.push(delay),
    });

    assert.equal(await pacer.run(async () => 'published'), 'published');
    assert.deepEqual(delays, []);
});

test('serializa tareas concurrentes y espera entre ellas dentro del rango configurado', async () => {
    const events = [];
    const delays = [];
    const randomValues = [0, 0.5, 0.999999];
    const pacer = createFacebookPacer({
        minDelayMs: 10000,
        maxDelayMs: 15000,
        random: () => randomValues.shift() ?? 0,
        sleep: async delay => delays.push(delay),
    });

    const results = await Promise.all([
        pacer.run(async () => { events.push('first-start'); await Promise.resolve(); events.push('first-end'); return 1; }),
        pacer.run(async () => { events.push('second-start'); events.push('second-end'); return 2; }),
        pacer.run(async () => { events.push('third-start'); events.push('third-end'); return 3; }),
    ]);

    assert.deepEqual(results, [1, 2, 3]);
    assert.deepEqual(events, [
        'first-start', 'first-end',
        'second-start', 'second-end',
        'third-start', 'third-end',
    ]);
    assert.deepEqual(delays, [10000, 12500]);
    assert.ok(delays.every(delay => delay >= 10000 && delay <= 15000));
});

test('continúa la cola aunque una publicación falle', async () => {
    const delays = [];
    const pacer = createFacebookPacer({
        minDelayMs: 10000,
        maxDelayMs: 15000,
        random: () => 0.999999,
        sleep: async delay => delays.push(delay),
    });

    await assert.rejects(pacer.run(async () => { throw new Error('falló'); }), /falló/);
    assert.equal(await pacer.run(async () => 'next'), 'next');
    assert.deepEqual(delays, [14999]);
});

test('rechaza rangos de espera inválidos', () => {
    assert.throws(() => createFacebookPacer({ minDelayMs: -1 }), /minDelayMs/);
    assert.throws(() => createFacebookPacer({ minDelayMs: 15000, maxDelayMs: 10000 }), /maxDelayMs/);
});
