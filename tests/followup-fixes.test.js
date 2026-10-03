'use strict';

// Follow-up fixes after the first real-desktop acceptance (2026-10-03):
//  1. audit text_length counts Unicode characters, still no plaintext
//  2. an old observation rejected after a worker exit/restart says "worker restarted", not "an action ran"
//  3. (worker side coordinate validation lives in worker_protocol_test.py) the plugin explains out_of_screen
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AuditLogger } = require('../lib/audit-log.js');
const { ObservationStore } = require('../lib/observation.js');
const { setup, ownerTurn, readAudit } = require('./plugin-harness.js');

const EMOJI_TEXT = 'a😀b肥牛🎉'; // 6 code points, 8 UTF-16 units

async function observed(plugin, windowId = 100) {
    await ownerTurn(plugin);
    await plugin.executeTool('computer_observe', { window_id: windowId, include_ui_tree: true });
    return plugin.observations.latest().id;
}

test('audit sanitizer counts text/value in Unicode characters and never stores the plaintext', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feiniu-audit-'));
    try {
        const audit = new AuditLogger({ dataDir: dir, detail: 'full' });
        audit.event('info', 'type', { detail: { args: { text: EMOJI_TEXT, value: '😀😀', other: 'kept' } } });
        const file = fs.readdirSync(dir).find(f => f.startsWith('action-log-'));
        const raw = fs.readFileSync(path.join(dir, file), 'utf8');
        const record = JSON.parse(raw.trim().split('\n').pop());
        assert.equal(record.detail.args.text_length, 6, 'not the 8 UTF-16 units');
        assert.equal(record.detail.args.value_length, 2, 'not 4');
        assert.equal(record.detail.args.other, 'kept');
        assert.doesNotMatch(raw, /肥牛|😀|🎉/);
        assert.equal(record.detail.args.text, undefined);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('opting in to typed-text logging still keeps the text, unchanged', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feiniu-audit-'));
    try {
        const audit = new AuditLogger({ dataDir: dir, detail: 'full', logTypedText: true });
        audit.event('info', 'type', { detail: { args: { text: EMOJI_TEXT } } });
        const raw = fs.readFileSync(path.join(dir, fs.readdirSync(dir).find(f => f.startsWith('action-log-'))), 'utf8');
        assert.match(raw, /肥牛/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('plugin audit for a typed emoji text: text_length == receipt/summary character count', async t => {
    const { plugin, worker, cleanup, dataDir } = await setup({ webui_tool_log_detail: 'full' });
    t.after(cleanup);
    const id = await observed(plugin);
    const out = await plugin.executeTool('computer_type', { observation_id: id, text: EMOJI_TEXT, observe_after: false });
    assert.match(out, /已执行/);
    assert.equal(worker.callsOf('type_text')[0].args.text, EMOJI_TEXT);
    const audit = readAudit(dataDir);
    assert.doesNotMatch(audit, /肥牛|😀/, 'no input plaintext in the audit log');
    const line = audit.split('\n').filter(Boolean).map(JSON.parse).find(r => r.event === 'type');
    assert.match(line.summary, /输入文字（6 字）/);
    assert.ok(line.detail && line.detail.args, 'the audit record carries the sanitized args');
    assert.equal(line.detail.args.text_length, 6);
});

test('set_value audit summary counts Unicode characters too', async t => {
    const { plugin, cleanup, dataDir } = await setup();
    t.after(cleanup);
    const id = await observed(plugin);
    await plugin.executeTool('computer_set_value', { observation_id: id, element_index: 1, value: EMOJI_TEXT, observe_after: false });
    const record = readAudit(dataDir).split('\n').filter(Boolean).map(JSON.parse).find(r => r.event === 'set_value');
    assert.ok(record, 'set_value audited');
    assert.match(record.summary, /（6 字）/);
    assert.doesNotMatch(JSON.stringify(record), /肥牛|😀/);
});

test('observation killed by a worker exit says the worker restarted, not that an action ran', () => {
    for (const reason of ['worker_crashed', 'worker_exited', 'worker_timeout', 'worker_stopped', 'worker_process_error', 'worker_config_changed']) {
        const store = new ObservationStore({ generationProvider: () => 3 });
        const obs = store.create({ window: { id: 1 }, uiTree: null });
        store.invalidateAll(reason);
        const verdict = store.validate(obs.id);
        assert.equal(verdict.ok, false, reason);
        assert.equal(verdict.code, 'worker_restarted', reason);
        assert.match(verdict.reason, /worker_restarted/);
        assert.match(verdict.reason, /动作没有发送/);
        assert.match(verdict.reason, /重新 computer_observe/);
        assert.doesNotMatch(verdict.reason, /已经执行过动作/, reason);
        assert.doesNotMatch(verdict.reason, /worker_crashed/, 'the internal reason name is not presented as an executed action');
    }
});

test('the first cause wins: an observation already used by an action is still described as used', () => {
    const store = new ObservationStore({ generationProvider: () => 3 });
    const obs = store.create({ window: { id: 1 }, uiTree: null });
    store.consume(obs, 'click');
    store.invalidateAll('worker_crashed');
    const verdict = store.validate(obs.id);
    assert.equal(verdict.code, 'consumed_observation');
    assert.match(verdict.reason, /click/);
    // and Esc / owner activity keep their old wording
    const other = new ObservationStore({ generationProvider: () => 3 });
    const o2 = other.create({ window: { id: 1 }, uiTree: null });
    other.invalidateAll('esc');
    assert.equal(other.validate(o2.id).code, 'consumed_observation');
});

test('a generation change reports both generations', () => {
    let generation = 4;
    const store = new ObservationStore({ generationProvider: () => generation });
    const obs = store.create({ window: { id: 1 }, uiTree: null });
    generation = 6;
    const verdict = store.validate(obs.id);
    assert.equal(verdict.code, 'worker_restarted');
    assert.match(verdict.reason, /generation 4 → 6/);
    assert.match(verdict.reason, /重新 computer_observe/);
});

test('plugin: worker exits after the observation (generation not yet bumped) -> accurate rejection, nothing replayed', async t => {
    const { plugin, worker, cleanup } = await setup();
    t.after(cleanup);
    const id = await observed(plugin);
    worker.emit('invalidate', { generation: worker.generation, reason: 'exited' }); // process died; respawn happens on the next call
    for (const call of [
        () => plugin.executeTool('computer_click', { observation_id: id, element_index: 1 }),
        () => plugin.executeTool('computer_type', { observation_id: id, text: 'x' })
    ]) {
        const out = await call();
        assert.match(out, /worker_restarted/);
        assert.match(out, /重启|退出/);
        assert.match(out, /动作没有发送/);
        assert.doesNotMatch(out, /已经执行过动作/);
        assert.doesNotMatch(out, /worker_crashed/);
    }
    assert.equal(worker.callsOf('click').length, 0);
    assert.equal(worker.callsOf('type_text').length, 0);
});

test('plugin: crash event after an exit event does not rewrite the cause', async t => {
    const { plugin, worker, cleanup } = await setup();
    t.after(cleanup);
    const id = await observed(plugin);
    worker.emit('invalidate', { generation: worker.generation, reason: 'exited' });
    worker.emit('crash', { code: 1 });
    const out = await plugin.executeTool('computer_click', { observation_id: id, element_index: 1 });
    assert.match(out, /worker_restarted/);
    assert.doesNotMatch(out, /已经执行过动作/);
});

test('worker out_of_screen rejection: explained, nothing was sent, result known, no state invalidation', async t => {
    const { plugin, worker, cleanup } = await setup();
    t.after(cleanup);
    const id = await observed(plugin);
    worker.failNext = {
        op: 'click', code: 'out_of_screen', error: '(9999,5) 不在屏幕范围 x∈[0,1919] y∈[0,1079] 内，已拒绝，没有发送任何输入',
        details: { yielded: false, waited_ms: 0, injected: false, result_known: true, stopped_reason: null, requested: { x: 9999, y: 5 } }
    };
    const out = await plugin.executeTool('computer_click', { observation_id: id, element_index: 1 });
    assert.match(out, /电脑操作失败（out_of_screen）/);
    assert.match(out, /没有发送任何输入/);
    assert.match(out, /重新 computer_observe/);
    assert.equal(plugin.lastOutcome.resultKnown, true);
    assert.equal(plugin.lastOutcome.code, 'out_of_screen');
    assert.equal(worker.callsOf('click').length, 1, 'never retried');
});

test('computer_doctor shows whether the worker has its own coordinate validation', async t => {
    const { plugin, worker, cleanup } = await setup();
    t.after(cleanup);
    worker.hello = { ...worker.hello, protocol: 2, capabilities: { user_idle_yield: true, segmented_typing: true, clipboard_typing_segmented: false, coordinate_validation: true } };
    assert.match(await plugin.executeTool('computer_doctor', {}), /worker 坐标范围校验=有/);
    worker.hello = { ...worker.hello, capabilities: { user_idle_yield: true, segmented_typing: true, clipboard_typing_segmented: false } };
    assert.match(await plugin.executeTool('computer_doctor', {}), /worker 坐标范围校验=无（旧版 worker，只有插件层校验）/);
});
