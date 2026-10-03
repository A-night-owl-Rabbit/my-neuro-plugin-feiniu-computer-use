'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    ComputerUseBanner, normalizeBannerConfig, buildBannerCss,
    BANNER_TITLE, BANNER_ELEMENT_ID, BANNER_STYLE_ID, STOPPED_HOLD_MS, HIDE_ANIMATION_MS
} = require('../lib/banner.js');
const { makeFakeClock, makeFakeDocument } = require('./fake-worker.js');

function makeBanner(config = {}, extra = {}) {
    const clock = makeFakeClock();
    const logs = [];
    const banner = new ComputerUseBanner({
        config,
        document: extra.document === undefined ? null : extra.document,
        ipcRenderer: extra.ipcRenderer === undefined ? null : extra.ipcRenderer,
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        requestAnimationFrame: fn => clock.setTimeout(fn, 16),
        isEditing: extra.isEditing || (() => false),
        log: (level, message) => logs.push({ level, message })
    });
    return { banner, clock, logs };
}

// ------------------------------------------------------------------ config

test('normalizeBannerConfig: defaults, clamping and the legacy show_banner_subtitle switch', () => {
    const d = normalizeBannerConfig({});
    assert.deepEqual(d, {
        banner_mode: 'top', banner_theme: 'pink', banner_show_step: true, banner_esc_hint: true,
        banner_offset_top: 12, banner_scale: 1, banner_linger_ms: 1500, banner_idle_timeout_ms: 90000
    });
    assert.equal(normalizeBannerConfig({ banner_mode: 'SUBTITLE' }).banner_mode, 'subtitle');
    assert.equal(normalizeBannerConfig({ banner_mode: 'weird' }).banner_mode, 'top');
    assert.equal(normalizeBannerConfig({ show_banner_subtitle: false }).banner_mode, 'off', 'legacy false -> off');
    assert.equal(normalizeBannerConfig({ show_banner_subtitle: 'false', banner_mode: 'top' }).banner_mode, 'top', 'explicit mode wins');
    assert.equal(normalizeBannerConfig({ banner_theme: 'DARK' }).banner_theme, 'dark');
    assert.equal(normalizeBannerConfig({ banner_theme: 'neon' }).banner_theme, 'pink');
    assert.equal(normalizeBannerConfig({ banner_scale: '5' }).banner_scale, 2);
    assert.equal(normalizeBannerConfig({ banner_scale: 0.1 }).banner_scale, 0.6);
    assert.equal(normalizeBannerConfig({ banner_offset_top: -5 }).banner_offset_top, 0);
    assert.equal(normalizeBannerConfig({ banner_show_step: 'false' }).banner_show_step, false);
});

// ------------------------------------------------------------------ state machine (no DOM)

test('hidden -> start -> active with title, step and Esc hint', () => {
    const { banner } = makeBanner();
    assert.equal(banner.state, 'hidden');
    assert.equal(banner.text, '');
    assert.equal(banner.start('正在启动 记事本'), 'active');
    assert.equal(banner.visible, true);
    assert.equal(banner.text, `${BANNER_TITLE} · 正在启动 记事本 · 按 Esc 停止`);
});

test('step updates the line without changing state; step while hidden is a no-op', () => {
    const { banner } = makeBanner();
    assert.equal(banner.step('x'), 'hidden');
    assert.equal(banner.visible, false);
    banner.start('a');
    assert.equal(banner.step('点击元素 [3] 格式(O)'), 'active');
    assert.match(banner.text, /点击元素 \[3\] 格式\(O\)/);
});

test('waitConfirm / pause and back to active via start', () => {
    const { banner } = makeBanner();
    banner.start('a');
    assert.equal(banner.waitConfirm('等你点头：左键点击画布'), 'waiting');
    assert.equal(banner.text, `${BANNER_TITLE} · 等你点头：左键点击画布 · 按 Esc 停止`);
    assert.equal(banner.start('左键点击画布'), 'active');
    assert.equal(banner.pause('你在动鼠标，肥牛先停一下'), 'paused');
    assert.match(banner.text, /你在动鼠标/);
    assert.equal(banner.resume('继续'), 'active');
});

test('waitConfirm from hidden shows the banner (launch confirmation before any action)', () => {
    const { banner } = makeBanner();
    assert.equal(banner.waitConfirm('等你点头：启动 weird.exe'), 'waiting');
    assert.equal(banner.visible, true);
});

test('stop shows the notice then hides after the hold time; idle timer is dropped', () => {
    const { banner, clock } = makeBanner();
    banner.start('a');
    assert.equal(banner.stop('肥牛已停手'), 'stopped');
    assert.equal(banner.text, '肥牛已停手');
    clock.advance(STOPPED_HOLD_MS - 1);
    assert.equal(banner.state, 'stopped');
    clock.advance(1);
    assert.equal(banner.state, 'hidden');
    assert.equal(banner.visible, false);
    clock.advance(200000);
    assert.equal(banner.state, 'hidden', 'no stray idle timer fired anything weird');
});

