'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    STOP_REASONS, normalizeFacts, typingState, describeFacts, bannerStatus, auditFacts, failureGuidance
} = require('../lib/action-facts.js');
const { formatActionReceipt } = require('../lib/format.js');
const { readConfig } = require('../index.js');
const pluginConfig = require('../plugin_config.json');

test('stop reason enum is the agreed set', () => {
    assert.deepEqual([...STOP_REASONS], ['user_active', 'esc', 'locked', 'timeout', 'worker_error']);
});

test('successful replies without any new fields (old / fake workers) default to a known, un-yielded result', () => {
    const facts = normalizeFacts({ x: 1, y: 2, foreground: { process_name: 'notepad.exe', id: 100, title: 'secret title' } }, { ok: true });
    assert.equal(facts.yielded, false);
    assert.equal(facts.waitedMs, 0);
    assert.equal(facts.resultKnown, true);
    assert.equal(facts.stoppedReason, null);
    assert.equal(facts.foreground.processName, 'notepad.exe');
    assert.equal(typingState(facts), null);
});

test('five receipt classes: owner active, Esc, timeout, worker crash, partial typing / result unknown', () => {
    const owner = normalizeFacts({ yielded: true, waited_ms: 3000, yield_source: 'keyboard', injected: false, result_known: true }, { ok: false, code: 'user_active' });
    assert.deepEqual([owner.stoppedReason, owner.yielded, owner.resultKnown, owner.yieldSource], ['user_active', true, true, 'keyboard']);

    const esc = normalizeFacts(null, { ok: false, code: 'aborted' });
    assert.deepEqual([esc.stoppedReason, esc.resultKnown], ['esc', true]);

    const locked = normalizeFacts(null, { ok: false, code: 'locked' });
    assert.equal(locked.stoppedReason, 'locked');

    const timeout = normalizeFacts(null, { ok: false, code: 'timeout' });
    assert.deepEqual([timeout.stoppedReason, timeout.resultKnown], ['timeout', false]);

    for (const code of ['worker_exited', 'worker_crashed', 'worker_restarted']) {
        const crash = normalizeFacts(null, { ok: false, code });
        assert.deepEqual([crash.stoppedReason, crash.resultKnown], ['worker_error', false], code);
    }

    const partial = normalizeFacts({ typed: 5, input_total: 12, completed: false, yielded: true, stopped_reason: 'user_active', result_known: true, injected: true }, { ok: false, code: 'user_active' });
    assert.equal(typingState(partial), 'partial');
    assert.match(describeFacts(partial).join('；'), /部分输入：5\/12 字，其余没有输入/);

    const unknown = normalizeFacts({ result_known: false, stopped_reason: 'worker_error', injected: true }, { ok: false, code: 'internal' });
    assert.equal(unknown.resultKnown, false);
});

test('a bad stopped_reason from a worker is clamped into the enum', () => {
    assert.equal(normalizeFacts({ stopped_reason: 'mystery' }, { ok: false, code: 'x' }).stoppedReason, 'worker_error');
});

test('typing states: all / partial / none are derived from counts, not from wording', () => {
    assert.equal(typingState(normalizeFacts({ typed: 8, input_total: 8 }, { ok: true })), 'full');
    assert.equal(typingState(normalizeFacts({ typed: 3, input_total: 8 }, { ok: false, code: 'user_active' })), 'partial');
    assert.equal(typingState(normalizeFacts({ typed: 0, input_total: 8 }, { ok: false, code: 'user_active' })), 'none');
    assert.match(describeFacts(normalizeFacts({ typed: 0, input_total: 8 }, { ok: false, code: 'user_active' })).join(), /尚未输入（0\/8 字）/);
    assert.match(describeFacts(normalizeFacts({ typed: 8, input_total: 8 }, { ok: true })).join(), /已输入全部 8\/8 字/);
    const lowerBound = normalizeFacts({ typed: 5, input_total: 40, typed_exact: false, result_known: false }, { ok: false, code: 'send_input_failed' });
    assert.match(describeFacts(lowerBound).join(), /至少5\/40 字/);
});

