'use strict';

function splitList(value, fallback = []) {
    if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
    const text = String(value ?? '').trim();
    if (!text) return [...fallback];
    return text.split(/[\n,;，；]+/).map(s => s.trim()).filter(Boolean);
}

function toBool(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const s = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(s)) return true;
        if (['false', '0', 'no', 'off', ''].includes(s)) return false;
    }
    return fallback;
}

function toInt(value, fallback, min = -Infinity, max = Infinity) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(n)));
}

function compactText(value, maxLength = 400) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (text.length <= maxLength) return text;
    return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

const SECRET_PATTERNS = [
    /sk-[A-Za-z0-9_-]{12,}/g,
    /ghp_[A-Za-z0-9]{20,}/g,
    /Bearer\s+[A-Za-z0-9._-]{16,}/gi,
    /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g
];

function redactSecrets(text) {
    let out = String(text ?? '');
    for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[已脱敏]');
    return out;
}

function parseOverrides(value) {
    // "chrome.exe=click_only;Code.exe=full" -> { 'chrome.exe': 'click_only', 'code.exe': 'full' }
    const result = {};
    for (const item of splitList(value)) {
        const eq = item.indexOf('=');
        if (eq <= 0) continue;
        const key = item.slice(0, eq).trim().toLowerCase();
        const val = item.slice(eq + 1).trim().toLowerCase();
        if (key && val) result[key] = val;
    }
    return result;
}

function formatRect(rect) {
    if (!rect) return '未知';
    return `(${rect.left},${rect.top})-(${rect.right},${rect.bottom}) ${rect.right - rect.left}×${rect.bottom - rect.top}`;
}

module.exports = { splitList, toBool, toInt, compactText, redactSecrets, parseOverrides, formatRect };