test('stop while hidden does not pop the banner out of nowhere', () => {
    const { banner } = makeBanner();
    assert.equal(banner.stop('肥牛已停手'), 'hidden');
    assert.equal(banner.visible, false);
});

test('finish lingers then hides; a step during linger cancels the hide', () => {
    const { banner, clock } = makeBanner({ banner_linger_ms: 1500 });
    banner.start('a');
    assert.equal(banner.finish(), 'active');
    clock.advance(1499);
    assert.equal(banner.state, 'active');
    clock.advance(1);
    assert.equal(banner.state, 'hidden');

    banner.start('b');
    banner.finish();
    clock.advance(1000);
    banner.step('c');
    clock.advance(1000);
    assert.equal(banner.state, 'active', 'step cancelled the pending hide');
    assert.match(banner.text, /c/);
});

test('finish with linger 0 hides immediately; finish while stopped keeps the stop hold', () => {
    const { banner, clock } = makeBanner({ banner_linger_ms: 0 });
    banner.start('a');
    banner.finish();
    assert.equal(banner.state, 'hidden');

    banner.start('b');
    banner.stop('肥牛已停手');
    banner.finish();
    assert.equal(banner.state, 'stopped');
    clock.advance(STOPPED_HOLD_MS);
    assert.equal(banner.state, 'hidden');
});

test('reset hides immediately and clears every timer', () => {
    const { banner, clock } = makeBanner();
    banner.start('a');
    banner.finish();
    banner.reset();
    assert.equal(banner.state, 'hidden');
    assert.equal(clock.pending(), 0);
});

test('idle timeout hides a banner that nobody touched', () => {
    const { banner, clock, logs } = makeBanner({ banner_idle_timeout_ms: 90000 });
    banner.start('a');
    clock.advance(60000);
    banner.step('b');          // activity re-arms the idle timer
    clock.advance(89999);
    assert.equal(banner.state, 'active');
    clock.advance(1);
    assert.equal(banner.state, 'hidden');
    assert.ok(logs.some(l => /空闲超时/.test(l.message)));
});

test('banner_show_step=false drops the step; banner_esc_hint=false drops the hint', () => {
    const { banner } = makeBanner({ banner_show_step: false, banner_esc_hint: false });
    banner.start('正在启动 记事本');
    assert.equal(banner.text, BANNER_TITLE);
    banner.waitConfirm('等你点头');
    assert.equal(banner.text, `${BANNER_TITLE} · 等你点头`);
});

test('banner_mode=off / subtitle: transitions are inert and nothing becomes visible', () => {
    for (const mode of ['off', 'subtitle']) {
        const { banner } = makeBanner({ banner_mode: mode });
        assert.equal(banner.start('a'), 'hidden');
        assert.equal(banner.waitConfirm('b'), 'hidden');
        assert.equal(banner.pause('c'), 'hidden');
        assert.equal(banner.stop('d'), 'hidden');
        assert.equal(banner.visible, false);
    }
});

test('configure() switching away from top while visible hides at once', () => {
    const { banner } = makeBanner();
    banner.start('a');
    banner.configure({ banner_mode: 'off' });
    assert.equal(banner.state, 'hidden');
    banner.configure({ banner_mode: 'top' });
    assert.equal(banner.start('b'), 'active');
});

// ------------------------------------------------------------------ DOM rendering (fake document)

test('mount is idempotent, unmount removes element and style', () => {
    const doc = makeFakeDocument();
    const { banner } = makeBanner({}, { document: doc });
    assert.equal(banner.mount(), true);
    assert.equal(banner.mount(), true);
    assert.equal(doc.querySelectorAll(`#${BANNER_ELEMENT_ID}`).length, 1);
    assert.equal(doc.querySelectorAll(`#${BANNER_STYLE_ID}`).length, 1);
    assert.ok(doc.getElementById(BANNER_STYLE_ID).textContent.includes('cu-theme-dark'));
    banner.unmount();
    assert.equal(doc.getElementById(BANNER_ELEMENT_ID), null);
    assert.equal(doc.getElementById(BANNER_STYLE_ID), null);
    assert.equal(banner.mounted, false);
});

test('mount reuses an element left behind by a previous plugin instance', () => {
    const doc = makeFakeDocument();
    const first = makeBanner({}, { document: doc }).banner;
    first.mount();
    const second = makeBanner({}, { document: doc }).banner;
    second.mount();
    assert.equal(doc.querySelectorAll(`#${BANNER_ELEMENT_ID}`).length, 1);
    second.start('x');
    assert.equal(doc.getElementById(BANNER_ELEMENT_ID).querySelector('.cu-banner-step').textContent, 'x');
});

