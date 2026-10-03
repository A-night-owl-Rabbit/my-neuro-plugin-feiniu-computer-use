'use strict';

/**
 * One vocabulary for "what actually happened" to a desktop action.
 *
 * The Python worker returns the same fact block in `result` (success) and in
 * `error.details` (failure); the JS side adds `timeout` / worker-exit cases it can only know
 * itself. Everything user-visible (tool text, banner, audit log, doctor) reads these fields and
 * never guesses from exception wording. No function here ever sees or returns typed text.
 */

const STOP_REASONS = Object.freeze(['user_active', 'esc', 'locked', 'timeout', 'worker_error']);
const YIELD_SOURCES = Object.freeze(['keyboard', 'mouse_button', 'cursor_move', 'system_input']);

/** worker / client error code -> stopped_reason. */
const CODE_TO_STOP_REASON = Object.freeze({
    user_active: 'user_active',
    aborted: 'esc',
    locked: 'locked',
    timeout: 'timeout',
    worker_exited: 'worker_error',
    worker_crashed: 'worker_error',
    worker_restarted: 'worker_error',
    stopped: 'worker_error',
    write_failed: 'worker_error',
    stale_generation: 'worker_error',
    internal: 'worker_error',
    send_input_failed: 'worker_error',
    move_failed: 'worker_error',
    move_mismatch: 'worker_error'
});

/** Codes after which the desktop may or may not have been changed: never auto-retry, re-observe first. */
const RESULT_UNKNOWN_CODES = Object.freeze(new Set([
    'timeout', 'worker_exited', 'worker_crashed', 'worker_restarted', 'stopped',
    'write_failed', 'stale_generation', 'internal', 'send_input_failed'
]));

const YIELD_SOURCE_LABELS = Object.freeze({
    keyboard: '键盘', mouse_button: '鼠标按键', cursor_move: '鼠标移动', system_input: '键盘或鼠标'
});

const STOP_REASON_LABELS = Object.freeze({
    user_active: '主人开始操作', esc: '主人按了 Esc', locked: '锁屏或安全桌面', timeout: '执行超时', worker_error: '执行层故障'
});

function toCount(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

function plainCursor(cursor) {
    if (!cursor) return null;
    if (Array.isArray(cursor) && cursor.length >= 2) return { x: Number(cursor[0]), y: Number(cursor[1]) };
    if (typeof cursor === 'object' && Number.isFinite(Number(cursor.x)) && Number.isFinite(Number(cursor.y))) {
        return { x: Number(cursor.x), y: Number(cursor.y) };
    }
    return null;
}

/**
 * @param raw   worker `result` (success) or `error.details` (failure); may be null/undefined
 *              (older or fake workers send nothing - sensible defaults apply)
 * @param meta  { ok, code } - code is the worker/client error code for failures
 */
function normalizeFacts(raw, meta = {}) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const ok = meta.ok !== false;
    const code = ok ? null : (meta.code || 'error');
    let stopped = src.stopped_reason !== undefined ? src.stopped_reason : (ok ? null : (CODE_TO_STOP_REASON[code] || null));
    if (stopped !== null && !STOP_REASONS.includes(stopped)) stopped = 'worker_error';
    let resultKnown;
    if (typeof src.result_known === 'boolean') resultKnown = src.result_known;
    else resultKnown = ok ? true : !RESULT_UNKNOWN_CODES.has(code);
    const typed = toCount(src.typed);
    const inputTotal = toCount(src.input_total);
    const fg = src.foreground && typeof src.foreground === 'object' ? src.foreground : null;
    return {
        ok,
        code,
        yielded: src.yielded === true || (!ok && (code === 'user_active')),
        waitedMs: toCount(src.waited_ms) || 0,
        yieldSource: YIELD_SOURCES.includes(src.yield_source) ? src.yield_source : null,
        typed,
        inputTotal,
        typedExact: src.typed_exact !== false,
        completed: typeof src.completed === 'boolean' ? src.completed : (typed !== null && inputTotal !== null ? typed >= inputTotal : null),
        injected: typeof src.injected === 'boolean' ? src.injected : null,
        foreground: fg ? { processName: fg.process_name || null, windowId: fg.id ?? null } : null,
        cursor: plainCursor(src.cursor),
        stoppedReason: stopped,
        resultKnown,
        generation: toCount(src.generation),
        segmented: typeof src.segmented === 'boolean' ? src.segmented : null
    };
}

/** 'full' | 'partial' | 'none' | null (not a typing action). */
function typingState(facts) {
    if (!facts || facts.typed === null || facts.inputTotal === null) return null;
    if (facts.typed >= facts.inputTotal && facts.inputTotal > 0) return 'full';
    if (facts.typed <= 0) return 'none';
    return 'partial';
}

function typingPhrase(facts) {
    const state = typingState(facts);
    if (!state) return '';
    const exact = facts.typedExact ? '' : '至少';
    if (state === 'full') return `已输入全部 ${facts.typed}/${facts.inputTotal} 字`;
    if (state === 'partial') return `部分输入：${exact}${facts.typed}/${facts.inputTotal} 字，其余没有输入`;
    return `尚未输入（0/${facts.inputTotal} 字）`;
}

