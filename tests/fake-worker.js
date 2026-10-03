'use strict';

const { EventEmitter } = require('events');
const { WorkerError } = require('../lib/worker-client.js');

const MONITORS = [
    { index: 0, left: 0, top: 0, width: 3840, height: 2160 },
    { index: 1, left: 0, top: 0, width: 3840, height: 2160 }
];

function makeWindow(overrides = {}) {
    return {
        id: 100,
        title: '无标题 - 记事本',
        class_name: 'Notepad',
        pid: 4000,
        process_name: 'notepad.exe',
        process_path: 'C:\\Windows\\System32\\notepad.exe',
        rect: { left: 1578, top: 759, right: 3489, bottom: 1996 },
        width: 1911,
        height: 1237,
        is_foreground: true,
        is_minimized: false,
        is_self: false,
        ...overrides
    };
}

const NOTEPAD_TREE = {
    hwnd: 100,
    window_title: '无标题 - 记事本',
    elements: [
        { index: 0, depth: 0, type: 'WindowControl', name: '无标题 - 记事本', rect: { left: 1578, top: 759, right: 3489, bottom: 1996 }, patterns: [], editable: false, enabled: true, focused: false },
        { index: 1, depth: 1, type: 'EditControl', name: '文本编辑器', rect: { left: 1580, top: 820, right: 3480, bottom: 1960 }, patterns: ['value', 'text'], editable: true, enabled: true, focused: true },
        { index: 2, depth: 1, type: 'MenuBarControl', name: '应用程序', rect: { left: 1580, top: 790, right: 3480, bottom: 818 }, patterns: [], editable: false, enabled: true, focused: false },
        { index: 3, depth: 2, type: 'MenuItemControl', name: '格式(O)', rect: { left: 1700, top: 790, right: 1760, bottom: 818 }, patterns: ['expand'], editable: false, enabled: true, focused: false }
    ],
    element_count: 4,
    truncated: false,
    focused_element: { index: 1, type: 'EditControl', name: '文本编辑器', rect: { left: 1580, top: 820, right: 3480, bottom: 1960 }, patterns: ['value', 'text'], editable: true, enabled: true, focused: true },
    document_text: '',
    selected_text: ''
};

/**
 * In-memory stand-in for WorkerClient. `windows` is a map id -> window; ops record calls.
 */
class FakeWorker extends EventEmitter {
    constructor(options = {}) {
        super();
        this.hello = { version: 'fake', python: 'fake.exe', dpi: 144, scale: 1.5, dpi_awareness: 'per_monitor', uia_available: true, uia_error: '', monitors: MONITORS };
        this.windows = new Map();
        for (const w of options.windows || [makeWindow()]) this.windows.set(w.id, w);
        this.trees = options.trees || { 100: NOTEPAD_TREE };
        this.calls = [];
        this.foregroundId = options.foregroundId || 100;
        this.failNext = null;       // { op, code, error, details?, resultKnown? } - throws once, like a worker error reply
        this.nextResult = null;     // { op, result | fn(args, worker) } - overrides the next reply of an op once
        this.stopped = false;
        this.generation = options.generation;   // undefined unless a test opts in (mirrors WorkerClient.generation)
        this.helloArgs = {};
        this.callOptions = [];      // options passed alongside every call (timeouts)
        this.restarts = 0;
        this.lastFailure = null;
    }

    /** Simulates a worker restart: new generation, `invalidate` event, like WorkerClient does. */
    restart(reason = 'exited') {
        this.generation = (this.generation || 0) + 1;
        this.restarts += 1;
        this.emit('invalidate', { generation: this.generation, reason });
    }

    isAlive() { return !this.stopped; }
    async ensureStarted() { return this.hello; }
    async stop() { this.stopped = true; }
    diagnostics() { return { pid: 1, alive: true, stderrTail: [], generation: this.generation, restarts: this.restarts, lastFailure: this.lastFailure }; }

    callsOf(op) { return this.calls.filter(c => c.op === op); }

