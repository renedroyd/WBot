'use strict';

function normalizeWid(value) {
    if (value === null || value === undefined) return '';

    let serialized = value;
    if (typeof value === 'object') {
        serialized = value._serialized
            || (value.user && value.server ? String(value.user) + '@' + String(value.server) : '');
    }

    if (typeof serialized !== 'string') return '';

    return serialized
        .trim()
        .replace(/:\d+(?=@)/, '')
        .toLowerCase();
}

/**
 * Returns true/false only when both the current account identity and the
 * group's participant metadata are available. Accepts WID and LID identities.
 * Null means the result cannot be verified.
 */
function getCurrentUserGroupAdminStatus(groupMetadata, currentUserIds) {
    const identities = (Array.isArray(currentUserIds) ? currentUserIds : [currentUserIds])
        .map(normalizeWid)
        .filter(Boolean);

    if (!identities.length || !groupMetadata || !Array.isArray(groupMetadata.participants)) {
        return null;
    }

    const participant = groupMetadata.participants.find(item =>
        identities.includes(normalizeWid(item?.id))
    );

    if (!participant) return false;

    return participant.isAdmin === true || participant.isSuperAdmin === true;
}

module.exports = { normalizeWid, getCurrentUserGroupAdminStatus };
