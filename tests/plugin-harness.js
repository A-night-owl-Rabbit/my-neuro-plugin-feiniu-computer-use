'use strict';

// Shared setup for protocol tests: a plugin wired to FakeWorker / FakeScreenshots / a fake banner DOM.
// (plugin-lifecycle.test.js keeps its own copy so the original suite stays untouched.)
const fs = require('fs');
const os = require('os');
const path = require('path');
const Plugin = require('../index.js');
const { ComputerUseBanner } = require('../lib/banner.js');
const { FakeWorker, FakeScreenshots, makeContext, makeWindow, makeFakeClock, makeFakeDocument } = require('./fake-worker.js');

const POWERSHELL = makeWindow({ id: 200, title: 'Windows PowerShell', class_name: 'ConsoleWindowClass', process_name: 'powershell.exe', process_path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', is_foreground: false });

async function setup(pluginConfig = {}, workerOptions = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feiniu-cu-yield-'));
    const context = makeContext({ autonomous_control: true, ...pluginConfig });
    const plugin = new Plugin({ name: 'feiniu-computer-use' }, context);
    plugin.dataDir = dataDir;
    await plugin.onInit();
    const clock = makeFakeClock();
    const document = makeFakeDocument();
    const bannerEvents = [];
    plugin.banner = new ComputerUseBanner({
        config: plugin.config, document, ipcRenderer: null,
        now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
        requestAnimationFrame: fn => clock.setTimeout(fn, 16), isEditing: () => false
    });
    for (const method of ['start', 'waitConfirm', 'pause', 'stop', 'finish', 'reset']) {
        const original = plugin.banner[method].bind(plugin.banner);
        plugin.banner[method] = (...args) => {
            const state = original(...args);
            bannerEvents.push({ method, arg: args[0], state });
            return state;
        };
    }
    const worker = new FakeWorker({ windows: [makeWindow(), POWERSHELL], generation: 1, ...workerOptions });
    plugin.worker = worker;
    plugin.pythonInfo = { python: 'fake.exe', source: 'test' };
    plugin._attachWorkerEvents(worker);
    plugin.screenshots = new FakeScreenshots();
    await plugin.onStart();
    await plugin.workerReady;
    const cleanup = async () => {
        try { await plugin.onStop(); } catch (_) {}
        fs.rmSync(dataDir, { recursive: true, force: true });
    };
    return { plugin, worker, context, dataDir, clock, document, bannerEvents, cleanup };
}

async function ownerTurn(plugin, text = '帮我在记事本里打字') {
    await plugin.onUserInput({ source: 'text', text });
    await plugin.onLLMRequest({ messages: [{ role: 'user', content: text }] });
}

function readAudit(dataDir) {
    const files = fs.readdirSync(dataDir).filter(f => f.startsWith('action-log-'));
    return files.map(f => fs.readFileSync(path.join(dataDir, f), 'utf8')).join('\n');
}

module.exports = { setup, ownerTurn, readAudit, POWERSHELL };