    async call(op, args = {}, options = {}) {
        this.calls.push({ op, args });
        this.callOptions.push({ op, options });
        if (this.failNext && this.failNext.op === op) {
            const fail = this.failNext;
            this.failNext = null;
            const extra = {};
            if (fail.details !== undefined) extra.details = fail.details;
            if (fail.resultKnown !== undefined) extra.resultKnown = fail.resultKnown;
            throw new WorkerError(fail.code, fail.error, extra);
        }
        if (this.nextResult && this.nextResult.op === op) {
            const next = this.nextResult;
            this.nextResult = null;
            return typeof next.fn === 'function' ? next.fn(args, this) : next.result;
        }
        switch (op) {
            case 'configure': return { config: { ...args }, generation: this.generation };
            case 'hello': return this.hello;
            case 'new_turn': case 'reset_abort': return { ok: true };
            case 'state': return { aborted: false, is_locked: false, foreground: this.windows.get(this.foregroundId) || null, cursor: [1, 1] };
            case 'cursor': return { x: 10, y: 10 };
            case 'list_windows': {
                const needle = String(args.filter || '').toLowerCase();
                return { windows: [...this.windows.values()].filter(w => !needle || `${w.title} ${w.process_name}`.toLowerCase().includes(needle)) };
            }
            case 'window_info': {
                const w = this.windows.get(Number(args.id));
                if (!w) throw new WorkerError('not_found', '窗口已不存在');
                return { ...w, is_foreground: this.foregroundId === w.id };
            }
            case 'foreground': return this.windows.get(this.foregroundId) || null;
            case 'activate_window': {
                const w = this.windows.get(Number(args.id));
                if (!w) throw new WorkerError('not_found', '窗口已不存在');
                this.foregroundId = w.id;
                return { ok: true, method: 'set_foreground', title: w.title, window: { ...w, is_foreground: true } };
            }
            case 'move_mouse': return { x: args.x, y: args.y };
            case 'click': return { ...args, foreground: this.windows.get(this.foregroundId) };
            case 'drag': case 'scroll': return { ...args };
            case 'type_text': {
                const total = [...String(args.text)].length;
                return { typed: total, input_total: total, completed: true, mode: args.mode };
            }
            case 'press_key': return { chord: args.key, repeat: args.repeat || 1 };
            case 'ui_tree': return this.trees[args.id] || { elements: [], element_count: 0, truncated: false, focused_element: null, document_text: '', selected_text: '' };
            case 'set_value': return { index: args.index, value: args.value };
            case 'resolve_app': {
                const target = String(args.target).toLowerCase();
                if (target.includes('记事本') || target.includes('notepad')) return { kind: 'alias', path: 'C:\\Windows\\system32\\notepad.exe', exe_name: 'notepad.exe', display: '记事本' };
                if (target.endsWith('.exe')) return { kind: 'path', path: args.target, exe_name: target.split(/[\\/]/).pop(), display: target.split(/[\\/]/).pop() };
                if (target.includes('cmd') || target.includes('powershell')) return { kind: 'alias', path: 'C:\\Windows\\system32\\cmd.exe', exe_name: 'cmd.exe', display: 'cmd' };
                throw new WorkerError('not_found', `找不到名为“${args.target}”的应用`);
            }
            case 'launch_app': {
                const win = makeWindow({ id: 500, title: '无标题 - 记事本', process_name: 'notepad.exe' });
                this.windows.set(win.id, win);
                this.foregroundId = win.id;
                return { resolved: { kind: 'alias', exe_name: 'notepad.exe', display: '记事本', path: 'C:\\Windows\\system32\\notepad.exe' }, new_windows: [win], elapsed_ms: 800 };
            }
            default:
                throw new WorkerError('unknown_op', op);
        }
    }
}

class FakeScreenshots {
    constructor() { this.captures = 0; }
    available() { return true; }
    async captureDisplay() {
        this.captures += 1;
        return { base64: 'FULLSHOT', image: {}, width: 1600, height: 900 };
    }
    cropImage(capture, mapping) {
        if (!mapping.crop) return { base64: capture.base64, width: capture.width, height: capture.height };
        return { base64: `CROP_${mapping.crop.x}_${mapping.crop.y}`, width: mapping.crop.width, height: mapping.crop.height };
    }
}

