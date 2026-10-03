'use strict';

const path = require('path');
const { Plugin } = require('../../../js/core/plugin-base.js');
const { WorkerClient, WorkerError } = require('./lib/worker-client.js');
const { resolvePython } = require('./lib/python-resolver.js');
const { ScreenshotService, buildMapping, monitorForPoint } = require('./lib/screenshot.js');
const { ObservationStore } = require('./lib/observation.js');
const { AppPolicy } = require('./lib/app-policy.js');
const { ActionGate } = require('./lib/action-gate.js');
const { PendingActions } = require('./lib/pending-actions.js');
const { AuditLogger } = require('./lib/audit-log.js');
const { classifyChord } = require('./lib/key-chords.js');
const { getTools, TOOL_NAMES } = require('./lib/tool-definitions.js');
const { PATCH_ID, buildPromptPatch } = require('./lib/prompt-patch.js');
const { formatObservation, formatWindowList, formatActionReceipt } = require('./lib/format.js');
const { normalizeFacts, bannerStatus, failureGuidance, typingState, STOP_REASON_LABELS } = require('./lib/action-facts.js');
const { ComputerUseBanner, normalizeBannerConfig } = require('./lib/banner.js');
const { toBool, toInt, compactText, splitList } = require('./lib/utils.js');
const { eventBus } = require('../../../js/core/event-bus.js');
const { Events } = require('../../../js/core/events.js');

const TAG = '[ComputerUse]';

/** Worker ops that change the desktop: each first waits (bounded) for the owner to stop using it. */
const YIELD_OPS = new Set(['activate_window', 'move_mouse', 'click', 'click_element', 'drag', 'scroll', 'type_text', 'press_key', 'set_value', 'launch_app']);
/** Yield / segmented-typing parameters that can be pushed to a running worker without a restart. */
const YIELD_CONFIG_KEYS = ['user_idle_yield', 'user_idle_ms', 'user_idle_max_wait_ms', 'type_chunk_size', 'type_chunk_gap_ms'];
/** Activation failures that carry their own meaning and must not be rewritten into "cannot focus window". */
const PASS_THROUGH_CODES = new Set(['user_active', 'aborted', 'locked', 'timeout', 'worker_exited', 'worker_crashed', 'worker_restarted', 'stopped', 'stale_generation', 'write_failed']);

function readConfig(raw = {}) {
    return {
        enabled: toBool(raw.enabled, true),
        autonomous_control: toBool(raw.autonomous_control, true),
        python_executable: String(raw.python_executable || '').trim(),
        conda_env_name: String(raw.conda_env_name || 'my-neuro').trim() || 'my-neuro',
        worker_startup_timeout_ms: toInt(raw.worker_startup_timeout_ms, 20000, 3000, 120000),
        action_timeout_ms: toInt(raw.action_timeout_ms, 15000, 2000, 120000),
        observe_timeout_ms: toInt(raw.observe_timeout_ms, 20000, 2000, 120000),
        post_action_settle_ms: toInt(raw.post_action_settle_ms, 400, 0, 5000),
        observation_max_age_ms: toInt(raw.observation_max_age_ms, 90000, 5000, 600000),
        max_actions_per_turn: toInt(raw.max_actions_per_turn, 25, 1, 200),
        screenshot_max_long_edge: toInt(raw.screenshot_max_long_edge, 1600, 640, 2560),
        screenshot_jpeg_quality: toInt(raw.screenshot_jpeg_quality, 80, 45, 95),
        ui_tree_default_depth: toInt(raw.ui_tree_default_depth, 3, 1, 8),
        ui_tree_max_chars: toInt(raw.ui_tree_max_chars, 6000, 500, 30000),
        document_text_max_chars: toInt(raw.document_text_max_chars, 2000, 100, 20000),
        trusted_input_sources: raw.trusted_input_sources ?? 'text,voice',
        allow_proactive_control: toBool(raw.allow_proactive_control, false),
        proactive_allowed_apps: raw.proactive_allowed_apps ?? '',
        confirm_first_use_per_app: toBool(raw.confirm_first_use_per_app, true),
        always_allowed_apps: raw.always_allowed_apps ?? 'notepad.exe,mspaint.exe,calc.exe',
        denied_apps: raw.denied_apps ?? '',
        app_tier_overrides: raw.app_tier_overrides ?? '',
        browser_tier: String(raw.browser_tier || 'full').trim().toLowerCase(),
        require_confirm_for_typing: toBool(raw.require_confirm_for_typing, false),
        require_confirm_for_enter: toBool(raw.require_confirm_for_enter, true),
        unicode_input_mode: String(raw.unicode_input_mode || 'sendinput').trim().toLowerCase() === 'clipboard' ? 'clipboard' : 'sendinput',
        esc_watch_window_ms: toInt(raw.esc_watch_window_ms, 15000, 1000, 120000),
        user_activity_threshold_px: toInt(raw.user_activity_threshold_px, 40, 5, 2000),
        user_idle_yield: toBool(raw.user_idle_yield, true),
        user_idle_ms: toInt(raw.user_idle_ms, 500, 100, 5000),
        user_idle_max_wait_ms: toInt(raw.user_idle_max_wait_ms, 3000, 0, 30000),
        type_chunk_size: toInt(raw.type_chunk_size, 16, 1, 200),
        type_chunk_gap_ms: toInt(raw.type_chunk_gap_ms, 100, 0, 1000),
        ...normalizeBannerConfig(raw),
        webui_tool_log_detail: String(raw.webui_tool_log_detail || 'summary').trim().toLowerCase() === 'full' ? 'full' : 'summary',
        log_typed_text: toBool(raw.log_typed_text, false),
        save_debug_screenshots: toBool(raw.save_debug_screenshots, false),
        verbose_log: toBool(raw.verbose_log, false)
    };
}

class FeiniuComputerUsePlugin extends Plugin {
    constructor(metadata, context) {
        super(metadata, context);
        this.config = readConfig();
        this.dataDir = path.join(__dirname, 'data');
        this.worker = null;
        this.workerReady = null;
        this.pythonInfo = null;
        this.lastWindowId = null;
        this.chain = Promise.resolve();
        this.hooks = {};
        this.banner = null;
        // Bumped whenever replies of in-flight work can no longer be trusted (Esc, stop, worker restart, mode change).
        this.epoch = 0;
        this.lastOutcome = null;   // facts of the most recent desktop tool result (for computer_doctor)
        this.lastStop = null;      // { reason, at } of the most recent stop / yield / failure
        this._onLLMError = () => { this.banner?.finish(); };
    }