/** Human-readable fact fragments (Chinese). Pure; safe for logs. */
function describeFacts(facts) {
    if (!facts) return [];
    const parts = [];
    if (facts.waitedMs > 0) {
        parts.push(`等待主人停手 ${facts.waitedMs}ms${facts.yielded ? '，主人一直没停' : '，之后继续执行'}`);
    }
    if (facts.yielded && facts.yieldSource) parts.push(`让位原因：${YIELD_SOURCE_LABELS[facts.yieldSource] || facts.yieldSource}`);
    const typing = typingPhrase(facts);
    if (typing) parts.push(typing);
    if (facts.stoppedReason) parts.push(`停止原因：${STOP_REASON_LABELS[facts.stoppedReason] || facts.stoppedReason}`);
    if (facts.foreground?.processName) parts.push(`执行后前台=${facts.foreground.processName}`);
    if (facts.cursor) parts.push(`光标=(${facts.cursor.x},${facts.cursor.y})`);
    if (!facts.resultKnown) parts.push('动作结果未知（可能已执行也可能没有）');
    return parts;
}

/** What the top banner should say, or null when the normal step text is right. */
function bannerStatus(facts) {
    if (!facts) return null;
    const state = typingState(facts);
    const typed = state && state !== 'full' ? `已输入 ${facts.typed}/${facts.inputTotal} 字` : '';
    if (facts.stoppedReason === 'user_active') {
        const text = facts.waitedMs > 0 && !typed ? `等不到你停手（${Math.round(facts.waitedMs / 100) / 10}s），肥牛先让位` : '你在操作，肥牛先让位';
        return { kind: 'pause', text: typed ? `${text}（${typed}）` : text };
    }
    if (facts.stoppedReason === 'esc') return { kind: 'stop', text: typed ? `肥牛已停手（Esc，${typed}）` : '肥牛已停手' };
    if (facts.stoppedReason === 'locked') return { kind: 'stop', text: typed ? `电脑已锁屏，肥牛停手（${typed}）` : '电脑已锁屏，肥牛停手' };
    if (!facts.resultKnown) return { kind: 'stop', text: typed ? `结果未确认（${typed}）` : '结果未确认，肥牛先重新观察' };
    return null;
}

/** Compact, text-free record for the audit log. */
function auditFacts(facts) {
    if (!facts) return null;
    const out = {
        ok: facts.ok,
        code: facts.code,
        yielded: facts.yielded,
        waited_ms: facts.waitedMs,
        yield_source: facts.yieldSource,
        stopped_reason: facts.stoppedReason,
        result_known: facts.resultKnown,
        generation: facts.generation,
        foreground: facts.foreground?.processName || null,
        cursor: facts.cursor
    };
    if (facts.typed !== null) out.typed = facts.typed;
    if (facts.inputTotal !== null) out.input_total = facts.inputTotal;
    if (facts.completed !== null) out.completed = facts.completed;
    if (facts.injected !== null) out.injected = facts.injected;
    return out;
}

/** Guidance for the model after a failed/partial action; null when the generic hints apply. */
function failureGuidance(facts, { autonomous = true } = {}) {
    if (!facts) return null;
    const state = typingState(facts);
    const tail = state === 'partial'
        ? '重新 computer_observe 核对界面里实际出现了什么，只补输入缺少的部分，不要把整段重新输入。'
        : '先重新 computer_observe 核对界面，再决定下一步，不要凭上一次观察重复动作。';
    switch (facts.stoppedReason) {
        case 'user_active':
            if (!autonomous) return `主人正在操作电脑，${state === 'none' || state === null ? '本次没有发送输入' : typingPhrase(facts)}。先停下来问主人是否继续；继续前必须重新 computer_observe。`;
            return `主人正在操作电脑（让位，不是故障），${state === 'none' || state === null ? '这一步没有发送任何输入' : typingPhrase(facts)}。旧观察已作废。等主人停手后${tail}若主人一直在操作就暂停并如实汇报，不要和主人争抢鼠标键盘。`;
        case 'esc':
            return `主人按了 Esc，这个回合不要再操作电脑，如实告诉主人做到了哪一步${state && state !== 'none' ? `（${typingPhrase(facts)}）` : ''}。`;
        case 'locked':
            return `电脑处于锁屏或安全桌面，请主人先解锁。${state && state !== 'none' ? typingPhrase(facts) + '。' : ''}`;
        case 'timeout':
            return '操作超时，执行结果未知：动作可能已经生效，也可能没有。不要自动重试点击、提交、发送、关闭、删除或付款；先重新 computer_observe 确认界面状态，再决定是否发起新的动作。';
        case 'worker_error':
            return facts.resultKnown
                ? '桌面执行层出错，动作没有生效。可以重新 computer_observe 后再尝试一次；反复失败就调用 computer_doctor 并如实告诉主人。'
                : '桌面执行层出错，动作可能已经部分或全部生效，结果未知。不要自动重试；先重新 computer_observe 确认界面状态，再决定是否发起新的动作。';
        default:
            return null;
    }
}

module.exports = {
    STOP_REASONS, YIELD_SOURCES, CODE_TO_STOP_REASON, RESULT_UNKNOWN_CODES,
    normalizeFacts, typingState, typingPhrase, describeFacts, bannerStatus, auditFacts, failureGuidance,
    STOP_REASON_LABELS, YIELD_SOURCE_LABELS
};