function makeContext(pluginConfig = {}, options = {}) {
    const logs = [];
    const patches = new Map();
    const subtitles = [];
    return {
        logs, patches, subtitles,
        log(level, message) { logs.push({ level, message }); },
        getPluginFileConfig() { return pluginConfig; },
        getConfig() { return { ui: { hide_from_screenshot: options.hideFromScreenshot !== false } }; },
        addSystemPromptPatch(id, text) { patches.set(id, text); },
        removeSystemPromptPatch(id) { patches.delete(id); },
        showSubtitle(text, duration) { subtitles.push({ text, duration }); },
        getPlugin() { return null; },
        on() {}, off() {}, emit() {}
    };
}

/** Deterministic clock: setTimeout/clearTimeout/now plus advance(ms) to fire due timers in order. */
function makeFakeClock(start = 1_000_000) {
    let now = start;
    let seq = 0;
    const timers = new Map();
    return {
        now: () => now,
        setTimeout(fn, ms) {
            const id = ++seq;
            timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn, seq: id });
            return id;
        },
        clearTimeout(id) { timers.delete(id); },
        pending() { return timers.size; },
        advance(ms) {
            const target = now + ms;
            for (;;) {
                const due = [...timers.values()].filter(t => t.at <= target).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
                if (!due) break;
                timers.delete(due.seq);
                now = due.at;
                due.fn();
            }
            now = target;
        }
    };
}

/** Just enough of the DOM for the banner renderer: ids, classList, dataset, style, hidden, querySelector. */
function makeFakeDocument() {
    const byId = new Map();
    function makeEl(tag) {
        const el = {
            tagName: String(tag).toUpperCase(),
            id: '',
            textContent: '',
            hidden: false,
            attrs: {},
            children: [],
            parentNode: null,
            dataset: {},
            style: {},
            _classes: new Set()
        };
        el.style.setProperty = (key, value) => { el.style[key] = value; };
        el.classList = {
            add: (...names) => names.forEach(n => el._classes.add(n)),
            remove: (...names) => names.forEach(n => el._classes.delete(n)),
            contains: name => el._classes.has(name),
            toggle: (name, force) => {
                const on = force === undefined ? !el._classes.has(name) : !!force;
                if (on) el._classes.add(name); else el._classes.delete(name);
                return on;
            }
        };
        Object.defineProperty(el, 'className', {
            get: () => [...el._classes].join(' '),
            set: value => { el._classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
        });
        el.setAttribute = (key, value) => { el.attrs[key] = String(value); };
        el.getAttribute = key => (key in el.attrs ? el.attrs[key] : null);
        el.appendChild = child => {
            child.parentNode = el;
            el.children.push(child);
            if (child.id) byId.set(child.id, child);
            return child;
        };
        el.remove = () => {
            if (el.parentNode) {
                const idx = el.parentNode.children.indexOf(el);
                if (idx >= 0) el.parentNode.children.splice(idx, 1);
            }
            const drop = node => {
                if (node.id) byId.delete(node.id);
                node.children.forEach(drop);
            };
            drop(el);
            el.parentNode = null;
        };
        el.querySelector = selector => el.querySelectorAll(selector)[0] || null;
        el.querySelectorAll = selector => {
            const out = [];
            const walk = node => {
                for (const child of node.children) {
                    if (selector.startsWith('.') && child._classes.has(selector.slice(1))) out.push(child);
                    else if (selector.startsWith('#') && child.id === selector.slice(1)) out.push(child);
                    walk(child);
                }
            };
            walk(el);
            return out;
        };
        return el;
    }
    const head = makeEl('head');
    const body = makeEl('body');
    return {
        head,
        body,
        createElement: makeEl,
        getElementById: id => byId.get(id) || null,
        querySelectorAll: selector => [...head.querySelectorAll(selector), ...body.querySelectorAll(selector)]
    };
}

module.exports = { FakeWorker, FakeScreenshots, makeContext, makeWindow, makeFakeClock, makeFakeDocument, NOTEPAD_TREE, MONITORS };
