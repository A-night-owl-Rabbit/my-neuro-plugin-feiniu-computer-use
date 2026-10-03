'use strict';

// Plugin-level protocol tests for owner-yield, partial typing, unknown results and generation
// invalidation. Everything runs against FakeWorker: no desktop, no Python.
const test = require('node:test');
const assert = require('node:assert/strict');
const { WorkerError } = require('../lib/worker-client.js');
const { BANNER_ELEMENT_ID } = require('../lib/banner.js');
const { setup, ownerTurn, readAudit } = require('./plugin-harness.js');

const SECRET = '绝密口令hunter2';

async function observed(plugin, windowId = 100) {
    await ownerTurn(plugin);
    await plugin.executeTool('computer_observe', { window_id: windowId, include_ui_tree: true });
    return plugin.observations.latest().id;
}

test('owner active before typing: nothing typed, yield is explained as 让位 and the old observation is gone', async t => {
    const { plugin, worker, cleanup, bannerEvents, dataDir } = await setup();
    t.after(cleanup);
    const id = await observed(plugin);
    worker.failNext = {
        op: 'type_text', code: 'user_active', error: '主人正在操作电脑（键盘），已等待 3000ms 仍未停手，本次没有发送任何输入',
        details: { yielded: true, waited_ms: 3000, yield_source: 'keyboard', typed: 0, input_total: [...SECRET].length, injected: false, result_known: true, stopped_reason: 'user_active', generation: 1 }
    };
    const out = await plugin.executeTool('computer_type', { observation_id: id, text: SECRET });
    assert.match(out, /电脑操作失败（user_active）/);
    assert.match(out, /尚未输入（0\/\d+ 字）/);
    assert.match(out, /等待主人停手 3000ms，主人一直没停/);
    assert.match(out, /让位，不是故障/);
    assert.match(out, /重新 computer_observe/);
    assert.doesNotMatch(out, /hunter2/);
    assert.equal(plugin.observations.latest().consumed, true);
    assert.equal(plugin.banner.state, 'paused');
    assert.doesNotMatch(JSON.stringify(bannerEvents), /hunter2/);
    assert.equal(plugin.lastStop.reason, 'user_active');
    assert.equal(worker.callsOf('type_text').length, 1, 'never retried by the plugin');
    assert.doesNotMatch(readAudit(dataDir), /hunter2/);
});

test('owner takes over mid text: the receipt says exactly how much was typed and to only add the rest', async t => {
    const { plugin, worker, cleanup, bannerEvents, dataDir } = await setup();
    t.after(cleanup);
    const id = await observed(plugin);
    worker.failNext = {
        op: 'type_text', code: 'user_active', error: '主人开始操作（键盘），已停止后续输入（已输入 32/100 字）',
        details: { yielded: true, waited_ms: 0, yield_source: 'system_input', typed: 32, input_total: 100, completed: false, injected: true, result_known: true, stopped_reason: 'user_active', foreground: { process_name: 'notepad.exe', id: 100, title: SECRET }, cursor: { x: 10, y: 20 }, generation: 1 }
    };
    const out = await plugin.executeTool('computer_type', { observation_id: id, text: SECRET.repeat(10) });
    assert.match(out, /部分输入：32\/100 字，其余没有输入/);
    assert.match(out, /只补输入缺少的部分/);
    assert.match(out, /光标=\(10,20\)/);
    assert.match(out, /执行后前台=notepad\.exe/);
    assert.doesNotMatch(out, /已输入全部/);
    assert.doesNotMatch(out, /hunter2/);
    const pause = bannerEvents.filter(e => e.method === 'pause').at(-1);
    assert.match(pause.arg, /已输入 32\/100 字/);
    const audit = readAudit(dataDir);
    assert.match(audit, /"typed":32/);
    assert.match(audit, /"input_total":100/);
    assert.match(audit, /"stopped_reason":"user_active"/);
    assert.doesNotMatch(audit, /hunter2/, 'no input plaintext, not even through the window title');
    assert.equal(plugin.lastOutcome.typed, 32);
});