    // ------------------------------------------------------------------ lifecycle
    async onInit() {
        this._loadConfig();
        this.banner = new ComputerUseBanner({ config: this.config, log: (l, m) => this._log(l, m) });
        this.gate = new ActionGate(this.config);
        this.policy = new AppPolicy({ ...this.config, self_exe_paths: [process.execPath] });
        const generationProvider = () => this.worker?.generation;
        this.pending = new PendingActions({ generationProvider });
        this.observations = new ObservationStore({ maxAgeMs: this.config.observation_max_age_ms, generationProvider });
        this.audit = new AuditLogger({
            logger: (level, message) => this.context.log(level, message),
            detail: this.config.webui_tool_log_detail,
            dataDir: this.dataDir,
            logTypedText: this.config.log_typed_text
        });
        this.screenshots = new ScreenshotService({ log: (l, m) => this._log(l, m) });
    }

    async onStart() {
        if (!this.config.enabled) {
            this._log('info', '插件已禁用');
            return;
        }
        this._applyPromptPatch();
        if (this.banner) {
            this.banner.configure(this.config);
            this.banner.mount();
        }
        try { eventBus.on(Events.LLM_ERROR, this._onLLMError); } catch (_) {}
        // Warm the worker up in the background so the first tool call is fast; never block startup.
        this.workerReady = this._ensureWorker().then(hello => {
            this._log('info', `桌面 worker 就绪：python=${hello?.python || '?'} dpi=${hello?.dpi || '?'} uia=${hello?.uia_available}`);
            return hello;
        }).catch(error => {
            this._log('warn', `桌面 worker 预热失败（首次使用时会重试）: ${error.message}`);
            return null;
        });
        const hide = this.context.getConfig?.()?.ui?.hide_from_screenshot;
        if (hide !== true) {
            this._log('warn', 'config.json 的 ui.hide_from_screenshot 未开启，肥牛自己会出现在截图里，建议在 WebUI 打开');
        }
        this._log('info', '肥牛电脑操作插件已启动');
    }

    async onStop() {
        try { this.context.removeSystemPromptPatch(PATCH_ID); } catch (_) {}
        try { eventBus.off(Events.LLM_ERROR, this._onLLMError); } catch (_) {}
        try { this.banner?.unmount(); } catch (_) {}
        if (this.worker) {
            try { await this.worker.stop(); } catch (_) {}
            this.worker = null;
        }
    }

    async onConfigChanged() {
        const previous = this.config;
        this._loadConfig();
        this.gate.configure(this.config);
        this.policy.configure({ ...this.config, self_exe_paths: [process.execPath] });
        if (previous.autonomous_control !== this.config.autonomous_control) {
            // Old queued closures must never execute after the permission mode changes.
            this.pending.cancel();
            this.observations.invalidateAll('permission_mode_changed');
            this.epoch += 1;
            this.banner?.reset();
        }
        this.observations.maxAgeMs = this.config.observation_max_age_ms;
        this.audit.configure({ detail: this.config.webui_tool_log_detail, logTypedText: this.config.log_typed_text });
        this.banner?.configure(this.config);
        if (this.config.enabled) this._applyPromptPatch();
        else { try { this.context.removeSystemPromptPatch(PATCH_ID); } catch (_) {} }
        const workerAffecting = ['autonomous_control', 'python_executable', 'conda_env_name', 'esc_watch_window_ms', 'user_activity_threshold_px'];
        if (this.worker && workerAffecting.some(key => previous[key] !== this.config[key])) {
            this._log('info', '插件配置变化涉及 worker，重启桌面 worker');
            const old = this.worker;
            this.worker = null;
            this.workerReady = null;
            this._invalidateDesktopState('worker_config_changed');
            await old.stop().catch(() => {});
        } else if (this.worker && YIELD_CONFIG_KEYS.some(key => previous[key] !== this.config[key])) {
            // Hot path: owner-yield and typing parameters change without restarting the worker.
            const yieldArgs = this._yieldArgs();
            if (this.worker.helloArgs) Object.assign(this.worker.helloArgs, yieldArgs);
            if (this.worker.isAlive()) {
                await this.worker.call('configure', yieldArgs, { timeoutMs: 3000 })
                    .catch(error => this._log('warn', `热更新让位参数失败（下次重启 worker 时生效）: ${error.message}`));
            }
            this.audit.event('info', 'config_yield', { summary: `让位/分段输入参数已热更新: idle=${yieldArgs.user_idle_ms}ms wait<=${yieldArgs.user_idle_max_wait_ms}ms chunk=${yieldArgs.type_chunk_size}/${yieldArgs.type_chunk_gap_ms}ms yield=${yieldArgs.user_idle_yield}` });
        }
    }

    _yieldArgs() {
        return {
            user_idle_yield: this.config.user_idle_yield,
            user_idle_ms: this.config.user_idle_ms,
            user_idle_max_wait_ms: this.config.user_idle_max_wait_ms,
            type_chunk_size: this.config.type_chunk_size,
            type_chunk_gap_ms: this.config.type_chunk_gap_ms
        };
    }

    /** Old observations, parked actions and the "last window" must not survive a worker/epoch change. */
    _invalidateDesktopState(reason) {
        this.epoch += 1;
        this.observations?.invalidateAll(reason);
        this.pending?.cancel();
        this.lastWindowId = null;
    }

    async onUserInput(event) {
        const trusted = this.gate.captureInput(event);
        if (trusted) this.banner?.reset();
        if (trusted && this.worker?.isAlive()) {
            this.worker.call('new_turn', {}, { timeoutMs: 3000 }).catch(() => {});
        }
    }

    async onLLMRequest(request) {
        this.gate.beginLLMRequest(request);
    }

    async onLLMResponse() {
        this.gate.endLLMRequest();
        this.banner?.finish();
    }

    getTools() {
        return this.config.enabled ? getTools({ autonomousControl: this.config.autonomous_control }) : [];
    }

    async executeTool(name, params = {}) {
        if (!TOOL_NAMES.has(name)) return undefined;
        if (!this.config.enabled) return '肥牛电脑操作插件当前已禁用。';
        // Serialize: desktop actions must never interleave.
        const run = () => this._dispatch(name, params || {});
        const result = this.chain.then(run, run);
        this.chain = result.then(() => undefined, () => undefined);
        return result;
    }

