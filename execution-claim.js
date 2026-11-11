'use strict';

/**
 * Fail closed unless SocialPublicator explicitly granted this process the
 * right to perform the delivery. A succeeded execution is safe to acknowledge
 * locally; running/unknown executions belong to another attempt or need review.
 */
function assertExecutionClaim(response) {
    const execution = response?.data;

    if (!execution || !Number.isInteger(Number(execution.id)) || Number(execution.id) <= 0) {
        throw new Error('SocialPublicator no devolvió una ejecución válida; se cancela el envío.');
    }

    if (execution.status === 'succeeded') {
        return { execution, claimed: false, alreadySucceeded: true };
    }

    if (response.claimed === true && execution.status === 'running') {
        return { execution, claimed: true, alreadySucceeded: false };
    }

    if (execution.status === 'unknown') {
        throw new Error(
            'La ejecución tiene resultado incierto en SocialPublicator; requiere reconciliación y no se reenviará automáticamente.'
        );
    }

    if (execution.status === 'running') {
        throw new Error(
            'La ejecución ya está siendo procesada por otro intento/agente; se omite el envío duplicado.'
        );
    }

    throw new Error(
        'SocialPublicator no confirmó la reclamación exclusiva de la ejecución; se cancela el envío.'
    );
}

module.exports = { assertExecutionClaim };