test('Esc during typing is reported as Esc with the partial count and stops the turn', async t => {
    const { plugin, worker, cleanup, bannerEvents } = await setup();
    t.after(cleanup);
    const id = await observed(plugin);
    worker.failNext = { op: 'type_text', code: 'aborted', error: '主人按了 Esc，已停止后续输入（已输入 16/64 字）', details: { typed: 16, input_total: 64, completed: false, injected: true, result_known: true, stopped_reason: 'esc', generation: 1 } };
    const out = await plugin.executeTool('computer_type', { observation_id: id, text: 'a'.repeat(64) });
    assert.match(out, /部分输入：16\/64 字/);
    assert.match(out, /Esc/);
    assert.equal(plugin.gate.aborted.reason, '主人按了 Esc');
    assert.match(await plugin.executeTool('computer_observe', { window_id: 100 }), /中断/);
    assert.equal(bannerEvents.filter(e => e.method === 'stop').at(-1).arg, '肥牛已停手（Esc，已输入 16/64 字）');
});

test('timeout: result unknown, no automatic replay, old observation and parked actions are dead', async t => {
    const { plugin, worker, cleanup } = await setup();
    t.after(cleanup);
    const id = await observed(plugin);
    worker.failNext = { op: 'click', code: 'timeout', error: '桌面操作 click 超时 (15000ms)，worker 已重启，结果未知', resultKnown: false };
    const out = await plugin.executeTool('computer_click', { observation_id: id, element_index: 1 });
    assert.match(out, /电脑操作失败（timeout）/);
    assert.match(out, /动作结果未知/);
    assert.match(out, /不要自动重试点击、提交、发送、关闭、删除或付款/);
    assert.equal(plugin.lastOutcome.resultKnown, false);
    assert.equal(plugin.lastStop.reason, 'timeout');
    assert.equal(worker.callsOf('click').length, 1, 'the plugin never replays an action whose result is unknown');
    const again = await plugin.executeTool('computer_click', { observation_id: id, element_index: 1 });
    assert.match(again, /已过期|之后已经执行过动作|作废/);
    assert.equal(worker.callsOf('click').length, 1);
    assert.equal(plugin.banner.state, 'stopped');
    assert.match(plugin.banner.text, /结果未确认/);
});

test('worker crash during an action is the same: unknown, invalidated, never replayed', async t => {
    const { plugin, worker, cleanup } = await setup();
    t.after(cleanup);
    const id = await observed(plugin);
    worker.failNext = { op: 'press_key', code: 'worker_exited', error: 'worker 已退出 (code=3)', resultKnown: false };
    const out = await plugin.executeTool('computer_press_key', { observation_id: id, key: 'enter' });
    assert.match(out, /worker_exited/);
    assert.match(out, /执行层出错/);
    assert.match(out, /结果未知/);
    assert.equal(worker.callsOf('press_key').length, 1);
});

test('a worker-side internal error after injection is unknown; before injection it is known', async t => {
    const { plugin, worker, cleanup } = await setup();
    t.after(cleanup);
    let id = await observed(plugin);
    worker.failNext = { op: 'click', code: 'internal', error: 'RuntimeError: native', details: { injected: true, result_known: false, stopped_reason: 'worker_error' } };
    let out = await plugin.executeTool('computer_click', { observation_id: id, x: 1, y: 1 });
    assert.match(out, /结果未知/);
    id = await observed(plugin);
    worker.failNext = { op: 'click', code: 'internal', error: 'RuntimeError: early', details: { injected: false, result_known: true, stopped_reason: 'worker_error' } };
    out = await plugin.executeTool('computer_click', { observation_id: id, x: 1, y: 1 });
    assert.match(out, /动作没有生效/);
    assert.doesNotMatch(out, /结果未知/);
});

