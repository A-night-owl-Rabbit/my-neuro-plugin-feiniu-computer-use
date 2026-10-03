'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PendingActions } = require('../lib/pending-actions.js');

test('create / take / cancel / expire', () => {
    let now = 5000;
    const pending = new PendingActions({ ttlMs: 1000, now: () => now });
    const item = pending.create({ kind: 'first_use', summary: '点击按钮', window: { process_name: 'Paint.exe', title: '画图' }, params: { x: 1 }, execute: async () => 'done' });
    assert.match(item.id, /^cu_/);
    assert.equal(item.processName, 'paint.exe');
    assert.equal(pending.size(), 1);
    const text = PendingActions.describe(item);
    assert.match(text, /computer_confirm_action/);
    assert.match(text, /remember_app/);

    assert.equal(pending.get('nope'), null);
    const taken = pending.take(item.id);
    assert.equal(taken.id, item.id);
    assert.equal(pending.size(), 0);

    pending.create({ kind: 'action', summary: 'a', execute: async () => {} });
    pending.create({ kind: 'action', summary: 'b', execute: async () => {} });
    assert.equal(pending.cancel(), 2);

    const stale = pending.create({ kind: 'action', summary: 'c', execute: async () => {} });
    now += 2000;
    assert.equal(pending.get(stale.id), null, 'expired items disappear');
});
