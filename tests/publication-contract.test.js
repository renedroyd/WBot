'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { normalizePublication } = require('../publication-contract');

test('normalizes the versioned English publication contract for the existing WBot pipeline', () => {
    const normalized = normalizePublication({
        id: 71,
        occurrence_id: '71_2026-11-11_10-30',
        date: '2026-11-11',
        time: '10:30',
        text: 'Oferta de prueba',
        image: 'https://cdn.example.test/item.jpg',
        destination: 'both',
        whatsapp_groups: [{ id: 4, whatsapp_id: '120@g.us', name: 'Grupo WA' }],
        facebook_groups: [{ id: 8, facebook_id: '9988', name: 'Grupo FB', url: 'https://facebook.com/groups/9988' }],
    });

    assert.equal(normalized.ocurrencia_id, '71_2026-11-11_10-30');
    assert.equal(normalized.fecha, '2026-11-11');
    assert.equal(normalized.hora, '10:30');
    assert.equal(normalized.texto, 'Oferta de prueba');
    assert.equal(normalized.imagen, 'https://cdn.example.test/item.jpg');
    assert.equal(normalized.destino, 'both');
    assert.equal(normalized.whatsapp_grupos[0].whatsapp_id, '120@g.us');
    assert.equal(normalized.facebook_grupos[0].facebook_id, '9988');
});

test('preserves compatibility with the legacy Spanish publication contract', () => {
    const legacy = {
        id: 72,
        ocurrencia_id: '72_2026-11-11_11-00',
        fecha: '2026-11-11',
        hora: '11:00',
        texto: 'Publicación heredada',
        imagen: 'https://cdn.example.test/legacy.jpg',
        destino: 'whatsapp',
    };

    assert.deepEqual(normalizePublication(legacy), {
        ...legacy,
        occurrence_id: legacy.ocurrencia_id,
        date: legacy.fecha,
        time: legacy.hora,
        text: legacy.texto,
        image: legacy.imagen,
        destination: legacy.destino,
        whatsapp_groups: undefined,
        facebook_groups: undefined,
    });
});

test('leaves invalid payloads untouched for the caller validation to reject', () => {
    assert.equal(normalizePublication(null), null);
    assert.equal(normalizePublication('invalid'), 'invalid');
});