test('worker restart (generation change) kills observations, parked actions and the last-window shortcut', async t => {
    const { plugin, worker, cleanup } = await setup({ autonomous_control: false, always_allowed_apps: 'notepad.exe' });
    t.after(cleanup);
    await ownerTurn(plugin);
    await plugin.executeTool('computer_observe', { window_id: 100, include_ui_tree: true });
    const id = plugin.observations.latest().id;
    await plugin.executeTool('computer_press_key', { observation_id: id, key: 'alt+f4' });
    assert.equal(plugin.pending.size(), 1, 'a close chord is parked in the legacy mode');
    const pendingId = plugin.pending.list()[0].id;
    assert.ok(plugin.lastWindowId);

    worker.restart('exited');
    assert.equal(plugin.pending.size(), 0);
    assert.equal(plugin.lastWindowId, null);
    assert.equal(plugin.observations.latest().consumed, true);
    const refused = await plugin.executeTool('computer_press_key', { observation_id: id, key: 'enter' });
    assert.match(refused, /重启|失效|作废|已经执行过动作|过期/);
    assert.equal(worker.callsOf('press_key').length, 0);
    assert.match(await plugin.executeTool('computer_confirm_action', { pending_action_id: pendingId }), /找不到待确认动作/);
});

test('a generation change without any event is still caught by the observation itself', async t => {
    const { plugin, worker, cleanup } = await setup();
    t.after(cleanup);
    const id = await observed(plugin);
    worker.generation = 2; // e.g. the worker silently respawned on the previous call
    const out = await plugin.executeTool('computer_click', { observation_id: id, element_index: 1 });
    assert.match(out, /重启或失效/);
    assert.equal(worker.callsOf('click').length, 0);
});

test('worker restarts between observation validation and injection: refused, nothing sent', async t => {
    const { plugin, worker, cleanup } = await setup();
    t.after(cleanup);
    const id = await observed(plugin);
    const original = worker.call.bind(worker);
    worker.call = async (op, args, options) => {
        const result = await original(op, args, options);
        if (op === 'activate_window' && worker.generation === 1) worker.generation = 2; // respawned during activation
        return result;
    };
    const out = await plugin.executeTool('computer_click', { observation_id: id, element_index: 1 });
    assert.match(out, /worker_restarted/);
    assert.match(out, /本次动作没有发送/);
    assert.equal(worker.callsOf('click').length, 0);
});

test('Esc while an action is in flight: the late receipt is marked stale and nothing is auto-observed', async t => {
    const { plugin, worker, cleanup } = await setup();
    t.after(cleanup);
    const id = await observed(plugin);
    const shots = plugin.screenshots.captures;
    worker.nextResult = { op: 'click', fn: (args, w) => { w.emit('event:esc_pressed', { event: 'esc_pressed' }); return { ...args, yielded: false, waited_ms: 0, result_known: true }; } };
    const out = await plugin.executeTool('computer_click', { observation_id: id, element_index: 1 });
    assert.match(out, /^已发出：/);
    assert.match(out, /回执可能已过期/);
    assert.equal(typeof out, 'string', 'no auto-observation screenshot after an interrupted action');
    assert.equal(plugin.screenshots.captures, shots);
    assert.equal(plugin.gate.aborted !== null, true);
});

test('a restart signalled while an action is in flight makes its late receipt stale; computer_stop bumps the epoch too', async t => {
    const { plugin, worker, cleanup } = await setup();
    t.after(cleanup);
    const id = await observed(plugin);
    const before = plugin.epoch;
    worker.nextResult = { op: 'click', fn: (args, w) => { w.restart('exited'); return args; } };
    const out = await plugin.executeTool('computer_click', { observation_id: id, element_index: 1 });
    assert.ok(plugin.epoch > before);
    assert.match(out, /^已发出：/);
    assert.match(out, /回执可能已过期/);
    const afterRestart = plugin.epoch;
    await plugin.executeTool('computer_stop', { reason: '主人说停' });
    assert.ok(plugin.epoch > afterRestart, 'computer_stop invalidates in-flight receipts as well');
});

