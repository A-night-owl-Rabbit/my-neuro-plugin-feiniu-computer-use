'use strict';

const { toBool, toInt } = require('./utils.js');

/**
 * Top-of-screen "肥牛正在使用电脑中" banner (Codex's "ChatGPT is using your computer").
 *
 * Pure state machine + optional DOM renderer. Everything environmental (document,
 * ipcRenderer, timers, editing-mode probe) is injectable so the logic is unit-testable
 * and degrades to a silent state machine when there is no DOM.
 *
 *   hidden -start-> active -step-> active
 *   active -waitConfirm-> waiting -start-> active
 *   active -pause-> paused -start-> active
 *   any visible -stop-> stopped -(2s)-> hidden
 *   any visible -finish-> (linger) -> hidden
 *   any -reset-> hidden (immediately)
 *   any visible -(idle timeout)-> hidden
 */

const BANNER_STATES = Object.freeze(['hidden', 'active', 'waiting', 'paused', 'stopped']);
const BANNER_MODES = Object.freeze(['top', 'subtitle', 'off']);
const BANNER_THEMES = Object.freeze(['pink', 'dark']);
const TITLE = '肥牛正在使用电脑中';
const ESC_HINT = '按 Esc 停止';
const ELEMENT_ID = 'computer-use-banner';
const STYLE_ID = 'computer-use-banner-style';
const STOPPED_HOLD_MS = 2000;
const HIDE_ANIMATION_MS = 350;

function normalizeBannerConfig(raw = {}) {
    let mode = String(raw.banner_mode ?? '').trim().toLowerCase();
    if (!BANNER_MODES.includes(mode)) {
        // Legacy switch: show_banner_subtitle=false used to mean "no banner at all".
        mode = raw.banner_mode === undefined && raw.show_banner_subtitle !== undefined && !toBool(raw.show_banner_subtitle, true)
            ? 'off'
            : 'top';
    }
    const theme = String(raw.banner_theme ?? '').trim().toLowerCase();
    const scale = Number(raw.banner_scale);
    return {
        banner_mode: mode,
        banner_theme: BANNER_THEMES.includes(theme) ? theme : 'pink',
        banner_show_step: toBool(raw.banner_show_step, true),
        banner_esc_hint: toBool(raw.banner_esc_hint, true),
        banner_offset_top: toInt(raw.banner_offset_top, 12, 0, 2000),
        banner_scale: Number.isFinite(scale) ? Math.min(2, Math.max(0.6, scale)) : 1,
        banner_linger_ms: toInt(raw.banner_linger_ms, 1500, 0, 60000),
        banner_idle_timeout_ms: toInt(raw.banner_idle_timeout_ms, 90000, 0, 3600000)
    };
}

