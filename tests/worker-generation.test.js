'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { WorkerClient } = require('../lib/worker-client.js');
const { ObservationStore } = require('../lib/observation.js');
const { PendingActions } = require('../lib/pending-actions.js');

/** Scripted Python stand-in. Handlers get (args, child, request) and may return a value, 'HANG', {__error}, or {__raw}. */
function fakeSpawnFactory(handlers) {
    const children = [];
    const requests = [];
    const spawn = () => {
        const child = new EventEmitter();
        child.pid = 100 + children.length;
        child.exitCode = null;
        child.killed = false;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = {
            write(payload) {
                const request = JSON.parse(payload);
                requests.push({ child: children.indexOf(child), ...request });
                const handler = handlers[request.op];
                setImmediate(() => {
                    const emit = message => child.stdout.emit('data', Buffer.from(JSON.stringify(message) + '\n'));
                    if (!handler) return emit({ id: request.id, ok: false, code: 'unknown_op', error: request.op });
                    const result = handler(request.args, child, request);
                    if (result === 'HANG') return;
                    if (result && result.__raw) return emit({ id: request.id, ...result.__raw });
                    if (result && result.__error) return emit({ id: request.id, ok: false, code: result.code, error: result.error, details: result.details, generation: result.generation });
                    emit({ id: request.id, ok: true, result, generation: request.args && request.op === 'hello' ? request.args.generation : undefined });
                });
            },
            end() {}
        };
        child.kill = () => { child.killed = true; child.exitCode = 1; setImmediate(() => child.emit('exit', 1, null)); };
        children.push(child);
        return child;
    };
    return { spawn, children, requests };
}

test('every spawn gets a new, strictly increasing generation that is sent in hello', async () => {
    const { spawn, requests } = fakeSpawnFactory({ hello: args => ({ version: 't', generation: args.generation }), ping: () => ({}) });
    const client = new WorkerClient({ pythonPath: 'py', scriptPath: 'w.py', spawn, actionTimeoutMs: 30, helloArgs: { autonomous_control: true } });
    const hello = await client.ensureStarted();
    const first = client.generation;
    assert.ok(first > 0);
    assert.equal(hello.generation, first);
    assert.equal(requests[0].args.generation, first);
    assert.equal(requests[0].args.autonomous_control, true, 'other hello args are preserved');
    assert.equal(client.helloArgs.generation, undefined, 'the shared options object is not mutated');
    const other = new WorkerClient({ pythonPath: 'py', scriptPath: 'w.py', spawn });
    await other.ensureStarted();
    assert.ok(other.generation > first, 'a replacement client never reuses an older generation');
    await client.stop();
    await other.stop();
});

test('timeout emits invalidate, bumps the generation on restart and never replays the request', async () => {
    let hang = true;
    const { spawn, requests } = fakeSpawnFactory({ hello: () => ({}), click: () => { if (hang) { hang = false; return 'HANG'; } return { ok: 1 }; } });
    const client = new WorkerClient({ pythonPath: 'py', scriptPath: 'w.py', spawn, actionTimeoutMs: 20 });
    const invalidations = [];
    client.on('invalidate', info => invalidations.push(info));
    await client.ensureStarted();
    const gen1 = client.generation;
    await assert.rejects(client.call('click', { x: 1 }), err => err.code === 'timeout' && err.resultKnown === false && err.generation === gen1 && err.op === 'click');
    assert.equal(invalidations[0].reason, 'timeout');
    assert.equal(invalidations[0].generation, gen1);
    await new Promise(r => setTimeout(r, 5));
    assert.equal(requests.filter(r => r.op === 'click').length, 1, 'the timed-out click was sent exactly once');
    await client.call('ping').catch(() => {});
    assert.ok(client.generation > gen1);
    assert.equal(client.restarts, 1);
    assert.equal(client.lastFailure.code, 'timeout');
    assert.equal(client.lastFailure.generation, gen1);
    assert.equal(requests.filter(r => r.op === 'click').length, 1, 'restart does not replay');
    const diag = client.diagnostics();
    assert.equal(diag.generation, client.generation);
    assert.equal(diag.restarts, 1);
    await client.stop();
});

test('exit and crash invalidate and mark in-flight requests as unknown', async () => {
    const { spawn, children } = fakeSpawnFactory({ hello: () => ({}), drag: () => 'HANG' });
    const client = new WorkerClient({ pythonPath: 'py', scriptPath: 'w.py', spawn, actionTimeoutMs: 5000 });
    const invalidations = [];
    client.on('invalidate', info => invalidations.push(info.reason));
    await client.ensureStarted();
    const pending = client.call('drag', {});
    children[0].exitCode = 3;
    children[0].emit('exit', 3, null);
    await assert.rejects(pending, err => err.code === 'worker_exited' && err.resultKnown === false);
    assert.ok(invalidations.includes('exited'));
});

test('error replies keep their details (the fact block); replies from another generation are dropped', async () => {
    const details = { yielded: true, waited_ms: 1500, typed: 3, input_total: 10, stopped_reason: 'user_active', result_known: true };
    const { spawn } = fakeSpawnFactory({
        hello: () => ({}),
        type_text: () => ({ __error: true, code: 'user_active', error: '让位', details }),
        stale: (args, child, request) => ({ __raw: { ok: true, result: { late: true }, generation: 999 } })
    });
    const client = new WorkerClient({ pythonPath: 'py', scriptPath: 'w.py', spawn });
    await client.ensureStarted();
    await assert.rejects(client.call('type_text', {}), err => err.code === 'user_active' && err.details.typed === 3 && err.details.stopped_reason === 'user_active');
    await assert.rejects(client.call('stale', {}), err => err.code === 'stale_generation' && err.resultKnown === false);
    await client.stop();
});

test('stop() invalidates and rejects what is still pending as unknown', async () => {
    const { spawn } = fakeSpawnFactory({ hello: () => ({}), shutdown: () => 'HANG', scroll: () => 'HANG' });
    const client = new WorkerClient({ pythonPath: 'py', scriptPath: 'w.py', spawn, actionTimeoutMs: 5000 });
    const seen = [];
    client.on('invalidate', info => seen.push(info.reason));
    await client.ensureStarted();
    const pending = client.call('scroll', {});
    const stopping = client.stop();
    await assert.rejects(pending, err => ['stopped', 'worker_exited'].includes(err.code) && err.resultKnown === false);
    await stopping;
    assert.ok(seen.includes('stopped'));
});

test('observations and parked actions belong to a generation', () => {
    let generation = 1;
    const observations = new ObservationStore({ generationProvider: () => generation });
    const observation = observations.create({ window: { id: 1 }, uiTree: null });
    assert.equal(observations.validate(observation.id).ok, true);
    generation = 2;
    const verdict = observations.validate(observation.id);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'worker_restarted');
    assert.match(verdict.reason, /重新 computer_observe/);

    generation = 5;
    const pending = new PendingActions({ generationProvider: () => generation });
    const item = pending.create({ kind: 'action', summary: 's', execute: () => 'ran' });
    assert.equal(pending.get(item.id).id, item.id);
    generation = 6;
    assert.equal(pending.take(item.id), null);
    assert.equal(pending.size(), 0);
});

test('without a generation provider both stores behave exactly as before', () => {
    const observations = new ObservationStore();
    const observation = observations.create({ window: { id: 1 } });
    assert.equal(observations.validate(observation.id).ok, true);
    const pending = new PendingActions();
    const item = pending.create({ kind: 'action', summary: 's', execute: () => 1 });
    assert.equal(pending.take(item.id).id, item.id);
});
