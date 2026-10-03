'use strict';

const { EventEmitter } = require('events');
const childProcess = require('child_process');

/** Process-wide, so a replacement WorkerClient can never reuse an older client's generation. */
let GENERATION_COUNTER = 0;

/** Codes after which a desktop action may or may not have been applied. */
const UNKNOWN_RESULT_CODES = new Set(['timeout', 'worker_exited', 'worker_crashed', 'worker_restarted', 'stopped', 'write_failed', 'stale_generation']);

class WorkerError extends Error {
    constructor(code, message, extra = {}) {
        super(message);
        this.name = 'WorkerError';
        this.code = code || 'error';
        Object.assign(this, extra);
        if (this.resultKnown === undefined && UNKNOWN_RESULT_CODES.has(this.code)) this.resultKnown = false;
    }
}

/**
 * Owns the long-lived Python worker: spawn, JSON Lines request/response, events,
 * timeouts (a timed-out worker is killed and restarted on the next call), restart budget.
 *
 * Every spawned process gets a new `generation` (handed to the worker in `hello` and echoed in
 * its replies). The `invalidate` event fires whenever the current generation can no longer be
 * trusted (timeout kill, exit, crash, stop); listeners must drop observations and queued
 * closures that belong to it. A pending request is never replayed on a new generation.
 */
class WorkerClient extends EventEmitter {
    constructor(options = {}) {
        super();
        this.pythonPath = options.pythonPath;
        this.scriptPath = options.scriptPath;
        this.spawnImpl = options.spawn || childProcess.spawn;
        this.log = options.log || (() => {});
        this.startupTimeoutMs = options.startupTimeoutMs || 20000;
        this.defaultTimeoutMs = options.actionTimeoutMs || 15000;
        this.helloArgs = options.helloArgs || {};
        this.maxConsecutiveFailures = options.maxConsecutiveFailures || 3;

        this.child = null;
        this.hello = null;
        this.pending = new Map();
        this.nextId = 0;
        this.buffer = '';
        this.stderrTail = [];
        this.consecutiveFailures = 0;
        this.starting = null;
        this.stopped = false;
        this.generation = 0;
        this.restarts = 0;
        this.lastFailure = null;
    }

    _invalidate(reason) {
        this.emit('invalidate', { generation: this.generation, reason });
    }

    _noteFailure(error, op) {
        this.lastFailure = { code: error?.code || 'error', op: op || null, generation: this.generation, at: Date.now(), message: String(error?.message || '').slice(0, 200) };
    }

    isAlive() {
        return !!(this.child && this.child.exitCode === null && !this.child.killed && this.hello);
    }