test('successful action carries the unified fact block into the tool text, banner and audit', async t => {
    const { plugin, worker, cleanup, bannerEvents, dataDir } = await setup();
    t.after(cleanup);
    const id = await observed(plugin);
    worker.nextResult = {
        op: 'type_text', result: { typed: 4, input_total: 4, completed: true, mode: 'sendinput', yielded: false, waited_ms: 1200, injected: true, result_known: true, stopped_reason: null, generation: 1, foreground: { process_name: 'notepad.exe', id: 100, title: '无标题 - 记事本' }, cursor: { x: 3, y: 4 } }
    };
    const out = await plugin.executeTool('computer_type', { observation_id: id, text: '四个字符', observe_after: false });
    assert.match(out, /^已执行：输入文字/);
    assert.match(out, /等待主人停手 1200ms，之后继续执行/);
    assert.match(out, /已输入全部 4\/4 字/);
    assert.match(out, /光标=\(3,4\)/);
    assert.doesNotMatch(out, /动作结果未知/);
    assert.equal(bannerEvents.filter(e => e.method === 'start').at(-1).arg, '输入文字（4 字）', 'banner returns to the step text after waiting');
    const audit = readAudit(dataDir);
    assert.match(audit, /"waited_ms":1200/);
    assert.doesNotMatch(audit, /四个字符/);
    assert.equal(plugin.lastOutcome.resultKnown, true);
});

test('user_wait event pauses the banner without leaking text; the action then resumes it', async t => {
    const { plugin, worker, cleanup, document } = await setup();
    t.after(cleanup);
    const id = await observed(plugin);
    worker.nextResult = {
        op: 'click', fn: (args, w) => {
            w.emit('event:user_wait', { event: 'user_wait', source: 'system_input', max_wait_ms: 3000 });
            assert.equal(plugin.banner.state, 'paused');
            assert.match(plugin.banner.text, /等待主人停手/);
            return { ...args, waited_ms: 800, yielded: false };
        }
    };
    await plugin.executeTool('computer_click', { observation_id: id, element_index: 1, observe_after: false });
    assert.equal(plugin.banner.state, 'active');
    assert.ok(document.getElementById(BANNER_ELEMENT_ID));
});

test('a successful reply that claims result_known=false is surfaced, not hidden', async t => {
    const { plugin, worker, cleanup } = await setup();
    t.after(cleanup);
    const id = await observed(plugin);
    worker.nextResult = { op: 'click', result: { result_known: false, stopped_reason: 'worker_error', injected: true } };
    const out = await plugin.executeTool('computer_click', { observation_id: id, element_index: 1, observe_after: false });
    assert.match(out, /动作结果未知/);
    assert.match(out, /不要直接重复这一步/);
});

test('timeouts: yielding ops get the wait allowance, long typing gets a larger bounded budget', async t => {
    const { plugin, worker, cleanup } = await setup({ action_timeout_ms: 5000, user_idle_max_wait_ms: 4000 });
    t.after(cleanup);
    const id = await observed(plugin);
    await plugin.executeTool('computer_click', { observation_id: id, element_index: 1, observe_after: false });
    const click = worker.callOptions.filter(c => c.op === 'click').at(-1);
    assert.equal(click.options.timeoutMs, 5000 + 4000);
    const id2 = await observed(plugin);
    await plugin.executeTool('computer_type', { observation_id: id2, text: 'x'.repeat(2000), observe_after: false });
    const type = worker.callOptions.filter(c => c.op === 'type_text').at(-1);
    assert.ok(type.options.timeoutMs > 9000 && type.options.timeoutMs <= 300000 + 4000, `type timeout ${type.options.timeoutMs}`);
    const info = worker.callOptions.filter(c => c.op === 'window_info').at(-1);
    assert.equal(info.options.timeoutMs, 5000, 'read-only ops get no allowance');
});

test('yield switched off: no allowance is added', async t => {
    const { plugin, worker, cleanup } = await setup({ action_timeout_ms: 5000, user_idle_yield: false });
    t.after(cleanup);
    const id = await observed(plugin);
    await plugin.executeTool('computer_click', { observation_id: id, element_index: 1, observe_after: false });
    assert.equal(worker.callOptions.filter(c => c.op === 'click').at(-1).options.timeoutMs, 5000);
});