    async _dispatch(name, params) {
        try {
            switch (name) {
                case 'computer_doctor': return await this._doctor();
                case 'computer_list_windows': return await this._listWindows(params);
                case 'computer_launch_app': return await this._launchApp(params);
                case 'computer_observe': return await this._observeTool(params);
                case 'computer_click': return await this._inputTool('click', params);
                case 'computer_type': return await this._inputTool('type', params);
                case 'computer_press_key': return await this._inputTool('press_key', params);
                case 'computer_scroll': return await this._inputTool('scroll', params);
                case 'computer_drag': return await this._inputTool('drag', params);
                case 'computer_set_value': return await this._inputTool('set_value', params);
                case 'computer_confirm_action': return await this._confirmAction(params);
                case 'computer_cancel_action': return this._cancelAction(params);
                case 'computer_stop': return await this._stop(params);
                default: return undefined;
            }
        } catch (error) {
            return this._handleError(name, error);
        }
    }

    // ------------------------------------------------------------------ helpers
    _loadConfig() {
        const raw = (this.context.getPluginFileConfig && this.context.getPluginFileConfig()) || {};
        this.config = readConfig(raw);
    }

    _log(level, message) {
        if (level === 'debug' && !this.config.verbose_log) return;
        this.context.log(level === 'debug' ? 'info' : level, `${TAG} ${message}`);
    }

    _applyPromptPatch() {
        try {
            this.context.addSystemPromptPatch(PATCH_ID, buildPromptPatch({
                autonomousControl: this.config.autonomous_control,
                allowProactive: this.config.allow_proactive_control
            }));
        } catch (error) {
            this._log('warn', `注入系统提示词失败: ${error.message}`);
        }
    }

    /** "Doing X now": top banner in `top` mode, the legacy subtitle flash in `subtitle` mode. */
    _bannerStart(text) {
        if (this.config.banner_mode === 'subtitle') {
            try { this.context.showSubtitle(`肥牛正在操作电脑：${text}（按 Esc 取消）`, 2500); } catch (_) {}
            return;
        }
        this.banner?.start(text);
    }

    _bannerStop(text) {
        if (this.config.banner_mode === 'subtitle') {
            try { this.context.showSubtitle(text, 2000); } catch (_) {}
            return;
        }
        this.banner?.stop(text);
    }

    _passThroughMouse() {
        try {
            const { ipcRenderer } = require('electron');
            ipcRenderer.send('set-ignore-mouse-events', { ignore: true, options: { forward: true } });
        } catch (_) {
            // not in Electron (tests)
        }
    }

    async _ensureWorker() {
        if (this.worker?.isAlive()) return this.worker.hello;
        if (!this.worker) {
            if (!this.pythonInfo) {
                this.pythonInfo = await resolvePython({
                    configured: this.config.python_executable,
                    condaEnv: this.config.conda_env_name,
                    cacheFile: path.join(this.dataDir, 'python-path.json'),
                    log: (l, m) => this._log(l, m)
                });
                this._log('info', `Python 解析成功（${this.pythonInfo.source}）: ${this.pythonInfo.python}`);
            }
            this.worker = this._createWorker(this.pythonInfo.python);
        }
        return this.worker.ensureStarted();
    }

    _createWorker(pythonPath) {
        const selfPids = [process.pid];
        if (Number.isInteger(process.ppid)) selfPids.push(process.ppid);
        const worker = new WorkerClient({
            pythonPath,
            scriptPath: path.join(__dirname, 'worker', 'desktop_worker.py'),
            log: (l, m) => this._log(l, m),
            startupTimeoutMs: this.config.worker_startup_timeout_ms,
            actionTimeoutMs: this.config.action_timeout_ms,
            helloArgs: {
                autonomous_control: this.config.autonomous_control,
                esc_watch_window_ms: this.config.esc_watch_window_ms,
                user_activity_threshold_px: this.config.user_activity_threshold_px,
                ...this._yieldArgs(),
                self_pids: selfPids,
                self_exe_paths: [process.execPath]
            }
        });
        this._attachWorkerEvents(worker);
        return worker;
    }

    _attachWorkerEvents(worker) {
        worker.on('event:esc_pressed', () => {
            this.epoch += 1;
            this.lastStop = { reason: 'esc', at: Date.now() };
            this.gate.abort('主人按了 Esc');
            this.observations.invalidateAll('esc');
            this.pending.cancel();
            this.audit.event('warn', 'aborted', { summary: '主人按下 Esc，已停止所有电脑操作' });
            this._bannerStop('肥牛已停手（Esc）');
        });
        worker.on('event:user_activity', info => {
            this.gate.noteOwnerActivity(info);
            this.observations.invalidateAll('owner_activity');
            this.lastStop = { reason: 'user_active', at: Date.now() };
            const mouse = info.source === 'cursor_move' || !!info.dx || !!info.dy;
            this.audit.event('info', 'owner_activity', {
                summary: mouse
                    ? `检测到主人在动鼠标 (${info.dx},${info.dy})，暂停动作`
                    : `检测到主人在操作键盘/鼠标（来源=${info.source || '未知'}，已等待 ${info.waited_ms ?? 0}ms），肥牛让位`
            });
            this.banner?.pause(mouse ? '你在动鼠标，肥牛先停一下' : '你在操作，肥牛先让位');
        });
        worker.on('event:user_wait', info => {
            this.audit.event('info', 'owner_wait', { summary: `主人正在操作（来源=${info.source || '未知'}），最多等待 ${info.max_wait_ms ?? '?'}ms 再动手` });
            this.banner?.pause('等待主人停手…');
        });
        worker.on('invalidate', info => {
            this._invalidateDesktopState(`worker_${info?.reason || 'invalidated'}`);
        });
        worker.on('crash', info => {
            this.lastStop = { reason: 'worker_error', at: Date.now() };
            this._invalidateDesktopState('worker_crashed');
            this.audit.event('warn', 'worker_restart', { summary: `worker 意外退出 code=${info.code}，旧观察和待执行动作已作废，下次调用时自动重启（不会重放动作）` });
        });
    }

    async _call(op, args, timeoutMs) {
        await this._ensureWorker();
        // The worker may legitimately wait for the owner before acting; that time must not count as a hang.
        const allowance = this.config.user_idle_yield && YIELD_OPS.has(op) ? this.config.user_idle_max_wait_ms : 0;
        return this.worker.call(op, args, { timeoutMs: (timeoutMs || this.config.action_timeout_ms) + allowance });
    }

