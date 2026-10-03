'use strict';

/**
 * Actions that need the owner's explicit consent are parked here (same pattern as
 * browser-harness). The model relays the question; the owner answers; the model calls
 * computer_confirm_action / computer_cancel_action.
 */
class PendingActions {
    constructor(options = {}) {
        this.ttlMs = options.ttlMs || 10 * 60 * 1000;
        this.now = options.now || (() => Date.now());
        // A parked closure belongs to the worker generation it was created under.
        this.generationProvider = options.generationProvider || (() => undefined);
        this.items = new Map();
        this.sequence = 0;
    }

    create({ kind, summary, reason, window, params, execute }) {
        this._prune();
        this.sequence += 1;
        const id = `cu_${this.now().toString(36)}_${this.sequence}`;
        const item = {
            id,
            kind,
            summary,
            reason: reason || '',
            window: window || null,
            processName: String(window?.process_name || '').toLowerCase(),
            params: params ? { ...params } : {},
            execute,
            generation: this.generationProvider(),
            createdAt: this.now()
        };
        this.items.set(id, item);
        return item;
    }

    get(id) {
        this._prune();
        const item = this.items.get(String(id || '').trim()) || null;
        if (item && item.generation !== this.generationProvider()) {
            this.items.delete(item.id);
            return null;
        }
        return item;
    }

    take(id) {
        const item = this.get(id);
        if (item) this.items.delete(item.id);
        return item;
    }

    cancel(id) {
        if (!id) {
            const count = this.items.size;
            this.items.clear();
            return count;
        }
        return this.items.delete(String(id).trim()) ? 1 : 0;
    }

    list() {
        this._prune();
        return [...this.items.values()];
    }

    size() {
        this._prune();
        return this.items.size;
    }

    _prune() {
        const cutoff = this.now() - this.ttlMs;
        for (const [id, item] of this.items) {
            if (item.createdAt < cutoff) this.items.delete(id);
        }
    }

    /** Text handed back to the model when an action is parked. */
    static describe(item) {
        return [
            '这个电脑操作需要主人确认，还没有执行。',
            `待确认动作 ID：${item.id}`,
            `动作：${item.summary}`,
            item.reason ? `原因：${item.reason}` : '',
            item.window ? `目标窗口：${item.window.title || ''}（${item.window.process_name || ''}）` : '',
            `请用自己的口吻把要做的事告诉主人；主人明确同意后调用 computer_confirm_action，参数 {"pending_action_id":"${item.id}"}` +
            (item.kind === 'first_use' ? '，若主人说"以后都可以"则再加 "remember_app": true' : '') + '。',
            '主人拒绝或没有明确表态时调用 computer_cancel_action，不要自行执行。'
        ].filter(Boolean).join('\n');
    }
}

module.exports = { PendingActions };