function buildBannerCss() {
    return `
#${ELEMENT_ID} {
    position: fixed;
    top: 12px;
    left: 50%;
    z-index: 1200;
    display: none;
    align-items: center;
    gap: 10px;
    padding: 10px 18px 10px 14px;
    border-radius: 999px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif;
    font-size: 15px;
    font-weight: 600;
    line-height: 1.4;
    white-space: nowrap;
    pointer-events: none;
    user-select: none;
    opacity: 0;
    transform: translate(-50%, -14px) scale(var(--cu-scale, 1));
    transform-origin: top center;
    transition: opacity .25s ease, transform .25s cubic-bezier(.2, .8, .2, 1);
}
#${ELEMENT_ID}.is-visible {
    opacity: var(--cu-opacity, .96);
    transform: translate(-50%, 0) scale(var(--cu-scale, 1));
}
#${ELEMENT_ID}.is-hiding {
    transition: opacity .35s ease, transform .35s ease;
}
#${ELEMENT_ID} [hidden] { display: none !important; }

/* ---- pink: same family as the thinking / inner-voice bubbles ---- */
#${ELEMENT_ID}.cu-theme-pink {
    background: linear-gradient(145deg, #fff0f5 0%, #ffe4f0 40%, #ffd6ec 100%);
    border: 2.5px solid #ffb6d3;
    color: #d63384;
    box-shadow: 0 8px 24px rgba(255, 105, 180, .22), 0 2px 8px rgba(255, 105, 180, .14), inset 0 1px 0 rgba(255, 255, 255, .9);
}
#${ELEMENT_ID}.cu-theme-pink[data-state="waiting"] {
    background: linear-gradient(145deg, #fff8e8 0%, #ffefc2 100%);
    border-color: #f3c86b;
    color: #9a6400;
    box-shadow: 0 8px 24px rgba(243, 200, 107, .25), inset 0 1px 0 rgba(255, 255, 255, .9);
}
#${ELEMENT_ID}.cu-theme-pink[data-state="paused"] {
    background: linear-gradient(145deg, #f4f4f6 0%, #e6e6ea 100%);
    border-color: #c5c5cc;
    color: #5c5c66;
    box-shadow: 0 8px 24px rgba(90, 90, 100, .18), inset 0 1px 0 rgba(255, 255, 255, .9);
}
#${ELEMENT_ID}.cu-theme-pink[data-state="stopped"] {
    background: linear-gradient(145deg, #fff0f0 0%, #ffdcdc 100%);
    border-color: #f0a0a0;
    color: #b3261e;
    box-shadow: 0 8px 24px rgba(240, 120, 120, .22), inset 0 1px 0 rgba(255, 255, 255, .9);
}
#${ELEMENT_ID}.cu-theme-pink .cu-banner-hint { background: rgba(214, 51, 132, .08); }

/* ---- dark: Codex-style capsule ---- */
#${ELEMENT_ID}.cu-theme-dark {
    background: rgba(28, 28, 32, .82);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    border: 1px solid rgba(255, 255, 255, .14);
    color: #ffffff;
    box-shadow: 0 8px 28px rgba(0, 0, 0, .35);
}
#${ELEMENT_ID}.cu-theme-dark[data-state="waiting"] { border-color: rgba(255, 196, 84, .7); color: #ffd88a; }
#${ELEMENT_ID}.cu-theme-dark[data-state="paused"] { border-color: rgba(200, 200, 210, .4); color: #c9c9d1; }
#${ELEMENT_ID}.cu-theme-dark[data-state="stopped"] { border-color: rgba(255, 120, 120, .7); color: #ffb3b3; }
#${ELEMENT_ID}.cu-theme-dark .cu-banner-hint { background: rgba(255, 255, 255, .12); }

/* ---- parts ---- */
#${ELEMENT_ID} .cu-banner-dot {
    flex-shrink: 0;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: currentColor;
    animation: cu-banner-pulse 1.6s ease-in-out infinite;
}
#${ELEMENT_ID}[data-state="paused"] .cu-banner-dot,
#${ELEMENT_ID}[data-state="stopped"] .cu-banner-dot {
    animation: none;
    opacity: .6;
}
#${ELEMENT_ID} .cu-banner-sep { opacity: .5; }
#${ELEMENT_ID} .cu-banner-step {
    font-weight: 500;
    opacity: .92;
    max-width: 46vw;
    overflow: hidden;
    text-overflow: ellipsis;
}
#${ELEMENT_ID} .cu-banner-hint {
    margin-left: 6px;
    padding: 2px 9px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    opacity: .85;
}
@keyframes cu-banner-pulse {
    0%, 100% { transform: scale(1); opacity: 1; }
    50% { transform: scale(.7); opacity: .55; }
}
`.trim();
}

function detectDocument() {
    return typeof document !== 'undefined' ? document : null;
}

function detectIpcRenderer() {
    try {
        return require('electron').ipcRenderer || null;
    } catch (_) {
        return null;
    }
}

function defaultIsEditing() {
    try {
        const g = typeof global !== 'undefined' ? global : {};
        return !!(g.bubbleLayout?.isEditing?.() || g.uiController?.isAdjustingSubtitle);
    } catch (_) {
        return false;
    }
}

class ComputerUseBanner {
    constructor(options = {}) {
        this.document = 'document' in options ? options.document : detectDocument();
        this.ipcRenderer = 'ipcRenderer' in options ? options.ipcRenderer : detectIpcRenderer();
        this.now = options.now || (() => Date.now());
        this.setTimeoutImpl = options.setTimeout || ((fn, ms) => setTimeout(fn, ms));
        this.clearTimeoutImpl = options.clearTimeout || (id => clearTimeout(id));
        this.raf = options.requestAnimationFrame
            || (typeof requestAnimationFrame === 'function' ? fn => requestAnimationFrame(fn) : fn => this.setTimeoutImpl(fn, 16));
        this.isEditing = options.isEditing || defaultIsEditing;
        this.log = options.log || (() => {});

        this.state = 'hidden';
        this.visible = false;
        this.mounted = false;
        this.stepText = '';
        this.statusText = '';
        this.timers = { hide: null, idle: null, display: null };
        this.elements = null;
        this.leftCache = null;
        this.configure(options.config || {});
    }

    // ------------------------------------------------------------------ config
    configure(config = {}) {
        this.config = normalizeBannerConfig(config);
        if (!this.enabled && this.state !== 'hidden') this.reset();
        this._render();
    }

    get enabled() {
        return this.config.banner_mode === 'top';
    }