    /** Generous-but-bounded budget for long, segmented typing (the worker paces itself). */
    _actionTimeoutMs(plan) {
        let timeout = this.config.action_timeout_ms;
        if (plan.op === 'type_text') {
            const length = [...String(plan.args?.text ?? '')].length;
            const chunks = Math.ceil(length / this.config.type_chunk_size);
            const estimate = this.config.unicode_input_mode === 'clipboard' ? 2000 : length * 12 + chunks * this.config.type_chunk_gap_ms;
            timeout = Math.min(300000, Math.max(timeout, Math.ceil(estimate * 1.5) + 2000));
        }
        return timeout;
    }

    _handleError(name, error) {
        const code = error?.code || 'error';
        const message = error?.message || String(error);
        const facts = normalizeFacts(error?.details, { ok: false, code });
        if (typeof error?.resultKnown === 'boolean' && typeof error?.details?.result_known !== 'boolean') facts.resultKnown = error.resultKnown;
        if (code === 'aborted') {
            this.gate.abort('主人按了 Esc');
            this.observations.invalidateAll('esc');
        } else if (code === 'user_active') {
            this.observations.invalidateAll('owner_activity');
        }
        // The desktop may have changed in a way we cannot vouch for: nothing queued or observed before survives.
        if (!facts.resultKnown && facts.injected !== false) this._invalidateDesktopState(`result_unknown_${code}`);
        if (facts.stoppedReason) this.lastStop = { reason: facts.stoppedReason, at: Date.now(), tool: name };
        this.lastOutcome = { tool: name, at: Date.now(), ok: false, code, stoppedReason: facts.stoppedReason, resultKnown: facts.resultKnown, typed: facts.typed, inputTotal: facts.inputTotal, generation: facts.generation ?? error?.generation ?? null };

        const status = bannerStatus(facts);
        if (status?.kind === 'pause') this.banner?.pause(status.text);
        else if (status?.kind === 'stop') this._bannerStop(status.text);
        else if (code === 'aborted') this._bannerStop('肥牛已停手');

        this.audit.event(code === 'denied' ? 'warn' : 'error', 'tool_error', { summary: `${name} ${code}: ${compactText(message, 300)}`, facts });
        this._log('warn', `${name} 失败 (${code}): ${message}`);
        const hints = {
            uia_unavailable: 'UI 元素树不可用，请改用带截图的观察和坐标操作。',
            worker_unavailable: '桌面 worker 不可用，请调用 computer_doctor 查看原因并告诉主人。',
            out_of_screen: '坐标不在屏幕范围内，worker 拒绝了它，没有发送任何输入。请重新 computer_observe，再用观察里的元素编号或截图范围内的坐标。'
        };
        const guidance = failureGuidance(facts, { autonomous: this.config.autonomous_control }) || hints[code] || '';
        const receipt = formatActionReceipt(facts);
        return `电脑操作失败（${code}）：${message}${receipt ? `\n${receipt}` : ''}${guidance ? `\n${guidance}` : ''}`;
    }

    _authorize(kind, window = null) {
        const auth = this.gate.authorize(kind, window);
        if (!auth.ok) {
            this.audit.event('warn', 'denied', { window: window?.process_name, summary: `${auth.code}: ${auth.reason}` });
            return auth.reason;
        }
        return null;
    }

    async _resolveWindow(windowId) {
        if (windowId !== undefined && windowId !== null && windowId !== '') {
            const id = Number(windowId);
            if (!Number.isInteger(id)) throw new WorkerError('bad_args', 'window_id 必须是整数');
            return this._call('window_info', { id });
        }
        if (this.lastWindowId) {
            try {
                return await this._call('window_info', { id: this.lastWindowId });
            } catch (_) {
                this.lastWindowId = null;
            }
        }
        const fg = await this._call('foreground', {});
        if (!fg) throw new WorkerError('not_found', '没有前台窗口，请先用 computer_list_windows 选择目标');
        return fg;
    }

    _windowLabel(window) {
        return window ? `${window.process_name || '?'}:${compactText(window.title || '', 40)}` : '-';
    }