    async ensureStarted() {
        if (this.isAlive()) return this.hello;
        if (this.starting) return this.starting;
        if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
            throw new WorkerError(
                'worker_unavailable',
                `桌面 worker 连续 ${this.consecutiveFailures} 次启动失败，请运行 computer_doctor 查看原因`
            );
        }
        this.starting = this._start().finally(() => { this.starting = null; });
        return this.starting;
    }

    async _start() {
        this.stopped = false;
        this._resetChildState();
        if (this.generation > 0) this.restarts += 1;
        this.generation = ++GENERATION_COUNTER;
        let child;
        try {
            child = this.spawnImpl(this.pythonPath, [this.scriptPath], {
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
            });
        } catch (error) {
            this.consecutiveFailures += 1;
            throw new WorkerError('spawn_failed', `无法启动桌面 worker: ${error.message}`);
        }
        this.child = child;
        child.stdout.on('data', chunk => { if (this.child === child) this._onStdout(chunk); });
        child.stderr.on('data', chunk => this._onStderr(chunk));
        child.on('error', error => {
            if (this.child !== child) return;
            this.log('warn', `worker 进程错误: ${error.message}`);
            this._failAllPending(new WorkerError('worker_crashed', `worker 进程错误: ${error.message}`, { generation: this.generation, resultKnown: false }));
            this._invalidate('process_error');
        });
        child.on('exit', (code, signal) => {
            // A previous, already-replaced process exiting late must not touch the new one.
            if (this.child !== child) return;
            this.log(this.stopped ? 'info' : 'warn', `worker 进程退出 code=${code} signal=${signal || ''}`);
            this._failAllPending(new WorkerError('worker_exited', `worker 已退出 (code=${code})`, { generation: this.generation, resultKnown: false }));
            const wasAlive = !!this.hello;
            this.hello = null;
            this.child = null;
            this._invalidate(this.stopped ? 'stopped' : 'exited');
            this.emit('exit', { code, signal, expected: this.stopped });
            if (!this.stopped && wasAlive) this.emit('crash', { code, signal });
        });

        try {
            const hello = await this._request('hello', { ...this.helloArgs, generation: this.generation }, this.startupTimeoutMs, true);
            this.hello = hello;
            this.consecutiveFailures = 0;
            this.emit('ready', hello);
            return hello;
        } catch (error) {
            this.consecutiveFailures += 1;
            this._kill();
            const tail = this.stderrTail.slice(-5).join(' | ');
            throw new WorkerError(
                error.code === 'timeout' ? 'worker_startup_timeout' : 'worker_startup_failed',
                `桌面 worker 启动失败: ${error.message}${tail ? `；stderr: ${tail}` : ''}`
            );
        }
    }

    _resetChildState() {
        this.buffer = '';
        this.hello = null;
        this._failAllPending(new WorkerError('worker_restarted', 'worker 正在重启，之前的请求已作废，没有重放', { generation: this.generation, resultKnown: false }));
    }

    _onStdout(chunk) {
        this.buffer += chunk.toString('utf8');
        let index;
        while ((index = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, index).trim();
            this.buffer = this.buffer.slice(index + 1);
            if (!line) continue;
            let message;
            try {
                message = JSON.parse(line);
            } catch (_) {
                this.log('warn', `worker 输出了非 JSON 行: ${line.slice(0, 200)}`);
                continue;
            }
            if (message && typeof message === 'object' && 'event' in message) {
                this.emit('event', message);
                this.emit(`event:${message.event}`, message);
                continue;
            }
            const entry = this.pending.get(message?.id);
            if (!entry) continue;
            this.pending.delete(message.id);
            clearTimeout(entry.timer);
            if (message.generation !== undefined && message.generation !== null && message.generation !== entry.generation) {
                this.log('warn', `丢弃过期 generation 的回执 op=${entry.op} 回执=${message.generation} 当前=${entry.generation}`);
                entry.reject(new WorkerError('stale_generation', `收到旧 generation(${message.generation}) 的回执，已丢弃；当前是 ${entry.generation}`, { generation: entry.generation, resultKnown: false }));
                continue;
            }
            if (message.ok) entry.resolve(message.result);
            else {
                entry.reject(new WorkerError(message.code || 'error', message.error || 'worker 返回错误', {
                    details: message.details && typeof message.details === 'object' ? message.details : null,
                    generation: entry.generation
                }));
            }
        }
    }

    _onStderr(chunk) {
        const text = chunk.toString('utf8');
        for (const line of text.split(/\r?\n/)) {
            if (!line.trim()) continue;
            this.stderrTail.push(line.trim().slice(0, 300));
            if (this.stderrTail.length > 40) this.stderrTail.shift();
            this.log('debug', `[worker] ${line.trim().slice(0, 300)}`);
        }
    }

    _failAllPending(error) {
        for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(error);
        }
        this.pending.clear();
    }

    _request(op, args, timeoutMs, allowWithoutHello = false) {
        if (!this.child || this.child.exitCode !== null) {
            return Promise.reject(new WorkerError('worker_exited', 'worker 未运行'));
        }
        if (!allowWithoutHello && !this.hello) {
            return Promise.reject(new WorkerError('worker_not_ready', 'worker 尚未完成握手'));
        }
        const id = ++this.nextId;
        const payload = JSON.stringify({ id, op, args: args || {} }) + '\n';
        return new Promise((resolve, reject) => {
            const generation = this.generation;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                this.log('warn', `worker 操作 ${op} 超时 (${timeoutMs}ms)，将重启 worker`);
                this._kill();
                this._invalidate('timeout');
                reject(new WorkerError('timeout', `桌面操作 ${op} 超时 (${timeoutMs}ms)，worker 已重启，结果未知`, { op, generation, resultKnown: false }));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer, op, generation });
            try {
                this.child.stdin.write(payload, 'utf8');
            } catch (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(new WorkerError('write_failed', `无法向 worker 发送请求: ${error.message}`, { op, generation, resultKnown: false }));
            }
        });
    }

    async call(op, args = {}, options = {}) {
        await this.ensureStarted();
        try {
            return await this._request(op, args, options.timeoutMs || this.defaultTimeoutMs);
        } catch (error) {
            if (error && ['timeout', 'worker_exited', 'worker_crashed', 'worker_restarted', 'stale_generation', 'write_failed'].includes(error.code)) this._noteFailure(error, op);
            throw error;
        }
    }

    _kill() {
        const child = this.child;
        if (!child) return;
        try { child.stdin.end(); } catch (_) {}
        try { child.kill(); } catch (_) {}
        this.hello = null;
    }

    async stop() {
        this.stopped = true;
        if (!this.child) return;
        try {
            await this._request('shutdown', {}, 2000).catch(() => {});
        } finally {
            const child = this.child;
            setTimeout(() => {
                try { if (child && child.exitCode === null) child.kill(); } catch (_) {}
            }, 1500);
            this._failAllPending(new WorkerError('stopped', '插件已停止', { generation: this.generation, resultKnown: false }));
            this._invalidate('stopped');
        }
    }

    diagnostics() {
        return {
            alive: this.isAlive(),
            python: this.pythonPath,
            script: this.scriptPath,
            pid: this.child?.pid || null,
            generation: this.generation,
            restarts: this.restarts,
            lastFailure: this.lastFailure,
            hello: this.hello,
            consecutiveFailures: this.consecutiveFailures,
            stderrTail: this.stderrTail.slice(-8)
        };
    }
}

module.exports = { WorkerClient, WorkerError };
