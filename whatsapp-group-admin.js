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
        .replace(/:\\d+(?=@)/, '')
        .toLowerCase();
}

/**
 * Returns true/false only when both the current account identity and the
 * group's participant metadata are available. Null means not verifiable.
 */
function getCurrentUserGroupAdminStatus(groupMetadata, currentUserId) {
    const current = normalizeWid(currentUserId);
    if (!current || !groupMetadata || !Array.isArray(groupMetadata.participants)) {
        return null;
    }

    const participant = groupMetadata.participants.find(item =>
        normalizeWid(item?.id) === current
    );

    if (!participant) return false;

    return participant.isAdmin === true || participant.isSuperAdmin === true;
}

module.exports = { normalizeWid, getCurrentUserGroupAdminStatus };
