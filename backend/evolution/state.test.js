/**
 * Run with: npm test
 *
 * These cover the connection-state cache, which is what /api/health reports
 * and what every send path gates on. The first test is a regression guard:
 * production reported "0/2 connected" for two days with a phone genuinely
 * online, because a caller treated instances() as state objects.
 */
const test = require('node:test');
const assert = require('node:assert');

const state = require('./state');

function reset() {
    for (const n of state.instances()) state.remove(n);
}

test('instances() returns names, not state objects', () => {
    reset();
    state.update('inst_a', { isConnected: true });
    const list = state.instances();
    assert.deepStrictEqual(list, ['inst_a']);
    assert.strictEqual(typeof list[0], 'string');
    // The exact mistake that shipped: filtering names on a state field.
    assert.strictEqual(list.filter((s) => s.isConnected).length, 0);
});

test('summary() counts connected instances', () => {
    reset();
    state.update('inst_a', { isConnected: true });
    state.update('inst_b', { isConnected: false });
    assert.deepStrictEqual(state.summary(), { connected: 1, total: 2 });
});

test('summary() on an empty cache does not report degraded', () => {
    reset();
    assert.deepStrictEqual(state.summary(), { connected: 0, total: 0 });
});

test('summary() follows a disconnect', () => {
    reset();
    state.update('inst_a', { isConnected: true });
    assert.strictEqual(state.summary().connected, 1);
    state.update('inst_a', { isConnected: false, lastEvent: 'logout' });
    assert.strictEqual(state.summary().connected, 0);
    assert.strictEqual(state.summary().total, 1, 'a logged-out instance is still known');
});

test('get() on an unknown instance is safe', () => {
    reset();
    assert.strictEqual(state.get('nope').isConnected, false);
});

test('onChange fires only when a watched field actually changes', () => {
    reset();
    let fired = 0;
    const off = state.onChange(() => { fired += 1; });
    state.update('inst_a', { isConnected: true });
    assert.strictEqual(fired, 1);
    state.update('inst_a', { lastEvent: 'heartbeat' });   // no watched change
    assert.strictEqual(fired, 1, 'a non-watched field must not notify');
    state.update('inst_a', { isConnected: false });
    assert.strictEqual(fired, 2);
    off();
});

test('normalizeOwner strips the JID suffix', () => {
    assert.strictEqual(state.normalizeOwner('919594078777@s.whatsapp.net'), '919594078777');
    assert.strictEqual(state.normalizeOwner(null), null);
});