test('banner, receipt, audit and guidance never contain typed text', () => {
    const secret = '我的密码是hunter2';
    const facts = normalizeFacts({ typed: 3, input_total: 9, text: secret, value: secret, yielded: true, stopped_reason: 'user_active', result_known: true, foreground: { process_name: 'notepad.exe', title: secret } }, { ok: false, code: 'user_active' });
    const blob = JSON.stringify([bannerStatus(facts), describeFacts(facts), formatActionReceipt(facts), auditFacts(facts), failureGuidance(facts)]);
    assert.doesNotMatch(blob, /hunter2|我的密码/);
    assert.match(bannerStatus(facts).text, /已输入 3\/9 字/);
    assert.equal(bannerStatus(facts).kind, 'pause');
});

test('banner status per class', () => {
    assert.equal(bannerStatus(normalizeFacts(null, { ok: false, code: 'aborted' })).text, '肥牛已停手');
    assert.equal(bannerStatus(normalizeFacts(null, { ok: false, code: 'timeout' })).kind, 'stop');
    assert.match(bannerStatus(normalizeFacts(null, { ok: false, code: 'timeout' })).text, /结果未确认/);
    assert.match(bannerStatus(normalizeFacts({ waited_ms: 3000 }, { ok: false, code: 'user_active' })).text, /让位/);
    assert.equal(bannerStatus(normalizeFacts({}, { ok: true })), null);
});

test('guidance distinguishes yield / Esc / timeout and forbids blind replay', () => {
    const g = code => failureGuidance(normalizeFacts(null, { ok: false, code }));
    assert.match(g('user_active'), /让位，不是故障/);
    assert.match(g('user_active'), /重新 computer_observe/);
    assert.match(g('aborted'), /Esc/);
    assert.match(g('timeout'), /不要自动重试/);
    assert.match(g('worker_exited'), /结果未知/);
    assert.equal(g('not_found'), null);
    const partial = failureGuidance(normalizeFacts({ typed: 5, input_total: 12 }, { ok: false, code: 'user_active' }));
    assert.match(partial, /只补输入缺少的部分/);
});

test('config: bounds and defaults, and plugin_config.json agrees with readConfig', () => {
    const d = readConfig({});
    assert.deepEqual(
        [d.user_idle_yield, d.user_idle_ms, d.user_idle_max_wait_ms, d.type_chunk_size, d.type_chunk_gap_ms],
        [true, 500, 3000, 16, 100]
    );
    assert.equal(d.autonomous_control, true, 'autonomous default is untouched');
    const low = readConfig({ user_idle_ms: -5, user_idle_max_wait_ms: -1, type_chunk_size: 0, type_chunk_gap_ms: -9 });
    assert.deepEqual([low.user_idle_ms, low.user_idle_max_wait_ms, low.type_chunk_size, low.type_chunk_gap_ms], [100, 0, 1, 0]);
    const high = readConfig({ user_idle_ms: 1e9, user_idle_max_wait_ms: 1e9, type_chunk_size: 99999, type_chunk_gap_ms: 1e9 });
    assert.deepEqual([high.user_idle_ms, high.user_idle_max_wait_ms, high.type_chunk_size, high.type_chunk_gap_ms], [5000, 30000, 200, 1000]);
    assert.equal(readConfig({ user_idle_yield: 'false' }).user_idle_yield, false);
    assert.equal(readConfig({ user_idle_ms: 'abc' }).user_idle_ms, 500);
    for (const key of ['user_idle_yield', 'user_idle_ms', 'user_idle_max_wait_ms', 'type_chunk_size', 'type_chunk_gap_ms']) {
        const entry = pluginConfig[key];
        assert.ok(entry, `${key} is exposed in plugin_config.json`);
        assert.equal(entry.default, d[key], `${key} default matches readConfig`);
        assert.equal(entry.value, entry.default, `${key} ships with its default value`);
    }
    assert.equal(pluginConfig.autonomous_control.default, true);
    assert.equal(pluginConfig.autonomous_control.value, true);
});
