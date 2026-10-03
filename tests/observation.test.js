'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMapping, toScreen, monitorForPoint, intersectRects } = require('../lib/screenshot.js');
const { ObservationStore } = require('../lib/observation.js');

const MONITOR_4K = { index: 1, left: 0, top: 0, width: 3840, height: 2160 };

test('buildMapping: whole display keeps scale and origin at monitor corner', () => {
    const mapping = buildMapping(MONITOR_4K, { width: 1600, height: 900 }, null);
    assert.equal(mapping.mode, 'screen');
    assert.ok(Math.abs(mapping.scale - 1600 / 3840) < 1e-9);
    assert.deepEqual(mapping.origin, { x: 0, y: 0 });
    assert.equal(mapping.crop, null);
    const p = toScreen(mapping, 800, 450);
    assert.deepEqual(p, { x: 1920, y: 1080 });
});

test('buildMapping: window crop offsets origin and clamps to the window', () => {
    const windowRect = { left: 1578, top: 759, right: 3489, bottom: 1996 };
    const mapping = buildMapping(MONITOR_4K, { width: 1600, height: 900 }, windowRect);
    assert.equal(mapping.mode, 'window');
    assert.deepEqual(mapping.origin, { x: 1578, y: 759 });
    assert.equal(mapping.crop.x, Math.round(1578 * (1600 / 3840)));
    assert.equal(mapping.crop.y, Math.round(759 * (1600 / 3840)));
    // top-left of the cropped screenshot is the window's top-left in physical pixels
    assert.deepEqual(toScreen(mapping, 0, 0), { x: 1578, y: 759 });
    // far corner is clamped inside the window
    const far = toScreen(mapping, mapping.renderedWidth, mapping.renderedHeight);
    assert.ok(far.x <= 3488 && far.y <= 1995);
    assert.throws(() => toScreen(mapping, 5000, 10), /超出了截图范围/);
});

test('buildMapping: window on a secondary monitor uses that monitor origin', () => {
    const second = { index: 2, left: 3840, top: 0, width: 1920, height: 1080 };
    const windowRect = { left: 4000, top: 100, right: 4800, bottom: 700 };
    const mapping = buildMapping(second, { width: 1600, height: 900 }, windowRect);
    assert.deepEqual(mapping.origin, { x: 4000, y: 100 });
    assert.deepEqual(toScreen(mapping, 0, 0), { x: 4000, y: 100 });
    const mid = toScreen(mapping, mapping.renderedWidth / 2, mapping.renderedHeight / 2);
    assert.ok(Math.abs(mid.x - 4400) <= 2 && Math.abs(mid.y - 400) <= 2);
});

test('buildMapping: window entirely off the monitor is rejected', () => {
    assert.throws(() => buildMapping(MONITOR_4K, { width: 1600, height: 900 }, { left: 5000, top: 0, right: 5100, bottom: 100 }), /不在当前显示器/);
});

test('monitorForPoint picks the monitor containing the point and ignores the virtual index 0', () => {
    const monitors = [
        { index: 0, left: 0, top: 0, width: 5760, height: 2160 },
        MONITOR_4K,
        { index: 2, left: 3840, top: 0, width: 1920, height: 1080 }
    ];
    assert.equal(monitorForPoint(monitors, { x: 100, y: 100 }).index, 1);
    assert.equal(monitorForPoint(monitors, { x: 4000, y: 100 }).index, 2);
    assert.equal(monitorForPoint(monitors, null).index, 1);
    assert.equal(intersectRects({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 20, top: 20, right: 30, bottom: 30 }), null);
});

test('ObservationStore enforces latest / unconsumed / not expired', () => {
    let now = 1000;
    const store = new ObservationStore({ maxAgeMs: 5000, now: () => now });
    const window = { id: 7, title: 'x', process_name: 'notepad.exe' };
    const mapping = buildMapping(MONITOR_4K, { width: 1600, height: 900 }, null);

    assert.equal(store.validate('obs_1').code, 'no_observation');
    const obs1 = store.create({ window, mapping, uiTree: { elements: [{ index: 0, rect: { left: 0, top: 0, right: 100, bottom: 50 }, type: 'ButtonControl', name: '确定' }] }, screenshotIncluded: true });
    assert.equal(obs1.id, 'obs_1');
    assert.equal(store.validate('obs_1').ok, true);
    assert.equal(store.validate('').code, 'missing_observation');

    const obs2 = store.create({ window, mapping, screenshotIncluded: true });
    assert.equal(store.validate('obs_1').code, 'stale_observation');
    assert.equal(store.validate('obs_2').ok, true);

    store.consume(obs2, 'click');
    assert.equal(store.validate('obs_2').code, 'consumed_observation');

    const obs3 = store.create({ window, mapping, screenshotIncluded: true });
    now += 6000;
    assert.equal(store.validate(obs3.id).code, 'expired_observation');

    const { rect } = store.elementRect(obs1, 0);
    assert.equal(rect.right, 100);
    assert.throws(() => store.elementRect(obs1, 9), /不在观察/);
    assert.throws(() => store.toScreen(store.create({ window, mapping: null }), 1, 1), /没有截图/);
});
