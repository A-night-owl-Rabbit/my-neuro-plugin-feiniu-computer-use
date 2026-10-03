'use strict';

const { splitList } = require('./utils.js');

const PROACTIVE_ORIGIN = 'feiniu-internal-proactive';

/**
 * Turn-level authorization (mirrors codex-bridge's security policy) plus the
 * per-turn action budget and the abort / owner-activity state.
 *
 *   onUserInput      -> captureInput(event)
 *   onLLMRequest     -> beginLLMRequest(request)   (fires again inside the screenshot loop)
 *   onLLMResponse    -> endLLMRequest()
 */
class ActionGate {
    constructor(config = {}) {
        this.now = config.now || (() => Date.now());
        this.configure(config);
        this.inputSequence = 0;
        this.latestInput = null;
        this.activeTurn = null;
        this.actionsThisTurn = 0;
        this.aborted = null;          // { reason, at } while an Esc / stop is in force
        this.ownerActive = null;      // { dx, dy, at } when the owner moved the mouse mid-task
    }

    configure(config = {}) {
        this.autonomousControl = config.autonomous_control === true;
        this.trustedSources = new Set(splitList(config.trusted_input_sources, ['text', 'voice']));
        this.allowProactive = this.autonomousControl || config.allow_proactive_control === true;
        this.trustedProactiveSources = new Set(splitList(config.trusted_proactive_sources, ['companion-director', 'mood-chat', 'auto-act', 'auto-chat']));
        this.proactiveAllowedApps = new Set(splitList(config.proactive_allowed_apps).map(s => s.toLowerCase()));
        this.maxActionsPerTurn = Math.max(1, Number(config.max_actions_per_turn) || 25);
        this.inputTtlMs = Math.max(10000, Number(config.input_ttl_ms) || 10 * 60 * 1000);
    }

    captureInput(event) {
        this.inputSequence += 1;
        this.latestInput = {
            sequence: this.inputSequence,
            source: String(event?.source || ''),
            text: String(event?.text || ''),
            receivedAt: this.now()
        };
        this.activeTurn = null;
        this.actionsThisTurn = 0;
        const trusted = this.trustedSources.has(this.latestInput.source);
        if (trusted) {
            // A fresh owner instruction clears a previous Esc / owner-activity pause.
            this.aborted = null;
            this.ownerActive = null;
        }
        return trusted;
    }

    beginLLMRequest(request) {
        const requestContext = request?.requestContext || {};
        if (requestContext.origin === PROACTIVE_ORIGIN) {
            const source = String(requestContext.proactiveSource || '');
            if (this.allowProactive && this.trustedProactiveSources.has(source)) {
                const id = `proactive:${requestContext.requestId || this.now()}`;
                if (this.activeTurn?.id !== id) this.actionsThisTurn = 0;
                this.activeTurn = { id, kind: 'proactive', source: `internal-proactive:${source}`, startedAt: this.now() };
            } else {
                this.activeTurn = { id: 'proactive-denied', kind: 'proactive_denied', source: `internal-proactive:${source}`, startedAt: this.now() };
            }
            return this.activeTurn.kind === 'proactive';
        }

        const input = this.latestInput;
        if (!input || !this.trustedSources.has(input.source)) {
            this.activeTurn = null;
            return false;
        }
        if (this.now() - input.receivedAt > this.inputTtlMs) {
            this.activeTurn = null;
            return false;
        }
        const id = `owner:${input.sequence}`;
        if (this.activeTurn?.id === id) return true;

        const messages = Array.isArray(request?.messages) ? request.messages : [];
        const lastUser = [...messages].reverse().find(m => m?.role === 'user');
        const content = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content || '');
        const expected = input.text.trim();
        if (expected && !String(content).includes(expected)) {
            this.activeTurn = null;
            return false;
        }
        this.activeTurn = { id, kind: 'owner', source: input.source, startedAt: this.now() };
        this.actionsThisTurn = 0;
        return true;
    }

    endLLMRequest() {
        this.activeTurn = null;
    }

    /** Called when the worker reports Esc, or the model calls computer_stop. */
    abort(reason) {
        this.aborted = { reason: reason || 'Esc', at: this.now() };
    }

    clearAbort() {
        this.aborted = null;
        this.ownerActive = null;
    }

    noteOwnerActivity(info) {
        this.ownerActive = { dx: info?.dx || 0, dy: info?.dy || 0, at: this.now() };
    }

    /**
     * Gate for any computer_* tool. kind: 'query' (list/doctor), 'observe', 'input', 'control'.
     * Returns { ok, code, reason, turn }.
     */
    authorize(kind, window = null) {
        const turn = this.activeTurn;
        if (!turn) {
            return { ok: false, code: 'untrusted_turn', reason: '电脑操作只接受主人本地文字或语音指令；这个回合不是主人的可信回合。' };
        }
        if (turn.kind === 'proactive_denied') {
            return { ok: false, code: 'proactive_disabled', reason: '肥牛主动回合默认不允许操作电脑（可在插件设置里打开 allow_proactive_control）。' };
        }
        if (kind === 'query') return { ok: true, turn };
        if (this.aborted && kind !== 'control') {
            return { ok: false, code: 'aborted', reason: `操作已被中断（${this.aborted.reason}），本回合不再执行动作；等主人重新下令。` };
        }
        if (!this.autonomousControl && turn.kind === 'proactive' && window && this.proactiveAllowedApps.size > 0) {
            const name = String(window.process_name || '').toLowerCase();
            if (!this.proactiveAllowedApps.has(name)) {
                return { ok: false, code: 'proactive_app_denied', reason: `主动回合只允许操作 ${[...this.proactiveAllowedApps].join('、')}，不包括 ${name}` };
            }
        }
        if (kind === 'input') {
            if (this.actionsThisTurn >= this.maxActionsPerTurn) {
                return { ok: false, code: 'turn_budget_exhausted', reason: `本回合已执行 ${this.actionsThisTurn} 个动作，达到上限；请如实汇报进度，本回合停止操作。这是动作预算上限，不是缺少操作授权。` };
            }
        }
        return { ok: true, turn };
    }

    countAction() {
        this.actionsThisTurn += 1;
        return this.actionsThisTurn;
    }

    snapshot() {
        return {
            activeTurn: this.activeTurn ? { ...this.activeTurn } : null,
            actionsThisTurn: this.actionsThisTurn,
            maxActionsPerTurn: this.maxActionsPerTurn,
            aborted: this.aborted,
            ownerActive: this.ownerActive,
            latestInputSource: this.latestInput?.source || null
        };
    }
}

module.exports = { ActionGate, PROACTIVE_ORIGIN };