    /** Full text a reader would see, used by tests and the doctor tool. */
    get text() {
        switch (this.state) {
            case 'active':
                return [TITLE, this.config.banner_show_step && this.stepText ? this.stepText : '', this.config.banner_esc_hint ? ESC_HINT : '']
                    .filter(Boolean).join(' · ');
            case 'waiting':
            case 'paused':
                return [TITLE, this.statusText, this.config.banner_esc_hint ? ESC_HINT : ''].filter(Boolean).join(' · ');
            case 'stopped':
                return this.statusText || '肥牛已停手';
            default:
                return '';
        }
    }

    snapshot() {
        return { state: this.state, visible: this.visible, mounted: this.mounted, text: this.text, mode: this.config.banner_mode, theme: this.config.banner_theme };
    }

    // ------------------------------------------------------------------ transitions
    /** Enter (or return to) the active state with a fresh step line. */
    start(stepText = '') {
        if (!this.enabled) return this.state;
        this.state = 'active';
        this.stepText = String(stepText || '');
        this._clearTimer('hide');
        this._armIdle();
        this._show();
        return this.state;
    }

    /** Update the step line without touching the state; no-op while hidden. */
    step(stepText = '') {
        if (!this.enabled || this.state === 'hidden') return this.state;
        this.stepText = String(stepText || '');
        this._clearTimer('hide');
        this._armIdle();
        this._render();
        return this.state;
    }

    resume(stepText = '') {
        return this.start(stepText);
    }

    waitConfirm(text = '等你点头') {
        return this._status('waiting', text);
    }

    pause(text = '你在动鼠标，肥牛先停一下') {
        return this._status('paused', text);
    }

    /** Esc / computer_stop: show the stop notice briefly, then hide. */
    stop(text = '肥牛已停手') {
        if (!this.enabled || this.state === 'hidden') return this.state;
        this.state = 'stopped';
        this.statusText = String(text || '肥牛已停手');
        this._clearTimer('idle');
        this._clearTimer('hide');
        this.timers.hide = this.setTimeoutImpl(() => {
            this.timers.hide = null;
            this._hide(false);
        }, STOPPED_HOLD_MS);
        this._render();
        return this.state;
    }

    /** Turn finished: linger so the owner sees the last step, then fade out. */
    finish() {
        if (this.state === 'hidden' || this.state === 'stopped') return this.state;
        this._clearTimer('hide');
        const linger = this.config.banner_linger_ms;
        if (linger <= 0) {
            this._hide(false);
            return this.state;
        }
        this.timers.hide = this.setTimeoutImpl(() => {
            this.timers.hide = null;
            this._hide(false);
        }, linger);
        return this.state;
    }

    /** New owner instruction / unload: drop everything immediately. */
    reset() {
        this._clearTimer('hide');
        this._clearTimer('idle');
        this._hide(true);
        return this.state;
    }

    _status(state, text) {
        if (!this.enabled) return this.state;
        this.state = state;
        this.statusText = String(text || '');
        this._clearTimer('hide');
        this._armIdle();
        this._show();
        return this.state;
    }

    // ------------------------------------------------------------------ timers
    _armIdle() {
        this._clearTimer('idle');
        const timeout = this.config.banner_idle_timeout_ms;
        if (timeout <= 0) return;
        this.timers.idle = this.setTimeoutImpl(() => {
            this.timers.idle = null;
            this.log('info', '顶部提示条空闲超时，自动收起');
            this._hide(false);
        }, timeout);
    }

    _clearTimer(name) {
        if (this.timers[name] !== null && this.timers[name] !== undefined) {
            this.clearTimeoutImpl(this.timers[name]);
            this.timers[name] = null;
        }
    }

    // ------------------------------------------------------------------ DOM
    mount() {
        const doc = this.document;
        if (!doc) return false;
        try {
            if (!doc.getElementById(STYLE_ID)) {
                const style = doc.createElement('style');
                style.id = STYLE_ID;
                style.textContent = buildBannerCss();
                doc.head.appendChild(style);
            }
            let root = doc.getElementById(ELEMENT_ID);
            if (!root) {
                root = doc.createElement('div');
                root.id = ELEMENT_ID;
                root.className = 'cu-banner';
                root.setAttribute?.('aria-live', 'polite');
                const parts = {};
                for (const [key, cls] of [['dot', 'cu-banner-dot'], ['title', 'cu-banner-title'], ['sep', 'cu-banner-sep'], ['step', 'cu-banner-step'], ['hint', 'cu-banner-hint']]) {
                    const span = doc.createElement('span');
                    span.className = cls;
                    root.appendChild(span);
                    parts[key] = span;
                }
                parts.sep.textContent = '·';
                doc.body.appendChild(root);
                this.elements = { root, ...parts };
            } else {
                this.elements = {
                    root,
                    dot: root.querySelector('.cu-banner-dot'),
                    title: root.querySelector('.cu-banner-title'),
                    sep: root.querySelector('.cu-banner-sep'),
                    step: root.querySelector('.cu-banner-step'),
                    hint: root.querySelector('.cu-banner-hint')
                };
            }
            this.mounted = true;
            this.leftCache = this._computeLeft();
            this._render();
            return true;
        } catch (error) {
            this.log('warn', `顶部提示条挂载失败: ${error.message}`);
            this.mounted = false;
            return false;
        }
    }

