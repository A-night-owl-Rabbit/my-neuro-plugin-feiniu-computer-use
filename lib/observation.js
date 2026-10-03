'use strict';

const { toScreen } = require('./screenshot.js');

// invalidateAll(reason) reasons that mean "the desktop execution layer itself went away or was replaced".
const WORKER_LIFECYCLE_LABELS = Object.freeze({
    worker_crashed: '意外退出并将重新启动',
    worker_exited: '已退出并将重新启动',
    worker_timeout: '因超时被重启',
    worker_stopped: '已被停止',
    worker_process_error: '进程出错并将重新启动',
    worker_config_changed: '因配置变化重启了'
});

/**
 * Observations are point-in-time snapshots. Codex's rule, enforced mechanically:
 * element indexes / coordinates are only valid for the observation that produced them,
 * and an observation is consumed by the first action performed after it.
 */
class ObservationStore {
    constructor(options = {}) {
        this.maxAgeMs = options.maxAgeMs || 90000;
        this.now = options.now || (() => Date.now());
        // Returns the current worker generation; an observation from an older generation is never usable.
        this.generationProvider = options.generationProvider || (() => undefined);
        this.sequence = 0;
        this.latestObservation = null;
    }

    create({ window, mapping = null, uiTree = null, screenshotIncluded = false, scope = 'window' }) {
        this.sequence += 1;
        const elements = new Map();
        if (uiTree && Array.isArray(uiTree.elements)) {
            for (const el of uiTree.elements) {
                if (el && Number.isInteger(el.index)) elements.set(el.index, el);
            }
        }
        const observation = {
            id: `obs_${this.sequence}`,
            createdAt: this.now(),
            generation: this.generationProvider(),
            window,
            windowId: window ? window.id : null,
            scope,
            mapping,
            screenshotIncluded,
            uiTree,
            elements,
            focused: uiTree ? uiTree.focused_element || null : null,
            consumed: false,
            consumedBy: null
        };
        this.latestObservation = observation;
        return observation;
    }

    latest() {
        return this.latestObservation;
    }

    /** Returns { ok: true, observation } or { ok: false, code, reason }. */
    validate(observationId) {
        const id = String(observationId || '').trim();
        const latest = this.latestObservation;
        if (!id) return { ok: false, code: 'missing_observation', reason: '缺少 observation_id，请先调用 computer_observe' };
        if (!latest) return { ok: false, code: 'no_observation', reason: '还没有任何观察，请先调用 computer_observe' };
        if (latest.id !== id) {
            return { ok: false, code: 'stale_observation', reason: `observation_id ${id} 已过期，最新的是 ${latest.id}；请基于最新观察操作，或重新 computer_observe` };
        }
        const current = this.generationProvider();
        if (latest.generation !== current) {
            return { ok: false, code: 'worker_restarted', reason: `观察 ${id} 属于已经重启或失效的桌面执行层（worker_restarted：generation ${latest.generation ?? '?'} → ${current ?? '?'}），编号和坐标全部作废，动作没有发送；请重新 computer_observe，不要重放旧动作` };
        }
        if (latest.consumed && latest.workerLifecycle) {
            // The execution layer exited / restarted after this observation (and no action had used it yet).
            return { ok: false, code: 'worker_restarted', reason: `观察 ${id} 之后桌面执行层（worker）${WORKER_LIFECYCLE_LABELS[latest.workerLifecycle] || '重启或退出了'}（worker_restarted，generation ${latest.generation ?? '?'}），编号和坐标全部作废，动作没有发送，也没有被重放；请重新 computer_observe` };
        }
        if (latest.consumed) {
            return { ok: false, code: 'consumed_observation', reason: `观察 ${id} 之后已经执行过动作（${latest.consumedBy}），界面可能变了，请重新 computer_observe` };
        }
        if (this.now() - latest.createdAt > this.maxAgeMs) {
            return { ok: false, code: 'expired_observation', reason: `观察 ${id} 已超过 ${Math.round(this.maxAgeMs / 1000)} 秒，请重新 computer_observe` };
        }
        return { ok: true, observation: latest };
    }

    consume(observation, actionName) {
        if (!observation) return;
        observation.consumed = true;
        observation.consumedBy = actionName;
    }

    invalidateAll(reason = 'reset') {
        const latest = this.latestObservation;
        if (!latest) return;
        // The first cause wins: an observation already used by an action must keep saying so, and one that a
        // worker restart killed must not later be described as "an action ran".
        if (latest.consumed) return;
        latest.consumed = true;
        latest.consumedBy = reason;
        if (/^worker_/.test(String(reason))) latest.workerLifecycle = reason;
    }

    /** Screenshot coordinates -> physical screen coordinates. */
    toScreen(observation, x, y) {
        if (!observation.mapping) throw new Error('这次观察没有截图，不能按坐标操作；请用元素编号，或重新观察并带截图');
        return toScreen(observation.mapping, x, y);
    }

    elementRect(observation, index) {
        const idx = Number(index);
        if (!Number.isInteger(idx)) throw new Error('element_index 必须是整数');
        const element = observation.elements.get(idx);
        if (!element) throw new Error(`元素编号 ${idx} 不在观察 ${observation.id} 的 UI 树里（共 ${observation.elements.size} 项）`);
        if (!element.rect) throw new Error(`元素编号 ${idx} 没有可点击区域`);
        return { element, rect: element.rect };
    }

    focusIsEditable(observation) {
        const focused = observation.focused;
        return !!(focused && focused.editable);
    }
}

module.exports = { ObservationStore };
