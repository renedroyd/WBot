'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { assertExecutionClaim } = require('../execution-claim');

test('allows delivery only when SocialPublicator explicitly grants the running execution', () => {
    const result = assertExecutionClaim({
        claimed: true,
        data: { id: 12, status: 'running' },
    });

    assert.equal(result.claimed, true);
    assert.equal(result.execution.id, 12);
});

test('allows local acknowledgement without delivery when the execution already succeeded', () => {
    const result = assertExecutionClaim({
        claimed: false,
        data: { id: 13, status: 'succeeded' },
    });

    assert.equal(result.alreadySucceeded, true);
});

test('refuses a running execution that was not claimed by this request', () => {
    assert.throws(
        () => assertExecutionClaim({ claimed: false, data: { id: 14, status: 'running' } }),
        /otro intento/
    );
});

test('refuses unknown outcomes instead of risking a duplicate publication', () => {
    assert.throws(
        () => assertExecutionClaim({ claimed: false, data: { id: 15, status: 'unknown' } }),
        /resultado incierto/
    );
});

test('fails closed when SocialPublicator did not return a valid execution', () => {
    assert.throws(
        () => assertExecutionClaim(null),
        /ejecución válida/
    );
});