    // ------------------------------------------------------------------ tools
    async _doctor() {
        const lines = ['【肥牛电脑操作 · 诊断】'];
        let hello = null;
        try {
            hello = await this._ensureWorker();
        } catch (error) {
            lines.push(`worker：不可用 —— ${error.message}`);
        }
        const diag = this.worker?.diagnostics?.() || {};
        let yieldLive = null;
        if (hello) {
            lines.push(`worker：正常（pid ${diag.pid}，python ${hello.python}）`);
            lines.push(`DPI：${hello.dpi}（缩放 ${hello.scale}，${hello.dpi_awareness}）`);
            lines.push(`UI Automation：${hello.uia_available ? '可用' : `不可用 ${hello.uia_error || ''}`}`);
            const monitors = (hello.monitors || []).filter(m => m.index !== 0);
            lines.push(`显示器：${monitors.map(m => `${m.width}×${m.height}@(${m.left},${m.top})`).join('；') || '未知'}`);
            try {
                const state = await this._call('state', {}, 5000);
                lines.push(`桌面状态：${state.is_locked ? '锁屏' : '正常'}，前台 ${this._windowLabel(state.foreground)}，Esc 中断标志=${state.aborted}`);
                yieldLive = state.yield_config || null;
                if (state.activity) lines.push(`主人活动探测：${state.activity.active ? `正在操作（${state.activity.source}）` : '静止'}，距上次主人输入 ${state.activity.owner_idle_ms ?? '未知（最近输入来自肥牛自己或探测不可用）'}ms`);
            } catch (_) {}
        } else if (diag.stderrTail?.length) {
            lines.push(`worker stderr：${diag.stderrTail.join(' | ')}`);
        }
        if (hello) {
            lines.push(`协议：worker ${hello.version || '?'} / protocol ${hello.protocol ?? '旧版（无让位协议）'}，generation ${diag.generation ?? hello.generation ?? '?'}，累计重启 ${diag.restarts ?? 0} 次`);
            const caps = hello.capabilities;
            lines.push(caps
                ? `协议能力：主人让位=${caps.user_idle_yield ? '有' : '无'}，分段输入=${caps.segmented_typing ? '有' : '无'}，剪贴板模式可分段=${caps.clipboard_typing_segmented ? '是' : '否（一次粘贴，无法中途停止）'}，worker 坐标范围校验=${caps.coordinate_validation ? '有' : '无（旧版 worker，只有插件层校验）'}`
                : '协议能力：worker 过旧，没有让位/分段输入能力，请重启桌宠以加载新版 worker');
        }
        lines.push(`让位参数（配置）：${this.config.user_idle_yield ? '开启' : '关闭'}，主人静止 ≥${this.config.user_idle_ms}ms 才动手，最长等待 ${this.config.user_idle_max_wait_ms}ms，文字每 ${this.config.type_chunk_size} 字一段、段间隔 ${this.config.type_chunk_gap_ms}ms（${this.config.unicode_input_mode === 'clipboard' ? '当前为剪贴板模式，不分段' : '逐字输入模式'}）`);
        if (yieldLive) {
            const mismatch = Object.keys(this._yieldArgs()).filter(key => yieldLive[key] !== undefined && yieldLive[key] !== this._yieldArgs()[key]);
            lines.push(mismatch.length ? `让位参数（worker 实际）：与配置不一致 ${mismatch.join(',')}，下次动作前会重新同步或重启 worker` : '让位参数（worker 实际）：与配置一致');
        }
        const lastStop = this.lastStop;
        lines.push(`最近一次停止/让位原因：${lastStop ? `${STOP_REASON_LABELS[lastStop.reason] || lastStop.reason}${lastStop.tool ? `，经 ${lastStop.tool}` : ''}（${new Date(lastStop.at).toLocaleTimeString('zh-CN', { hour12: false })}）` : '无'}`);
        const last = this.lastOutcome;
        lines.push(`最近一次动作结果：${last ? `${last.tool} ${last.ok ? '已执行' : `失败(${last.code})`}，结果${last.resultKnown ? '已确认' : '未知（需重新观察）'}${last.inputTotal != null ? `，输入 ${last.typed}/${last.inputTotal} 字` : ''}${diag.lastFailure ? `；worker 最近故障 ${diag.lastFailure.code}@generation ${diag.lastFailure.generation}` : ''}` : '无'}`);
        lines.push(`截图通道：${this.screenshots.available() ? '可用' : '不可用（不在 Electron 渲染进程）'}`);
        const hide = this.context.getConfig?.()?.ui?.hide_from_screenshot;
        lines.push(`肥牛自身排除截图（ui.hide_from_screenshot）：${hide === true ? '已开启' : '未开启（建议开启）'}`);
        const snap = this.gate.snapshot();
        lines.push(`本回合：${snap.activeTurn ? `${snap.activeTurn.kind} 回合，已执行 ${snap.actionsThisTurn}/${snap.maxActionsPerTurn} 个动作` : '不是可信回合'}${snap.aborted ? `，已中断（${snap.aborted.reason}）` : ''}`);
        lines.push(this.config.autonomous_control
            ? '策略：完全自主控制，所有应用全控制，操作无需逐次授权，可信主动回合允许；保留 Esc 停止、观察有效性和动作上限。'
            : `策略：浏览器=${this.config.browser_tier}，首次操作确认=${this.config.confirm_first_use_per_app}，始终允许=${splitList(this.config.always_allowed_apps).join(',') || '无'}，额外禁止=${splitList(this.config.denied_apps).join(',') || '无'}，主动回合=${this.config.allow_proactive_control ? '允许' : '禁止'}`);
        lines.push(`待确认动作：${this.pending.size()} 个；最新观察：${this.observations.latest()?.id || '无'}`);
        if (this.banner) {
            const b = this.banner.snapshot();
            lines.push(`顶部提示条：模式=${b.mode}，主题=${b.theme}，已挂载=${b.mounted}，当前状态=${b.state}`);
        }
        this.audit.event('info', 'doctor', { summary: hello ? 'ok' : 'worker_unavailable' });
        return lines.join('\n');
    }

    async _listWindows(params) {
        const denied = this._authorize('query');
        if (denied) return denied;
        const filter = String(params.filter || '').trim();
        const result = await this._call('list_windows', { filter, include_self: this.config.autonomous_control });
        const windows = (result.windows || []).filter(w => this.config.autonomous_control || this.policy.categorize(w) !== 'self');
        this.audit.event('info', 'list_windows', { summary: `${windows.length} 个窗口${filter ? `，过滤 "${filter}"` : ''}` });
        return formatWindowList(windows, this.policy, filter);
    }

    async _launchApp(params) {
        const target = String(params.target || '').trim();
        if (!target) return '请告诉我要启动哪个应用（target）。';
        const denied = this._authorize('input');
        if (denied) return denied;

        const resolved = await this._call('resolve_app', { target });
        const exeName = String(resolved.exe_name || '').toLowerCase();
        const pseudoWindow = { process_name: exeName, title: resolved.display || target, process_path: resolved.path };
        const policyInfo = this.policy.describe(pseudoWindow);
        if (policyInfo.tier === 'deny') {
            this.audit.event('warn', 'denied', { window: exeName, summary: `拒绝启动 ${policyInfo.categoryLabel}` });
            return `不能启动 ${resolved.display || target}：它属于${policyInfo.categoryLabel}，是肥牛的禁区。`;
        }
        const needsConfirm = resolved.kind === 'path' || resolved.kind === 'start_menu_partial';
        if (!this.config.autonomous_control && needsConfirm && !this.policy.alwaysAllowed.has(exeName) && !this.policy.sessionAllowed.has(exeName)) {
            const item = this.pending.create({
                kind: 'launch',
                summary: `启动程序 ${resolved.display || target}（${resolved.path}）`,
                reason: resolved.kind === 'path' ? '这是一个直接指定路径的程序，不在开始菜单常用项里' : `开始菜单里按“${target}”模糊匹配到了 ${resolved.display}`,
                window: pseudoWindow,
                params: { target },
                execute: () => this._doLaunch(target, params, resolved)
            });
            this.audit.event('info', 'confirm_required', { window: exeName, summary: item.summary });
            this.banner?.waitConfirm(`等你点头：启动 ${compactText(resolved.display || target, 30)}`);
            return PendingActions.describe(item);
        }
        return this._doLaunch(target, params, resolved);
    }