test('rendering: state attribute, theme class, texts, hidden parts, visibility classes', () => {
    const doc = makeFakeDocument();
    const { banner, clock } = makeBanner({ banner_theme: 'dark', banner_offset_top: 30, banner_scale: 1.25 }, { document: doc });
    banner.mount();
    const root = doc.getElementById(BANNER_ELEMENT_ID);
    assert.equal(root.dataset.state, 'hidden');
    assert.ok(root.classList.contains('cu-theme-dark'));
    assert.equal(root.style.top, '30px');
    assert.equal(root.style['--cu-scale'], '1.25');
    assert.equal(root.style.left, '50%', 'no ipc -> css centre');

    banner.start('正在观察 记事本');
    assert.equal(root.style.display, 'flex');
    assert.equal(root.classList.contains('is-visible'), false, 'class arrives on the next frame');
    clock.advance(16);
    assert.equal(root.classList.contains('is-visible'), true);
    assert.equal(root.dataset.state, 'active');
    assert.equal(root.querySelector('.cu-banner-title').textContent, BANNER_TITLE);
    assert.equal(root.querySelector('.cu-banner-step').textContent, '正在观察 记事本');
    assert.equal(root.querySelector('.cu-banner-step').hidden, false);
    assert.equal(root.querySelector('.cu-banner-sep').hidden, false);
    assert.equal(root.querySelector('.cu-banner-hint').hidden, false);

    banner.waitConfirm('等你点头：启动 画图');
    assert.equal(root.dataset.state, 'waiting');
    assert.equal(root.querySelector('.cu-banner-step').textContent, '等你点头：启动 画图');

    banner.stop('肥牛已停手');
    assert.equal(root.dataset.state, 'stopped');
    assert.equal(root.querySelector('.cu-banner-title').textContent, '肥牛已停手');
    assert.equal(root.querySelector('.cu-banner-step').hidden, true);
    assert.equal(root.querySelector('.cu-banner-hint').hidden, true);

    clock.advance(STOPPED_HOLD_MS);
    assert.equal(root.dataset.state, 'hidden');
    assert.equal(root.classList.contains('is-visible'), false);
    assert.equal(root.classList.contains('is-hiding'), true);
    assert.equal(root.style.display, 'flex', 'still shown while fading');
    clock.advance(HIDE_ANIMATION_MS);
    assert.equal(root.style.display, 'none');
    assert.equal(root.classList.contains('is-hiding'), false);
});

test('configure() re-renders theme and offsets live', () => {
    const doc = makeFakeDocument();
    const { banner } = makeBanner({}, { document: doc });
    banner.mount();
    banner.configure({ banner_theme: 'dark', banner_offset_top: 60 });
    const root = doc.getElementById(BANNER_ELEMENT_ID);
    assert.ok(root.classList.contains('cu-theme-dark'));
    assert.ok(!root.classList.contains('cu-theme-pink'));
    assert.equal(root.style.top, '60px');
});

test('left is the primary display centre in window pixels; ipc failure falls back to 50%', () => {
    const doc = makeFakeDocument();
    const ipc = {
        sendSync(channel) {
            assert.equal(channel, 'get-screen-info-sync');
            return {
                primaryDisplay: { bounds: { x: 0, y: 0, width: 2560, height: 1440 } },
                windowBounds: { x: -1920, y: 0, width: 4480, height: 1440 }
            };
        }
    };
    const { banner } = makeBanner({}, { document: doc, ipcRenderer: ipc });
    banner.mount();
    assert.equal(doc.getElementById(BANNER_ELEMENT_ID).style.left, '3200px');

    const broken = { sendSync() { throw new Error('no ipc'); } };
    const other = makeBanner({}, { document: makeFakeDocument(), ipcRenderer: broken }).banner;
    other.mount();
    assert.equal(other.leftCache, '50%');
});

test('editing mode keeps the banner invisible but the state machine keeps running', () => {
    const doc = makeFakeDocument();
    let editing = true;
    const { banner, clock } = makeBanner({}, { document: doc, isEditing: () => editing });
    banner.mount();
    banner.start('a');
    assert.equal(banner.state, 'active');
    assert.equal(banner.visible, false);
    const root = doc.getElementById(BANNER_ELEMENT_ID);
    assert.notEqual(root.style.display, 'flex');
    editing = false;
    banner.start('b');
    clock.advance(16);
    assert.equal(banner.visible, true);
    assert.equal(root.classList.contains('is-visible'), true);
});

test('css contains both themes, pointer-events none and the z-index above subtitles', () => {
    const css = buildBannerCss();
    assert.match(css, /pointer-events:\s*none/);
    assert.match(css, /z-index:\s*1200/);
    assert.match(css, /cu-theme-pink/);
    assert.match(css, /cu-theme-dark/);
    assert.match(css, /@keyframes cu-banner-pulse/);
});
