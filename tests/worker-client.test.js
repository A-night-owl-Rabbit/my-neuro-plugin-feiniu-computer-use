'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { WorkerClient } = require('../lib/worker-client.js');

/** A scripted stand-in for the Python process: answers ops from `handlers`, can hang or crash. */
function fakeSpawnFactory(handlers, options = {}) {
    const children = [];
    const spawn = () => {
        const child = new EventEmitter();
        child.pid = 4242 + children.length;
        child.exitCode = null;
        child.killed = false;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = {
            write(payload) {
                const request = JSON.parse(payload);
                const handler = handlers[request.op];
                setImmediate(() => {
                    if (!handler) {
                        child.stdout.emit('data', Buffer.from(JSON.stringify({ id: request.id, ok: false, code: 'unknown_op', error: request.op }) + '\n'));
                        return;
                    }
                    const result = handler(request.args, child);
                    if (result === 'HANG') return;
                    if (result && result.__error) {
                        child.stdout.emit('data', Buffer.from(JSON.stringify({ id: request.id, ok: false, code: result.code, error: result.error }) + '\n'));
                        return;
                    }
                    // split the line in two chunks to exercise buffering
                    const line = JSON.stringify({ id: request.id, ok: true, result }) + '\n';
                    child.stdout.emit('data', Buffer.from(line.slice(0, 5)));
                    child.stdout.emit('data', Buffer.from(line.slice(5)));
                });
            },
            end() {}
        };
        child.kill = () => {
            child.killed = true;
            child.exitCode = 1;
            setImmediate(() => child.emit('exit', 1, null));
        };
        if (options.stderrOnStart) setImmediate(() => child.stderr.emit('data', Buffer.from(options.stderrOnStart)));
        children.push(child);
        return child;
    };
    return { spawn, children };
}

test('hello handshake, request/response, events and unknown ops', async () => {
    const { spawn, children } = fakeSpawnFactory({
        hello: () => ({ version: '0.1.0', dpi: 144 }),
        list_windows: (args, child) => {
            child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'esc_pressed', at: 1 }) + '\n'));
            return { windows: [{ id: 1, title: args.filter }] };
        }
    });
    const client = new WorkerClient({ pythonPath: 'py', scriptPath: 'w.py', spawn, helloArgs: { self_pids: [1] } });
    const events = [];
    client.on('event:esc_pressed', e => events.push(e));

    const hello = await client.ensureStarted();
    assert.equal(hello.dpi, 144);
    assert.equal(client.isAlive(), true);

    const result = await client.call('list_windows', { filter: 'abc' });
    assert.equal(result.windows[0].title, 'abc');
    assert.equal(events.length, 1);

    await assert.rejects(client.call('nope'), err => err.code === 'unknown_op');
    assert.equal(children.length, 1);
    await client.stop();
});

test('a timed-out call kills the worker and the next call restarts it', async () => {
    let hangOnce = true;
    const { spawn, children } = fakeSpawnFactory({
        hello: () => ({ version: '0.1.0' }),
        ui_tree: () => {
            if (hangOnce) { hangOnce = false; return 'HANG'; }
            return { elements: [] };
        }
    });
    const client = new WorkerClient({ pythonPath: 'py', scriptPath: 'w.py', spawn, actionTimeoutMs: 30 });
    await client.ensureStarted();
    await assert.rejects(client.call('ui_tree', { id: 1 }), err => err.code === 'timeout');
    await new Promise(r => setTimeout(r, 5));
    assert.equal(client.isAlive(), false);
    const result = await client.call('ui_tree', { id: 1 });
    assert.deepEqual(result, { elements: [] });
    assert.equal(children.length, 2, 'a second process was spawned');
    await client.stop();
});

test('startup failures are counted and eventually refused', async () => {
    const { spawn } = fakeSpawnFactory({ hello: () => 'HANG' }, { stderrOnStart: 'ImportError: no module named mss\n' });
    const client = new WorkerClient({ pythonPath: 'py', scriptPath: 'w.py', spawn, startupTimeoutMs: 20, maxConsecutiveFailures: 2 });
    await assert.rejects(client.ensureStarted(), err => err.code === 'worker_startup_timeout' && /ImportError/.test(err.message));
    await assert.rejects(client.ensureStarted(), err => err.code === 'worker_startup_timeout');
    await assert.rejects(client.ensureStarted(), err => err.code === 'worker_unavailable');
    const diag = client.diagnostics();
    assert.equal(diag.consecutiveFailures, 2);
    assert.ok(diag.stderrTail.some(line => /ImportError/.test(line)));
});

test('worker crash rejects pending calls and emits crash', async () => {
    const { spawn, children } = fakeSpawnFactory({ hello: () => ({}), click: () => 'HANG' });
    const client = new WorkerClient({ pythonPath: 'py', scriptPath: 'w.py', spawn, actionTimeoutMs: 5000 });
    await client.ensureStarted();
    const crashed = new Promise(resolve => client.on('crash', resolve));
    const pending = client.call('click', { x: 1, y: 1 });
    children[0].exitCode = 3;
    children[0].emit('exit', 3, null);
    await assert.rejects(pending, err => err.code === 'worker_exited');
    await crashed;
    assert.equal(client.isAlive(), false);
});