    async _doLaunch(target, params, resolved) {
        this._bannerStart(`正在启动 ${compactText(resolved.display || target, 30)}`);
        const waitMs = toInt(params.wait_ms, 6000, 500, 30000);
        const result = await this._call('launch_app', { target, wait_ms: waitMs }, waitMs + 5000);
        this.gate.countAction();
        const facts = normalizeFacts(result, { ok: true });
        this.lastOutcome = { tool: 'computer_launch_app', at: Date.now(), ok: true, code: null, stoppedReason: facts.stoppedReason, resultKnown: facts.resultKnown, typed: null, inputTotal: null, generation: facts.generation };
        const receipt = formatActionReceipt(facts);
        const receiptLine = receipt ? `\n${receipt}` : '';
        const windows = (result.new_windows || []).filter(w => this.policy.categorize(w) !== 'self');
        this.audit.event('info', 'launch', { window: resolved.exe_name, summary: `${resolved.display || target} -> ${windows.length} 个新窗口 (${result.elapsed_ms}ms)`, detail: { resolved, windows }, facts });
        if (!windows.length) {
            return `已启动 ${resolved.display || target}（${resolved.path}），但 ${waitMs}ms 内没看到新窗口出现。它可能启动较慢、只在托盘运行、或复用了已有窗口；请用 computer_list_windows 再找一次。${receiptLine}`;
        }
        const win = windows[0];
        this.lastWindowId = win.id;
        this.observations.invalidateAll('launch');
        const info = this.policy.describe(win);
        return `已启动 ${resolved.display || target}。新窗口：window_id=${win.id} “${compactText(win.title, 60)}”（${win.process_name}，分级 ${info.tierLabel}）${windows.length > 1 ? `，另有 ${windows.length - 1} 个新窗口` : ''}。${receiptLine}\n下一步：computer_observe(window_id=${win.id}${info.needsFirstUseConfirm ? '' : ''}, include_ui_tree=true) 看看界面。`;
    }

    async _observeTool(params) {
        const denied = this._authorize('observe');
        if (denied) return denied;
        const window = await this._resolveWindow(params.window_id);
        const check = this.policy.check(window, 'observe');
        if (!check.allowed) {
            this.audit.event('warn', 'denied', { window: window.process_name, summary: check.reason });
            return `${check.reason}。`;
        }
        return this._observe(window, {
            includeScreenshot: params.include_screenshot !== false,
            includeUiTree: params.include_ui_tree === true,
            treeDepth: toInt(params.tree_depth, this.config.ui_tree_default_depth, 1, 8),
            scope: params.scope === 'screen' ? 'screen' : 'window'
        });
    }

    /** Activates the window, captures screenshot / UI tree, records the observation. */
    async _observe(window, options = {}, prefix = '') {
        const hello = await this._ensureWorker();
        // Observing is part of "using the computer" too; the subtitle mode keeps its old silence here.
        this.banner?.start(`正在观察 ${compactText(window.title || window.process_name || '窗口', 30)}`);
        const activation = await this._call('activate_window', { id: window.id }).catch(error => ({ ok: false, error }));
        if (!activation.ok) {
            if (PASS_THROUGH_CODES.has(activation.error?.code)) throw activation.error;
            const actual = activation.error?.actual_foreground;
            throw new WorkerError(
                activation.error?.code || 'activate_failed',
                `无法把“${compactText(window.title, 40)}”切到前台${actual ? `，当前前台是 ${this._windowLabel(actual)}` : ''}；如果有弹窗或系统提示，请主人先处理`
            );
        }
        const freshWindow = activation.window || window;
        this.lastWindowId = freshWindow.id;

        let mapping = null;
        let shot = null;
        if (options.includeScreenshot) {
            const monitors = hello?.monitors || [];
            const realMonitors = monitors.filter(m => m.index !== 0);
            let monitor = realMonitors[0] || null;
            if (realMonitors.length > 1) {
                const center = { x: Math.round((freshWindow.rect.left + freshWindow.rect.right) / 2), y: Math.round((freshWindow.rect.top + freshWindow.rect.bottom) / 2) };
                const target = monitorForPoint(monitors, center);
                const cursor = await this._call('cursor', {}, 3000).catch(() => null);
                const cursorMonitor = monitorForPoint(monitors, cursor);
                if (target && cursorMonitor && target !== cursorMonitor) {
                    await this._call('move_mouse', center, 3000).catch(() => {});
                }
                monitor = target || cursorMonitor || monitor;
            }
            if (!monitor) throw new WorkerError('no_monitor', '无法确定显示器');
            const capture = await this.screenshots.captureDisplay({
                maxLongEdge: this.config.screenshot_max_long_edge,
                jpegQuality: this.config.screenshot_jpeg_quality,
                timeoutMs: this.config.observe_timeout_ms
            });
            mapping = buildMapping(monitor, { width: capture.width, height: capture.height }, options.scope === 'screen' ? null : freshWindow.rect);
            shot = this.screenshots.cropImage(capture, mapping, this.config.screenshot_jpeg_quality);
            mapping.renderedWidth = shot.width;
            mapping.renderedHeight = shot.height;
        }

        let uiTree = null;
        if (options.includeUiTree) {
            uiTree = await this._call('ui_tree', {
                id: freshWindow.id,
                depth: options.treeDepth || this.config.ui_tree_default_depth,
                max_children: 25,
                max_elements: 150,
                doc_max_chars: this.config.document_text_max_chars
            }, this.config.observe_timeout_ms).catch(error => {
                this._log('warn', `UI 树读取失败: ${error.message}`);
                return { elements: [], focused_element: null, document_text: '', selected_text: '', truncated: false, error: error.message };
            });
        }

        const observation = this.observations.create({
            window: freshWindow,
            mapping,
            uiTree,
            screenshotIncluded: !!shot,
            scope: options.scope || 'window'
        });
        const policyInfo = this.policy.describe(freshWindow);
        let message = formatObservation({
            observation, policyInfo, uiTree,
            limits: { uiTreeMaxChars: this.config.ui_tree_max_chars, documentTextMaxChars: this.config.document_text_max_chars }
        });
        if (uiTree?.error) message += `\n（UI 树读取失败：${compactText(uiTree.error, 120)}）`;
        if (policyInfo.needsFirstUseConfirm) message += `\n提示：首次操作 ${freshWindow.process_name} 时会先请主人确认。`;
        if (prefix) message = `${prefix}\n${message}`;

        this.audit.event('info', 'observe', {
            window: freshWindow.process_name, obs: observation.id,
            summary: `${options.scope || 'window'} 截图=${!!shot} 树=${uiTree ? uiTree.element_count ?? uiTree.elements?.length ?? 0 : '-'}`
        });
        if (this.config.save_debug_screenshots && shot) this._saveDebugScreenshot(observation.id, shot.base64);
        if (shot) return { _isScreenshot: true, base64: shot.base64, message };
        return message;
    }

