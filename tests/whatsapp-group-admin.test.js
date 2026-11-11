'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { normalizeWid, getCurrentUserGroupAdminStatus } = require('../whatsapp-group-admin');

test('normalizes WIDs with device suffixes before comparing account identity', () => {
    assert.equal(normalizeWid('12025550123:4@c.us'), '12025550123@c.us');
    assert.equal(normalizeWid({ user: '12025550123', server: 'c.us' }), '12025550123@c.us');
});

test('identifies the connected WhatsApp account as a group administrator', () => {
    assert.equal(getCurrentUserGroupAdminStatus({
        participants: [
            { id: '12025550123:4@c.us', isAdmin: true },
            { id: '12025550124@c.us', isAdmin: false },
        ],
    }, '12025550123@c.us'), true);
});

test('recognizes super-admin membership', () => {
    assert.equal(getCurrentUserGroupAdminStatus({
        participants: [{ id: '12025550123@c.us', isSuperAdmin: true }],
    }, '12025550123@c.us'), true);
});

test('returns false when metadata confirms the connected account is not an admin', () => {
    assert.equal(getCurrentUserGroupAdminStatus({
        participants: [{ id: '12025550123@c.us', isAdmin: false, isSuperAdmin: false }],
    }, '12025550123@c.us'), false);
});

test('matches the current account LID when a group participant is represented by LID', () => {
    assert.equal(getCurrentUserGroupAdminStatus({
        participants: [{ id: 'abc123@lid', isAdmin: true }],
    }, ['12025550123@c.us', 'abc123@lid']), true);
});

test('returns null when the identity or metadata cannot be verified', () => {
    assert.equal(getCurrentUserGroupAdminStatus(null, '12025550123@c.us'), null);
    assert.equal(getCurrentUserGroupAdminStatus({ participants: [] }, null), null);
});
