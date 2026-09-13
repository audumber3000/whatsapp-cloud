/**
 * Run with: npm test
 *
 * The partner API is how MolarPlus connects clinics' own numbers, so these
 * cover the parts that decide who may call it and what it reports: key
 * matching, the source-address check, status mapping, send pacing and the
 * media type a PDF goes out as. None of them touch the database; the pool is
 * lazy, so a placeholder DATABASE_URL is enough to load the modules.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:1/none';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const partners = require('./partners');
const { statusOf, PAIRING_TTL_MS } = require('./partnerApi');
const { createPacer, resolveMimetype } = require('./publicApi');

const KEY = 'k'.repeat(40);
const CONFIGURED = {
    molarplus: {
        id: 'molarplus',
        keyHash: crypto.createHash('sha256').update(KEY).digest(),
        allowedIps: ['13.207.97.83'],
    },
};

test('partnerForKey matches only the exact configured key', () => {
    assert.strictEqual(partners.partnerForKey(KEY, CONFIGURED).id, 'molarplus');
    assert.strictEqual(partners.partnerForKey(KEY + 'x', CONFIGURED), null);
    assert.strictEqual(partners.partnerForKey('', CONFIGURED), null);
    assert.strictEqual(partners.partnerForKey(undefined, CONFIGURED), null);
    assert.strictEqual(partners.partnerForKey(KEY, {}), null, 'no partners configured means no access');
});

test('source address ignores X-Forwarded-For', () => {
    const req = {
        socket: { remoteAddress: '::ffff:203.0.113.9' },
        headers: { 'x-forwarded-for': '13.207.97.83' },
        ip: '13.207.97.83',
    };
    // The spoofed header and the proxy-derived req.ip both claim the partner's
    // address. Only the socket is real.
    assert.strictEqual(partners.sourceIp(req), '203.0.113.9');
    assert.strictEqual(partners.ipAllowed(CONFIGURED.molarplus, partners.sourceIp(req)), false);
});

test('ipAllowed accepts v4-mapped forms of an allowlisted address', () => {
    assert.strictEqual(partners.ipAllowed(CONFIGURED.molarplus, '::ffff:13.207.97.83'), true);
    assert.strictEqual(partners.ipAllowed(CONFIGURED.molarplus, '13.207.97.84'), false);
    assert.strictEqual(partners.ipAllowed({ allowedIps: [] }, '1.2.3.4'), true, 'empty list is the dev default');
});

test('statusOf: connected wins and carries the phone', () => {
    const s = statusOf({ isConnected: true, currentQR: 'stale', phone: '919876543210' }, Date.now());
    assert.deepStrictEqual(s, { status: 'connected', phone_number: '919876543210', qrCode: '' });
});

test('statusOf: a QR means connecting', () => {
    const s = statusOf({ isConnected: false, currentQR: '2@abc', phone: null }, undefined);
    assert.strictEqual(s.status, 'connecting');
    assert.strictEqual(s.qrCode, '2@abc');
});

test('statusOf: waiting for the first QR is connecting, until the deadline', () => {
    const now = Date.now();
    assert.strictEqual(statusOf({ isConnected: false, currentQR: '' }, now - 1000, now).status, 'connecting');
    assert.strictEqual(statusOf({ isConnected: false, currentQR: '' }, now - PAIRING_TTL_MS - 1, now).status, 'disconnected');
});

test('statusOf: an unknown instance is disconnected', () => {
    assert.strictEqual(statusOf(null, undefined).status, 'disconnected');
});

test('pacer runs one job at a time per key, in order, with the gap', async () => {
    let clock = 0;
    const slept = [];
    const pacer = createPacer({
        gapMs: 1000, maxQueued: 10,
        now: () => clock,
        sleep: async (ms) => { slept.push(ms); clock += ms; },
    });
    const order = [];
    const a = pacer.run('org1', async () => { order.push('a'); return 1; });
    const b = pacer.run('org1', async () => { order.push('b'); return 2; });
    assert.deepStrictEqual(await Promise.all([a, b]), [1, 2]);
    assert.deepStrictEqual(order, ['a', 'b']);
    assert.deepStrictEqual(slept, [1000], 'the second send waits out the gap');
});

test('pacer refuses a full lane instead of queueing forever', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const pacer = createPacer({ gapMs: 0, maxQueued: 2 });
    const first = pacer.run('org1', () => gate);
    const second = pacer.run('org1', async () => 'second');
    assert.strictEqual(pacer.run('org1', async () => 'third'), null);
    assert.ok(pacer.run('org2', async () => 'other org'), 'another workspace has its own lane');
    release('first');
    assert.strictEqual(await first, 'first');
    assert.strictEqual(await second, 'second');
});

test('pacer keeps going after a job throws', async () => {
    const pacer = createPacer({ gapMs: 0, maxQueued: 5 });
    const bad = pacer.run('org1', async () => { throw new Error('boom'); });
    const good = pacer.run('org1', async () => 'ok');
    await assert.rejects(bad, /boom/);
    assert.strictEqual(await good, 'ok');
    await new Promise((r) => setImmediate(r));   // the lane settles after the job does
    assert.strictEqual(pacer.depth('org1'), 0);
});

test('resolveMimetype: an explicit type wins, else the file extension', () => {
    assert.strictEqual(resolveMimetype('application/pdf', 'x.bin'), 'application/pdf');
    assert.strictEqual(resolveMimetype('', 'Invoice-INV-001.PDF'), 'application/pdf');
    assert.strictEqual(resolveMimetype(undefined, 'scan.jpeg'), 'image/jpeg');
    assert.strictEqual(resolveMimetype('not a mime', 'x'), '');
    assert.strictEqual(resolveMimetype('image/svg+xml', 'a.svg'), '', 'svg is never passed through');
});