    _saveDebugScreenshot(id, base64) {
        try {
            const fs = require('fs');
            const dir = path.join(this.dataDir, 'screenshots');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, `${id}.jpg`), Buffer.from(base64, 'base64'));
        } catch (_) {}
    }

    /** Shared pipeline for click / type / press_key / scroll / drag / set_value. */
    async _inputTool(action, params) {
        const validation = this.observations.validate(params.observation_id);
        if (!validation.ok) {
            this.audit.event('warn', 'stale_observation', { summary: `${action}: ${validation.code}` });
            return `${validation.reason}。`;
        }
        const observation = validation.observation;
        const window = await this._call('window_info', { id: observation.windowId }).catch(() => null);
        if (!window) return `目标窗口（window_id=${observation.windowId}）已经不存在了，请重新 computer_list_windows。`;

        const denied = this._authorize('input', window);
        if (denied) return denied;

        const kind = action === 'type' || action === 'set_value' ? 'type' : action === 'press_key' ? 'keys' : 'click';
        const check = this.policy.check(window, kind);
        if (!check.allowed) {
            this.audit.event('warn', 'denied', { window: window.process_name, summary: check.reason });
            return `${check.reason}。`;
        }

        const plan = this._planAction(action, params, observation, window);
        if (plan.error) return plan.error;

        const confirmReasons = [];
        if (check.needsFirstUseConfirm) confirmReasons.push(`这是本次会话第一次操作 ${window.process_name}`);
        if (check.confirmEach) confirmReasons.push(`${check.categoryLabel}属于每步都要确认的应用`);
        if (plan.chord?.closes) confirmReasons.push('这个组合键会关闭窗口或标签');
        if (plan.chord?.destructive && ['system_ui', 'browser'].includes(check.category)) confirmReasons.push('在这类应用里按 Delete 可能删除文件或内容');
        if (plan.chord?.submits && check.category === 'browser' && this.config.require_confirm_for_enter) confirmReasons.push('在浏览器里按 Enter 可能提交表单或发送消息');
        if (kind === 'type' && this.config.require_confirm_for_typing) confirmReasons.push('设置要求输入文字前确认');

        const execute = async () => this._executeAction(action, plan, observation, window, params);
        if (!this.config.autonomous_control && confirmReasons.length) {
            const item = this.pending.create({
                kind: check.needsFirstUseConfirm ? 'first_use' : 'action',
                summary: plan.summary,
                reason: confirmReasons.join('；'),
                window,
                params,
                execute
            });
            this.audit.event('info', 'confirm_required', { window: window.process_name, obs: observation.id, summary: `${this.config.log_typed_text ? plan.summary : (plan.auditSummary || plan.summary)} —— ${item.reason}` });
            this.banner?.waitConfirm(`等你点头：${plan.auditSummary || plan.summary}`);
            return PendingActions.describe(item);
        }
        return execute();
    }

    /** Resolves parameters into physical coordinates / worker ops without performing anything. */
    _planAction(action, params, observation, window) {
        try {
            switch (action) {
                case 'click': {
                    const button = ['left', 'right', 'middle'].includes(params.button) ? params.button : 'left';
                    const count = toInt(params.count, 1, 1, 3);
                    if (params.element_index !== undefined && params.element_index !== null) {
                        const { element, rect } = this.observations.elementRect(observation, params.element_index);
                        const point = { x: Math.round((rect.left + rect.right) / 2), y: Math.round((rect.top + rect.bottom) / 2) };
                        return { op: 'click', args: { ...point, button, count }, summary: `${count > 1 ? `${count}连` : ''}${buttonLabel(button)}点击元素 [${element.index}] ${element.type} "${compactText(element.name, 30)}"`, point };
                    }
                    if (params.x === undefined || params.y === undefined) return { error: '点击需要 element_index 或 x,y 坐标。' };
                    const point = this.observations.toScreen(observation, params.x, params.y);
                    return { op: 'click', args: { ...point, button, count }, summary: `${count > 1 ? `${count}连` : ''}${buttonLabel(button)}点击截图坐标 (${params.x},${params.y})`, point };
                }
                case 'type': {
                    const text = String(params.text ?? '');
                    if (!text) return { error: '要输入的文字为空。' };
                    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) return { error: '文本包含控制字符，已拒绝。' };
                    if (!this.observations.focusIsEditable(observation) && observation.uiTree) {
                        return { error: `最新观察显示焦点不在可编辑控件上（${observation.focused ? observation.focused.type : '未知'}）。请先点击输入区域，再重新观察后输入。` };
                    }
                    return {
                        op: 'type_text',
                        args: { text, mode: this.config.unicode_input_mode },
                        summary: `输入文字 “${compactText(text, 40)}”（${[...text].length} 字）`,
                        auditSummary: `输入文字（${[...text].length} 字）`
                    };
                }
                case 'press_key': {
                    const chord = classifyChord(params.key, { autonomousControl: this.config.autonomous_control });
                    if (!chord.ok) return { error: chord.denied ? `${chord.reason}。` : `按键无法识别：${chord.reason}。` };
                    const repeat = toInt(params.repeat, 1, 1, 20);
                    return { op: 'press_key', args: { key: chord.canonical, repeat }, summary: `按键 ${chord.canonical}${repeat > 1 ? ` ×${repeat}` : ''}`, chord };
                }
                case 'scroll': {
                    if (params.x === undefined || params.y === undefined) return { error: '滚动需要 x,y 坐标。' };
                    const point = this.observations.toScreen(observation, params.x, params.y);
                    const dy = toInt(params.delta_y, 0, -30, 30);
                    const dx = toInt(params.delta_x, 0, -30, 30);
                    if (!dy && !dx) return { error: 'delta_y / delta_x 不能都为 0。' };
                    return { op: 'scroll', args: { ...point, delta_y: dy, delta_x: dx }, summary: `在 (${params.x},${params.y}) 滚动 ${dy ? (dy > 0 ? `向下 ${dy}` : `向上 ${-dy}`) : ''}${dx ? ` 水平 ${dx}` : ''} 格`, point };
                }
                case 'drag': {
                    for (const k of ['from_x', 'from_y', 'to_x', 'to_y']) if (params[k] === undefined) return { error: `拖拽缺少参数 ${k}。` };
                    const from = this.observations.toScreen(observation, params.from_x, params.from_y);
                    const to = this.observations.toScreen(observation, params.to_x, params.to_y);
                    const duration = toInt(params.duration_ms, 500, 80, 10000);
                    return { op: 'drag', args: { from_x: from.x, from_y: from.y, to_x: to.x, to_y: to.y, duration_ms: duration }, summary: `从 (${params.from_x},${params.from_y}) 拖到 (${params.to_x},${params.to_y})`, point: from };
                }
                case 'set_value': {
                    const { element } = this.observations.elementRect(observation, params.element_index);
                    if (!element.editable) return { error: `元素 [${element.index}] ${element.type} 不是可编辑控件，不能直接赋值。` };
                    return {
                        op: 'set_value',
                        args: { id: window.id, index: element.index, value: String(params.value ?? '') },
                        summary: `把元素 [${element.index}] "${compactText(element.name, 30)}" 的内容设为 “${compactText(params.value, 40)}”`,
                        auditSummary: `把元素 [${element.index}] "${compactText(element.name, 30)}" 的内容替换（${[...String(params.value ?? '')].length} 字）`
                    };
                }
                default:
                    return { error: `未知动作 ${action}` };
            }
        } catch (error) {
            return { error: `${error.message}。` };
        }
    }

    async _executeAction(action, plan, observation, window, params) {
        const epoch = this.epoch;
        // Re-activate right before injecting so input can never land in another window.
        const activation = await this._call('activate_window', { id: window.id }).catch(error => ({ ok: false, error }));
        if (!activation.ok) {
            if (PASS_THROUGH_CODES.has(activation.error?.code)) throw activation.error;
            const actual = activation.error?.actual_foreground;
            throw new WorkerError(activation.error?.code || 'activate_failed', `目标窗口无法切到前台${actual ? `（当前前台：${this._windowLabel(actual)}）` : ''}，为避免误操作已取消动作`);
        }
        if (observation.generation !== this.worker?.generation || epoch !== this.epoch) {
            // The execution layer restarted (or was stopped) after this observation: refuse, nothing was sent.
            throw new WorkerError('worker_restarted', '桌面执行层在观察之后重启或被停止过，旧观察作废，本次动作没有发送', { resultKnown: true });
        }
        this._passThroughMouse();
        // Typed text never goes on screen: the audit summary only carries the character count.
        const stepText = plan.auditSummary || plan.summary;
        this._bannerStart(stepText);
        this.observations.consume(observation, action);
        const started = Date.now();
        const result = await this._call(plan.op, plan.args, this._actionTimeoutMs(plan));
        const facts = normalizeFacts(result, { ok: true });
        const count = this.gate.countAction();
        if (facts.waitedMs > 0 && !facts.yielded) this._bannerStart(stepText); // waited for the owner, then went ahead
        const bannerNote = bannerStatus(facts);
        if (bannerNote) { if (bannerNote.kind === 'pause') this.banner?.pause(bannerNote.text); else this._bannerStop(bannerNote.text); }
        this.lastOutcome = { tool: `computer_${action}`, at: Date.now(), ok: true, code: null, stoppedReason: facts.stoppedReason, resultKnown: facts.resultKnown, typed: facts.typed, inputTotal: facts.inputTotal, generation: facts.generation };
        const auditSummary = this.config.log_typed_text ? plan.summary : (plan.auditSummary || plan.summary);
        this.audit.event('info', action, {
            window: window.process_name, obs: observation.id,
            summary: `${auditSummary} (${Date.now() - started}ms, 本回合第 ${count} 个动作)`,
            facts,
            detail: { args: plan.args, result: action === 'set_value' ? { index: result?.index } : result }
        });

        const receipt = formatActionReceipt(facts);
        if (epoch !== this.epoch) {
            // Esc / stop / restart happened while the action was in flight: this receipt may describe a dead session.
            return `已发出：${plan.summary}。${receipt ? `\n${receipt}` : ''}\n执行期间被停止或执行层已失效（Esc、停止、重启或模式切换），这份回执可能已过期，动作效果未确认。不要继续或重放这一步；先 computer_observe 确认现状（若是被主人停止，则等主人重新下令）。`;
        }
        const summary = `已执行：${plan.summary}。${receipt ? `\n${receipt}` : ''}${facts.resultKnown ? '' : '\n动作结果未知，先根据下面的新观察核对，不要直接重复这一步。'}`;
        if (params.observe_after === false) {
            return `${summary}\n界面可能已变化；下一次带坐标或编号的动作前请重新 computer_observe。`;
        }
        await sleep(this.config.post_action_settle_ms);
        const fresh = await this._call('window_info', { id: window.id }).catch(() => null);
        if (!fresh) {
            this.observations.invalidateAll('window_closed');
            return `${summary}\n目标窗口随后消失了（可能已关闭或切换），请 computer_list_windows 重新确认。`;
        }
        return this._observe(fresh, {
            includeScreenshot: true,
            includeUiTree: !!observation.uiTree,
            treeDepth: this.config.ui_tree_default_depth,
            scope: observation.scope
        }, summary);
    }

    async _confirmAction(params) {
        if (this.config.autonomous_control) return '当前是完全自主控制模式，无需确认动作。请基于最新观察直接调用操作工具。';
        const denied = this._authorize('control');
        if (denied) return denied;
        if (this.gate.activeTurn?.kind !== 'owner') return '只有主人本人的回合才能确认电脑动作。';
        const item = this.pending.take(params.pending_action_id);
        if (!item) return `找不到待确认动作 ${params.pending_action_id || '(空)'}：可能已执行、已取消、已过期，或肥牛重启过。`;
        if (params.remember_app === true && item.processName) {
            this.policy.rememberApp(item.processName);
        }
        this.audit.event('info', 'confirmed', { window: item.processName, summary: `${item.summary}${params.remember_app ? '（本会话记住该应用）' : ''}` });
        return item.execute({ confirmed: true });
    }

    _cancelAction(params) {
        const count = this.pending.cancel(params.pending_action_id);
        this.audit.event('info', 'cancelled', { summary: `取消 ${count} 个待确认动作` });
        if (this.pending.size() === 0) this.banner?.finish();
        return count ? `已取消 ${count} 个待确认动作，没有执行。` : '没有需要取消的待确认动作。';
    }

    async _stop(params) {
        const reason = compactText(params.reason || '肥牛主动停止', 80);
        this.gate.abort(reason);
        this.observations.invalidateAll('stop');
        const cancelled = this.pending.cancel();
        this.lastWindowId = null;
        this.epoch += 1;
        this.lastStop = { reason: 'esc', at: Date.now(), tool: 'computer_stop' };
        this.audit.event('warn', 'stopped', { summary: `${reason}；取消 ${cancelled} 个待确认动作` });
        this._bannerStop('肥牛已停手');
        return `已停止电脑操作（${reason}）。本回合不再执行桌面动作；主人下一次下令后可以继续。`;
    }
}

function buttonLabel(button) {
    return { left: '左键', right: '右键', middle: '中键' }[button] || button;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

module.exports = FeiniuComputerUsePlugin;
Object.defineProperty(module.exports, 'readConfig', { value: readConfig, enumerable: false });