test('yield/typing parameters are pushed to a running worker without a restart or invalidation', async t => {
    const { plugin, worker, context, cleanup } = await setup();
    t.after(cleanup);
    const id = await observed(plugin);
    const raw = context.getPluginFileConfig();
    raw.user_idle_ms = 900;
    raw.user_idle_max_wait_ms = 7000;
    raw.type_chunk_size = 8;
    await plugin.onConfigChanged();
    const configure = worker.callsOf('configure').at(-1);
    assert.deepEqual(configure.args, { user_idle_yield: true, user_idle_ms: 900, user_idle_max_wait_ms: 7000, type_chunk_size: 8, type_chunk_gap_ms: 100 });
    assert.equal(worker.stopped, false, 'no restart');
    assert.equal(plugin.worker, worker);
    assert.equal(plugin.observations.latest().consumed, false, 'observation survives a harmless tuning change');
    assert.equal(plugin.observations.validate(id).ok, true);
    assert.equal(worker.helloArgs.user_idle_ms, 900, 'a later restart starts with the new values');
});

test('new workers are started with the yield parameters and out-of-range config is clamped', async t => {
    const { plugin, cleanup } = await setup({ user_idle_ms: 1, user_idle_max_wait_ms: 999999, type_chunk_size: 0, type_chunk_gap_ms: 5000 });
    t.after(cleanup);
    const created = plugin._createWorker('fake.exe');
    assert.deepEqual(
        [created.helloArgs.user_idle_yield, created.helloArgs.user_idle_ms, created.helloArgs.user_idle_max_wait_ms, created.helloArgs.type_chunk_size, created.helloArgs.type_chunk_gap_ms],
        [true, 100, 30000, 1, 1000]
    );
    assert.equal(created.helloArgs.autonomous_control, true);
});

test('prompt patch explains yield, partial typing and unknown results, within the size budget', async t => {
    const { context, cleanup } = await setup();
    t.after(cleanup);
    const patch = context.patches.get('computer-use-rules');
    assert.match(patch, /自动让位，不是故障/);
    assert.match(patch, /别整段重发/);
    assert.match(patch, /结果未知时先重新 computer_observe/);
    assert.match(patch, /不自动重试/);
    assert.ok(patch.length <= 1200);
});

test('computer_doctor reports yield parameters, generation, last stop reason and last result certainty', async t => {
    const { plugin, worker, cleanup } = await setup();
    t.after(cleanup);
    worker.hello = { ...worker.hello, version: '0.2.0', protocol: 2, generation: 1, capabilities: { user_idle_yield: true, segmented_typing: true, clipboard_typing_segmented: false } };
    const id = await observed(plugin);
    worker.failNext = { op: 'click', code: 'timeout', error: 'x', resultKnown: false };
    await plugin.executeTool('computer_click', { observation_id: id, element_index: 1 });
    const doctor = await plugin.executeTool('computer_doctor', {});
    assert.match(doctor, /protocol 2，generation 1，累计重启 0 次/);
    assert.match(doctor, /分段输入=有，剪贴板模式可分段=否/);
    assert.match(doctor, /让位参数（配置）：开启，主人静止 ≥500ms 才动手，最长等待 3000ms，文字每 16 字一段、段间隔 100ms/);
    assert.match(doctor, /最近一次停止\/让位原因：执行超时/);
    assert.match(doctor, /最近一次动作结果：computer_click 失败\(timeout\)，结果未知/);
    worker.hello = { ...worker.hello, capabilities: undefined, protocol: undefined };
    assert.match(await plugin.executeTool('computer_doctor', {}), /worker 过旧/);
});

test('autonomous default, trusted-source boundary and Esc rules are untouched by the new protocol', async t => {
    const { plugin, worker, cleanup } = await setup({ autonomous_control: undefined });
    t.after(cleanup);
    assert.equal(plugin.config.autonomous_control, true);
    await plugin.onUserInput({ source: 'barrage', text: '点一下' });
    await plugin.onLLMRequest({ messages: [{ role: 'user', content: '点一下' }] });
    assert.match(await plugin.executeTool('computer_observe', { window_id: 100 }), /可信回合/);
    await ownerTurn(plugin);
    await plugin.executeTool('computer_observe', { window_id: 100 });
    worker.emit('event:esc_pressed', {});
    assert.match(await plugin.executeTool('computer_observe', { window_id: 100 }), /中断/);
    assert.equal(worker.callsOf('click').length, 0);
});