    unmount() {
        this._clearTimer('hide');
        this._clearTimer('idle');
        this._clearTimer('display');
        this.state = 'hidden';
        this.visible = false;
        const doc = this.document;
        if (doc) {
            try { doc.getElementById(ELEMENT_ID)?.remove(); } catch (_) {}
            try { doc.getElementById(STYLE_ID)?.remove(); } catch (_) {}
        }
        this.elements = null;
        this.mounted = false;
    }

    /** Horizontal centre of the primary display, expressed in the window's CSS pixels. */
    _computeLeft() {
        try {
            const info = this.ipcRenderer?.sendSync?.('get-screen-info-sync');
            const primary = info?.primaryDisplay?.bounds;
            const win = info?.windowBounds;
            if (primary && win && [primary.x, primary.width, win.x].every(Number.isFinite)) {
                return `${Math.round((primary.x - win.x) + primary.width / 2)}px`;
            }
        } catch (_) {
            // fall through to the CSS default
        }
        return '50%';
    }

    _show() {
        this._clearTimer('display');
        if (this.isEditing()) {
            // Never fight the subtitle / bubble editors; the state machine still runs.
            this.visible = false;
            this._render();
            return;
        }
        const wasVisible = this.visible;
        this.visible = true;
        if (!this.mounted || !this.elements) return;
        if (!wasVisible) this.leftCache = this._computeLeft();
        const { root } = this.elements;
        root.classList.remove('is-hiding');
        root.style.display = 'flex';
        this._render();
        if (!wasVisible) {
            this.raf(() => {
                if (this.visible && this.elements) this.elements.root.classList.add('is-visible');
            });
        } else {
            root.classList.add('is-visible');
        }
    }

    _hide(immediate) {
        this.state = 'hidden';
        this.stepText = '';
        this.statusText = '';
        this.visible = false;
        this._clearTimer('display');
        if (!this.mounted || !this.elements) return;
        const { root } = this.elements;
        root.classList.remove('is-visible');
        if (immediate) {
            root.classList.remove('is-hiding');
            root.style.display = 'none';
        } else {
            root.classList.add('is-hiding');
            this.timers.display = this.setTimeoutImpl(() => {
                this.timers.display = null;
                if (!this.visible && this.elements) {
                    this.elements.root.classList.remove('is-hiding');
                    this.elements.root.style.display = 'none';
                }
            }, HIDE_ANIMATION_MS);
        }
        this._render();
    }

    _render() {
        if (!this.mounted || !this.elements) return;
        const { root, title, sep, step, hint } = this.elements;
        const cfg = this.config;
        root.dataset.state = this.state;
        root.className = `cu-banner cu-theme-${cfg.banner_theme}${root.classList.contains('is-visible') ? ' is-visible' : ''}${root.classList.contains('is-hiding') ? ' is-hiding' : ''}`;
        root.style.top = `${cfg.banner_offset_top}px`;
        root.style.left = this.leftCache || '50%';
        root.style.setProperty('--cu-scale', String(cfg.banner_scale));

        const stopped = this.state === 'stopped';
        title.textContent = stopped ? (this.statusText || '肥牛已停手') : TITLE;

        let stepLine = '';
        if (this.state === 'active') stepLine = cfg.banner_show_step ? this.stepText : '';
        else if (this.state === 'waiting' || this.state === 'paused') stepLine = this.statusText;
        step.textContent = stepLine;
        step.hidden = !stepLine;
        sep.hidden = !stepLine;

        const showHint = cfg.banner_esc_hint && !stopped && this.state !== 'hidden';
        hint.textContent = ESC_HINT;
        hint.hidden = !showHint;
    }
}

module.exports = {
    ComputerUseBanner,
    normalizeBannerConfig,
    buildBannerCss,
    BANNER_STATES,
    BANNER_MODES,
    BANNER_THEMES,
    BANNER_TITLE: TITLE,
    BANNER_ELEMENT_ID: ELEMENT_ID,
    BANNER_STYLE_ID: STYLE_ID,
    STOPPED_HOLD_MS,
    HIDE_ANIMATION_MS
};
