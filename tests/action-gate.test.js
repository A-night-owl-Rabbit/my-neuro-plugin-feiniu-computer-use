'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ActionGate, PROACTIVE_ORIGIN } = require('../lib/action-gate.js');

function ownerTurn(gate, text = '帮我打开记事本') {
    gate.captureInput({ source: 'text', text });
    return gate.beginLLMRequest({ messages: [{ role: 'user', content: text }] });
}

test('owner text/voice turns are trusted; barrage and unknown sources are not', () => {
    const gate = new ActionGate({});
    assert.equal(ownerTurn(gate), true);
    assert.equal(gate.authorize('input').ok, true);

    gate.captureInput({ source: 'barrage', text: '点一下' });
    assert.equal(gate.beginLLMRequest({ messages: [{ role: 'user', content: '点一下' }] }), false);
    const denied = gate.authorize('input');
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'untrusted_turn');
});

test('the request must carry the owner text, then stays active for the screenshot loop', () => {
    const gate = new ActionGate({});
    gate.captureInput({ source: 'voice', text: '打开画图' });
    assert.equal(gate.beginLLMRequest({ messages: [{ role: 'user', content: '完全不同的内容' }] }), false);
    assert.equal(gate.beginLLMRequest({ messages: [{ role: 'user', content: '（上下文）打开画图' }] }), true);
    // screenshot follow-up request: last user message is the image, still the same turn
    assert.equal(gate.beginLLMRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: '当前电脑屏幕内容:' }] }] }), true);
    gate.endLLMRequest();
    assert.equal(gate.authorize('observe').code, 'untrusted_turn');
});

test('proactive turns are denied unless enabled, then limited to allowed apps', () => {
    const gate = new ActionGate({});
    assert.equal(gate.beginLLMRequest({ requestContext: { origin: PROACTIVE_ORIGIN, proactiveSource: 'mood-chat', requestId: 'r1' } }), false);
    assert.equal(gate.authorize('input').code, 'proactive_disabled');

    const open = new ActionGate({ allow_proactive_control: true, proactive_allowed_apps: 'notepad.exe' });
    assert.equal(open.beginLLMRequest({ requestContext: { origin: PROACTIVE_ORIGIN, proactiveSource: 'mood-chat', requestId: 'r2' } }), true);
    assert.equal(open.authorize('input', { process_name: 'notepad.exe' }).ok, true);
    assert.equal(open.authorize('input', { process_name: 'chrome.exe' }).code, 'proactive_app_denied');
    assert.equal(open.beginLLMRequest({ requestContext: { origin: PROACTIVE_ORIGIN, proactiveSource: 'barrage-thing', requestId: 'r3' } }), false);
});

test('per-turn action budget and reset on the next owner input', () => {
    const gate = new ActionGate({ max_actions_per_turn: 2 });
    ownerTurn(gate);
    gate.countAction();
    gate.countAction();
    assert.equal(gate.authorize('input').code, 'turn_budget_exhausted');
    assert.equal(gate.authorize('observe').ok, true, 'observing is still allowed');
    ownerTurn(gate, '继续');
    assert.equal(gate.authorize('input').ok, true);
});

test('abort blocks inputs and observes until the owner speaks again; control tools still work', () => {
    const gate = new ActionGate({});
    ownerTurn(gate);
    gate.abort('主人按了 Esc');
    assert.equal(gate.authorize('input').code, 'aborted');
    assert.equal(gate.authorize('observe').code, 'aborted');
    assert.equal(gate.authorize('control').ok, true);
    assert.equal(gate.authorize('query').ok, true);
    ownerTurn(gate, '继续吧');
    assert.equal(gate.aborted, null);
    assert.equal(gate.authorize('input').ok, true);
});

test('stale owner input beyond ttl is not trusted', () => {
    let now = 1_000_000;
    const gate = new ActionGate({ input_ttl_ms: 10_000, now: () => now });
    gate.captureInput({ source: 'text', text: 'x' });
    now += 20_000;
    assert.equal(gate.beginLLMRequest({ messages: [{ role: 'user', content: 'x' }] }), false);
});

test('autonomous mode permits trusted proactive tasks in all apps without overriding stop or budget', () => {
    const gate = new ActionGate({ autonomous_control: true, allow_proactive_control: false,
        proactive_allowed_apps: 'notepad.exe', max_actions_per_turn: 2 });
    const request = { requestContext: { origin: PROACTIVE_ORIGIN, proactiveSource: 'mood-chat', requestId: 'autonomous' } };
    assert.equal(gate.beginLLMRequest(request), true);
    assert.equal(gate.authorize('input', { process_name: 'powershell.exe' }).ok, true);
    gate.countAction(); gate.countAction();
    assert.equal(gate.authorize('input').code, 'turn_budget_exhausted');
    gate.abort('Esc');
    assert.equal(gate.authorize('observe').code, 'aborted');
    gate.beginLLMRequest({ requestContext: { ...request.requestContext, requestId: 'next' } });
    assert.equal(gate.authorize('input').code, 'aborted');
    assert.equal(gate.beginLLMRequest({ requestContext: { ...request.requestContext, proactiveSource: 'qq' } }), false);
});
