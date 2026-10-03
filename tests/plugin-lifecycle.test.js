'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Plugin = require('../index.js');
const { TOOLS } = require('../lib/tool-definitions.js');
const { ComputerUseBanner, BANNER_ELEMENT_ID, BANNER_TITLE } = require('../lib/banner.js');
const { FakeWorker, FakeScreenshots, makeContext, makeWindow, makeFakeClock, makeFakeDocument } = require('./fake-worker.js');

const POWERSHELL = makeWindow({ id: 200, title: 'Windows PowerShell', class_name: 'ConsoleWindowClass', process_name: 'powershell.exe', process_path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', is_foreground: false });
const PAINT = makeWindow({ id: 300, title: '无标题 - 画图', class_name: 'MSPaintApp', process_name: 'mspaint.exe', process_path: 'C:\\Windows\\System32\\mspaint.exe', is_foreground: false });
const UNKNOWN_APP = makeWindow({ id: 400, title: 'Some Tool', class_name: 'X', process_name: 'sometool.exe', process_path: 'D:\\tools\\sometool.exe', is_foreground: false });

async function setup(pluginConfig = {}, workerOptions = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feiniu-cu-test-'));
    // Existing scenarios exercise the opt-in legacy restricted mode.
    const context = makeContext({ autonomous_control: false, always_allowed_apps: 'notepad.exe', ...pluginConfig });
    const plugin = new Plugin({ name: 'feiniu-computer-use' }, context);
    plugin.dataDir = dataDir;
    await plugin.onInit();
    // Swap in a banner with a fake DOM and a fake clock so the top bar can be asserted on.
    const clock = makeFakeClock();
    const document = makeFakeDocument();
    const bannerEvents = [];
    plugin.banner = new ComputerUseBanner({
        config: plugin.config,
        document,
        ipcRenderer: null,
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        requestAnimationFrame: fn => clock.setTimeout(fn, 16),
        isEditing: () => false
    });
    for (const method of ['start', 'waitConfirm', 'pause', 'stop', 'finish', 'reset']) {
        const original = plugin.banner[method].bind(plugin.banner);
        plugin.banner[method] = (...args) => {
            const state = original(...args);
            bannerEvents.push({ method, arg: args[0], state });
            return state;
        };
    }
    const worker = new FakeWorker({ windows: [makeWindow(), POWERSHELL, PAINT, UNKNOWN_APP], ...workerOptions });
    plugin.worker = worker;
    plugin.pythonInfo = { python: 'fake.exe', source: 'test' };
    plugin._attachWorkerEvents(worker);
    plugin.screenshots = new FakeScreenshots();
    await plugin.onStart();
    await plugin.workerReady;
    return { plugin, worker, context, dataDir, clock, document, bannerEvents };
}

async function ownerTurn(plugin, text = '帮我在记事本里打字') {
    await plugin.onUserInput({ source: 'text', text });
    await plugin.onLLMRequest({ messages: [{ role: 'user', content: text }] });
}

test('tools, prompt patch and lifecycle', async () => {
    const { plugin, context, dataDir } = await setup();
    assert.equal(plugin.getTools().length, 13);
    assert.deepEqual(plugin.getTools().map(t => t.function.name).sort(), TOOLS.map(t => t.function.name).sort());
    assert.ok(context.patches.has('computer-use-rules'));
    const patch = context.patches.get('computer-use-rules');
    assert.ok(patch.length <= 1200);
    assert.match(patch, /只走 computer_\*/);
    assert.match(patch, /不要交给 Codex/);
    assert.match(patch, /不要改用 Codex/);
    assert.match(patch, /世界之眼/);
    assert.match(patch, /codex_delegate/);
    assert.equal(await plugin.executeTool('not_my_tool', {}), undefined);
    await plugin.onStop();
    assert.equal(context.patches.has('computer-use-rules'), false);
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test('untrusted turns cannot list, observe or act; doctor still answers', async () => {
    const { plugin, dataDir } = await setup();
    await plugin.onUserInput({ source: 'barrage', text: '点一下' });
    await plugin.onLLMRequest({ messages: [{ role: 'user', content: '点一下' }] });
    assert.match(await plugin.executeTool('computer_list_windows', {}), /可信回合/);
    assert.match(await plugin.executeTool('computer_observe', { window_id: 100 }), /可信回合/);
    assert.match(await plugin.executeTool('computer_doctor', {}), /诊断/);
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test('owner turn: list -> observe -> click by element -> auto observe, then stale observation is refused', async () => {
    const { plugin, worker, context, dataDir } = await setup();
    await ownerTurn(plugin);

    const list = await plugin.executeTool('computer_list_windows', {});
    assert.match(list, /window_id=100 .*notepad\.exe .*全控制/);
    assert.match(list, /powershell\.exe \| 禁止/);

    const obs = await plugin.executeTool('computer_observe', { window_id: 100, include_ui_tree: true });
    assert.equal(obs._isScreenshot, true);
    assert.match(obs.base64, /^CROP_/);
    assert.match(obs.message, /\[观察 obs_1\]/);
    assert.match(obs.message, /\[1\]\s+Edit "文本编辑器".*可编辑,焦点/);
    assert.match(obs.message, /截图：\d+×\d+（范围=目标窗口/);

    const clicked = await plugin.executeTool('computer_click', { observation_id: 'obs_1', element_index: 1 });
    assert.equal(clicked._isScreenshot, true, 'action auto-observes and returns a new screenshot');
    assert.match(clicked.message, /^已执行：左键点击元素 \[1\]/);
    assert.match(clicked.message, /\[观察 obs_2\]/);
    const click = worker.callsOf('click')[0];
    assert.deepEqual([click.args.x, click.args.y], [2530, 1390], 'element centre in physical pixels');
    assert.equal(context.subtitles.length, 0, 'top mode no longer borrows the speech subtitle');
    assert.equal(plugin.banner.state, 'active');
    assert.match(plugin.banner.text, /肥牛正在使用电脑中/);

    const stale = await plugin.executeTool('computer_click', { observation_id: 'obs_1', element_index: 1 });
    assert.match(stale, /已过期|之后已经执行过动作/);
    assert.equal(worker.callsOf('click').length, 1, 'stale click did not reach the worker');

    // coordinate click maps screenshot pixels back to the window on screen
    const shot = await plugin.executeTool('computer_observe', { window_id: 100 });
    const latest = plugin.observations.latest();
    const out = await plugin.executeTool('computer_click', { observation_id: latest.id, x: 0, y: 0, observe_after: false });
    assert.match(out, /已执行：左键点击截图坐标/);
    const coordClick = worker.callsOf('click')[1];
    assert.deepEqual([coordClick.args.x, coordClick.args.y], [1578, 759]);
    assert.ok(shot._isScreenshot);
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test('typing requires an editable focus and a fresh observation; newline text is accepted', async () => {
    const { plugin, worker, dataDir } = await setup();
    await ownerTurn(plugin);
    await plugin.executeTool('computer_observe', { window_id: 100, include_ui_tree: true });
    const typed = await plugin.executeTool('computer_type', { observation_id: 'obs_1', text: '肥牛电脑操作演示', observe_after: false });
    assert.match(typed, /已执行：输入文字/);
    assert.equal(worker.callsOf('type_text')[0].args.text, '肥牛电脑操作演示');

    // focus on a non-editable element -> refused before reaching the worker
    worker.trees[100] = { ...worker.trees[100], focused_element: { index: 3, type: 'MenuItemControl', name: '格式(O)', editable: false, rect: { left: 1, top: 1, right: 2, bottom: 2 } } };
    await plugin.executeTool('computer_observe', { window_id: 100, include_ui_tree: true });
    const refused = await plugin.executeTool('computer_type', { observation_id: plugin.observations.latest().id, text: 'x' });
    assert.match(refused, /焦点不在可编辑控件/);
    assert.equal(worker.callsOf('type_text').length, 1);
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test('hard denies: Win key, terminal window, denied launch targets', async () => {
    const { plugin, worker, dataDir } = await setup();
    await ownerTurn(plugin);
    await plugin.executeTool('computer_observe', { window_id: 100 });
    const winKey = await plugin.executeTool('computer_press_key', { observation_id: 'obs_1', key: 'win+d' });
    assert.match(winKey, /Windows 键/);
    assert.equal(worker.callsOf('press_key').length, 0);

    const terminal = await plugin.executeTool('computer_observe', { window_id: 200 });
    assert.match(terminal, /禁区/);
    assert.equal(worker.callsOf('activate_window').filter(c => c.args.id === 200).length, 0);

    const cmd = await plugin.executeTool('computer_launch_app', { target: 'cmd' });
    assert.match(cmd, /禁区|不能启动/);
    assert.equal(worker.callsOf('launch_app').length, 0);
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test('first use of an unknown app asks for confirmation; confirm executes and remembers', async () => {
    const { plugin, worker, dataDir } = await setup();
    await ownerTurn(plugin);
    worker.trees[400] = worker.trees[100];
    await plugin.executeTool('computer_observe', { window_id: 400, include_ui_tree: true });
    const parked = await plugin.executeTool('computer_click', { observation_id: 'obs_1', element_index: 1 });
    assert.match(parked, /需要主人确认/);
    assert.match(parked, /第一次操作 sometool\.exe/);
    const id = /待确认动作 ID：(\S+)/.exec(parked)[1];
    assert.equal(worker.callsOf('click').length, 0);

    const executed = await plugin.executeTool('computer_confirm_action', { pending_action_id: id, remember_app: true });
    assert.ok(executed._isScreenshot);
    assert.equal(worker.callsOf('click').length, 1);
    assert.equal(plugin.policy.sessionAllowed.has('sometool.exe'), true);

    // second action in the same app: no more confirmation
    const again = await plugin.executeTool('computer_click', { observation_id: plugin.observations.latest().id, element_index: 1, observe_after: false });
    assert.match(again, /已执行/);
    assert.equal(worker.callsOf('click').length, 2);

    assert.match(await plugin.executeTool('computer_confirm_action', { pending_action_id: 'cu_nope' }), /找不到待确认动作/);
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test('close chords and confirm_each apps are parked; cancel drops them', async () => {
    const { plugin, worker, dataDir } = await setup();
    await ownerTurn(plugin);
    await plugin.executeTool('computer_observe', { window_id: 100 });
    const parked = await plugin.executeTool('computer_press_key', { observation_id: 'obs_1', key: 'alt+f4' });
    assert.match(parked, /关闭窗口/);
    assert.equal(worker.callsOf('press_key').length, 0);
    assert.match(await plugin.executeTool('computer_cancel_action', {}), /已取消 1 个/);
    assert.equal(plugin.pending.size(), 0);
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test('computer_stop and Esc events block further actions until the owner speaks again', async () => {
    const { plugin, worker, dataDir } = await setup();
    await ownerTurn(plugin);
    await plugin.executeTool('computer_observe', { window_id: 100 });
    assert.match(await plugin.executeTool('computer_stop', { reason: '主人说停' }), /已停止/);
    assert.match(await plugin.executeTool('computer_observe', { window_id: 100 }), /中断/);

    await ownerTurn(plugin, '继续');
    await plugin.executeTool('computer_observe', { window_id: 100 });
    worker.emit('event:esc_pressed', { event: 'esc_pressed' });
    const blocked = await plugin.executeTool('computer_click', { observation_id: plugin.observations.latest().id, x: 1, y: 1 });
    assert.match(blocked, /已经执行过动作|中断|过期/);
    assert.equal(worker.callsOf('click').length, 0);
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test('worker errors are translated into guidance (aborted, user_active, timeout)', async () => {
    const { plugin, worker, dataDir } = await setup();
    await ownerTurn(plugin);
    await plugin.executeTool('computer_observe', { window_id: 100 });
    worker.failNext = { op: 'click', code: 'user_active', error: '主人正在使用鼠标' };
    const out = await plugin.executeTool('computer_click', { observation_id: 'obs_1', x: 10, y: 10 });
    assert.match(out, /user_active/);
    assert.match(out, /重新 computer_observe/);
    assert.equal(plugin.observations.latest().consumed, true);
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test('launch_app: alias launches directly, explicit path needs confirmation, budget is counted', async () => {
    const { plugin, worker, dataDir } = await setup({ max_actions_per_turn: 3 });
    await ownerTurn(plugin);
    const launched = await plugin.executeTool('computer_launch_app', { target: '记事本' });
    assert.match(launched, /已启动 记事本.*window_id=500/);
    assert.equal(plugin.lastWindowId, 500);

    const parked = await plugin.executeTool('computer_launch_app', { target: 'D:\\tools\\weird.exe' });
    assert.match(parked, /需要主人确认/);
    assert.equal(worker.callsOf('launch_app').length, 1);

    // observe without window_id follows the last launched window
    const obs = await plugin.executeTool('computer_observe', {});
    assert.match(obs.message, /window_id=500/);
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test('top banner follows observe -> click -> type -> final response, never shows typed text, then lingers out', async () => {
    const { plugin, document, clock, bannerEvents, dataDir } = await setup();
    const root = document.getElementById(BANNER_ELEMENT_ID);
    assert.ok(root, 'banner mounted into the page on onStart');
    assert.equal(plugin.banner.state, 'hidden');

    await ownerTurn(plugin, '在记事本里打字');
    await plugin.executeTool('computer_observe', { window_id: 100, include_ui_tree: true });
    assert.equal(plugin.banner.state, 'active');
    assert.match(plugin.banner.text, new RegExp(`^${BANNER_TITLE} · 正在观察 无标题 - 记事本 · 按 Esc 停止$`));
    assert.equal(root.style.display, 'flex');

    await plugin.executeTool('computer_click', { observation_id: 'obs_1', element_index: 1, observe_after: false });
    assert.match(bannerEvents.map(e => e.arg).join('|'), /左键点击元素 \[1\]/);

    await plugin.executeTool('computer_observe', { window_id: 100, include_ui_tree: true });
    await plugin.executeTool('computer_type', { observation_id: plugin.observations.latest().id, text: '秘密内容', observe_after: false });
    const typeStep = bannerEvents.filter(e => e.method === 'start').map(e => e.arg).find(a => /输入文字/.test(a));
    assert.equal(typeStep, '输入文字（4 字）');
    assert.doesNotMatch(bannerEvents.map(e => e.arg).join('|'), /秘密内容/);
    assert.equal(root.querySelector('.cu-banner-step').textContent, '输入文字（4 字）');

    await plugin.onLLMResponse({ text: '好啦' });
    assert.equal(plugin.banner.state, 'active', 'still lingering right after the final reply');
    clock.advance(1500);
    assert.equal(plugin.banner.state, 'hidden');
    clock.advance(400);
    assert.equal(root.style.display, 'none');

    // a new owner instruction resets any leftovers immediately
    await plugin.executeTool('computer_observe', { window_id: 100 });
    await ownerTurn(plugin, '换个话题');
    assert.equal(plugin.banner.state, 'hidden');
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test('top banner: waiting on first-use confirmation, stopped on Esc, hidden for barrage turns, removed on onStop', async () => {
    const { plugin, worker, document, clock, dataDir } = await setup();
    await ownerTurn(plugin);
    worker.trees[400] = worker.trees[100];
    await plugin.executeTool('computer_observe', { window_id: 400, include_ui_tree: true });
    const parked = await plugin.executeTool('computer_click', { observation_id: 'obs_1', element_index: 1 });
    assert.equal(plugin.banner.state, 'waiting');
    assert.match(plugin.banner.text, /等你点头：左键点击元素 \[1\]/);
    const id = /待确认动作 ID：(\S+)/.exec(parked)[1];
    await plugin.executeTool('computer_confirm_action', { pending_action_id: id, remember_app: true });
    assert.equal(plugin.banner.state, 'active', 'back to active once the confirmed action runs');

    worker.emit('event:esc_pressed', { event: 'esc_pressed' });
    assert.equal(plugin.banner.state, 'stopped');
    assert.equal(plugin.banner.text, '肥牛已停手（Esc）');
    clock.advance(2000);
    assert.equal(plugin.banner.state, 'hidden');

    await plugin.onUserInput({ source: 'barrage', text: '点一下' });
    await plugin.onLLMRequest({ messages: [{ role: 'user', content: '点一下' }] });
    await plugin.executeTool('computer_observe', { window_id: 100 });
    assert.equal(plugin.banner.state, 'hidden', 'untrusted turns never light the banner');

    await ownerTurn(plugin, '停下');
    await plugin.executeTool('computer_observe', { window_id: 100 });
    await plugin.executeTool('computer_stop', { reason: '主人说停' });
    assert.equal(plugin.banner.state, 'stopped');

    await plugin.onStop();
    assert.equal(document.getElementById(BANNER_ELEMENT_ID), null);
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test('banner_mode=subtitle keeps the legacy subtitle flashes and leaves the top bar dark', async () => {
    const { plugin, context, worker, dataDir } = await setup({ banner_mode: 'subtitle' });
    await ownerTurn(plugin);
    await plugin.executeTool('computer_observe', { window_id: 100, include_ui_tree: true });
    await plugin.executeTool('computer_click', { observation_id: 'obs_1', element_index: 1, observe_after: false });
    assert.equal(plugin.banner.state, 'hidden');
    assert.ok(context.subtitles.some(s => /肥牛正在操作电脑：左键点击元素/.test(s.text)));
    worker.emit('event:esc_pressed', { event: 'esc_pressed' });
    assert.ok(context.subtitles.some(s => /肥牛已停手（Esc）/.test(s.text)));
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test('audit log is written to the injected data dir and never contains typed text by default', async () => {
    const { plugin, dataDir } = await setup();
    await ownerTurn(plugin);
    await plugin.executeTool('computer_observe', { window_id: 100, include_ui_tree: true });
    await plugin.executeTool('computer_type', { observation_id: 'obs_1', text: '秘密内容', observe_after: false });
    const files = fs.readdirSync(dataDir).filter(f => f.startsWith('action-log-'));
    assert.equal(files.length, 1);
    const content = fs.readFileSync(path.join(dataDir, files[0]), 'utf8');
    assert.match(content, /"event":"type"/);
    assert.doesNotMatch(content, /秘密内容/);
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test('default autonomous mode executes all confirmation paths without parking or asking', async t => {
    const { plugin, worker, context, dataDir, bannerEvents } = await setup({
        autonomous_control: undefined, // the production default, including old config files
        confirm_first_use_per_app: true, require_confirm_for_typing: true,
        require_confirm_for_enter: true, denied_apps: 'sometool.exe',
        app_tier_overrides: 'sometool.exe=deny', browser_tier: 'view_only'
    });
    t.after(async () => { await plugin.onStop(); fs.rmSync(dataDir, { recursive: true, force: true }); });
    assert.equal(plugin.config.autonomous_control, true);
    const tools = plugin.getTools();
    assert.equal(tools.length, 11);
    assert.equal(tools.some(tool => /computer_(confirm|cancel)_action/.test(tool.function.name)), false);
    assert.doesNotMatch(tools.find(tool => tool.function.name === 'computer_press_key').function.description, /禁止 Win|先请主人/);
    const patch = context.patches.get('computer-use-rules');
    assert.match(patch, /主人已授予本插件完整、自主的桌面操控权限/);
    assert.doesNotMatch(patch, /之前必须先问主人|主人明确同意后再调|不能做：终端/);
    await ownerTurn(plugin);

    worker.windows.set(600, makeWindow({ id: 600, process_name: 'explorer.exe' }));
    worker.windows.set(700, makeWindow({ id: 700, process_name: 'chrome.exe' }));
    worker.windows.set(800, makeWindow({ id: 800, process_name: 'electron.exe', is_self: true }));
    const list = await plugin.executeTool('computer_list_windows');
    assert.match(list, /powershell\.exe \| 全控制/);
    assert.match(list, /electron\.exe \| 全控制/);
    assert.equal(worker.callsOf('list_windows').at(-1).args.include_self, true);

    for (const [id, action, args, op] of [
        [400, 'click', { x: 1, y: 1 }, 'click'], // unknown app + explicit deny
        [600, 'click', { x: 1, y: 1 }, 'click'], // confirm_each
        [600, 'press_key', { key: 'shift+delete' }, 'press_key'],
        [700, 'press_key', { key: 'enter' }, 'press_key'],
        [700, 'type', { text: 'autonomy test' }, 'type_text'],
        [100, 'press_key', { key: 'alt+f4' }, 'press_key'],
        [200, 'press_key', { key: 'win+r' }, 'press_key'],
        [200, 'press_key', { key: 'ctrl+shift+esc' }, 'press_key'],
        [800, 'click', { x: 1, y: 1 }, 'click']
    ]) {
        const observed = await plugin.executeTool('computer_observe', { window_id: id });
        assert.equal(observed._isScreenshot, true);
        const before = worker.callsOf(op).length;
        const result = await plugin.executeTool(`computer_${action}`, {
            ...args, observation_id: plugin.observations.latest().id, observe_after: false
        });
        assert.match(result, /已执行/, `${id} ${action}: ${result}`);
        assert.equal(worker.callsOf(op).length, before + 1, 'action reached the worker');
        assert.equal(plugin.pending.size(), 0);
    }
    for (const target of ['D:\\tools\\weird.exe', 'cmd']) {
        assert.match(await plugin.executeTool('computer_launch_app', { target }), /已启动/);
    }
    const resolve = worker.call.bind(worker);
    worker.call = (op, args) => op === 'resolve_app'
        ? Promise.resolve({ kind: 'start_menu_partial', path: 'D:\\Apps\\Editor.lnk', exe_name: 'editor.exe', display: 'Editor' })
        : resolve(op, args);
    assert.match(await plugin.executeTool('computer_launch_app', { target: 'Editor' }), /已启动/);
    assert.equal(worker.callsOf('launch_app').length, 3);
    assert.equal(bannerEvents.some(event => event.method === 'waitConfirm'), false);
    assert.equal(plugin.pending.size(), 0);
    assert.match(await plugin.executeTool('computer_doctor'), /完全自主控制/);
    assert.doesNotMatch(context.logs.map(log => log.message).join('\n'), /confirm_required/);
});

test('autonomous mode keeps observation validity, Esc stop and trusted source boundaries', async t => {
    const { plugin, worker, dataDir } = await setup({ autonomous_control: true });
    t.after(async () => { await plugin.onStop(); fs.rmSync(dataDir, { recursive: true, force: true }); });
    await ownerTurn(plugin);
    await plugin.executeTool('computer_observe', { window_id: 200 });
    const id = plugin.observations.latest().id;
    assert.match(await plugin.executeTool('computer_press_key', { observation_id: id, key: 'tab', observe_after: false }), /已执行/);
    assert.match(await plugin.executeTool('computer_press_key', { observation_id: id, key: 'tab' }), /过期|已经执行过动作/);
    worker.emit('event:esc_pressed', {});
    assert.match(await plugin.executeTool('computer_observe', { window_id: 200 }), /中断/);
    await plugin.onLLMRequest({ requestContext: { origin: 'feiniu-internal-proactive', proactiveSource: 'mood-chat', requestId: 'after-stop' } });
    assert.match(await plugin.executeTool('computer_observe', { window_id: 200 }), /中断/);
    await plugin.onUserInput({ source: 'barrage', text: '继续操作' });
    await plugin.onLLMRequest({ messages: [{ role: 'user', content: '继续操作' }] });
    assert.match(await plugin.executeTool('computer_observe', { window_id: 200 }), /可信回合/);
    assert.equal(worker.callsOf('press_key').length, 1);
});

test('changing permission mode clears pending actions and refreshes prompt, tools and worker', async t => {
    const { plugin, worker, context, dataDir } = await setup();
    t.after(async () => { await plugin.onStop(); fs.rmSync(dataDir, { recursive: true, force: true }); });
    await ownerTurn(plugin);
    await plugin.executeTool('computer_observe', { window_id: 100 });
    await plugin.executeTool('computer_press_key', { observation_id: plugin.observations.latest().id, key: 'alt+f4' });
    assert.equal(plugin.pending.size(), 1);
    const raw = context.getPluginFileConfig();
    raw.autonomous_control = true;
    await plugin.onConfigChanged();
    assert.equal(plugin.pending.size(), 0);
    assert.equal(plugin.observations.latest().consumed, true);
    assert.equal(worker.stopped, true);
    assert.equal(plugin.worker, null);
    assert.equal(plugin.getTools().length, 11);
    assert.match(context.patches.get('computer-use-rules'), /完整、自主/);
    assert.match(await plugin.executeTool('computer_confirm_action', { pending_action_id: 'old' }), /无需确认动作/);
    const newWorker = plugin._createWorker('fake.exe');
    assert.equal(newWorker.helloArgs.autonomous_control, true);
    raw.autonomous_control = false;
    await plugin.onConfigChanged();
    assert.equal(plugin.getTools().length, 13);
    assert.equal(plugin.policy.describe(POWERSHELL).tier, 'deny');
    assert.match(context.patches.get('computer-use-rules'), /之前必须先问主人/);
});
