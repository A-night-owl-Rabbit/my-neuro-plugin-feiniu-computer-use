'use strict';

const ALIASES = {
    control: 'ctrl', ctl: 'ctrl', cmdorctrl: 'ctrl', controlorcommand: 'ctrl',
    option: 'alt', menu: 'alt',
    escape: 'esc', return: 'enter', kp_enter: 'enter', numpadenter: 'enter',
    spacebar: 'space', bksp: 'backspace', del: 'delete', ins: 'insert',
    pgup: 'pageup', pg_up: 'pageup', pgdn: 'pagedown', pg_dn: 'pagedown',
    arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right',
    prtsc: 'printscreen', contextmenu: 'apps'
};

const DENIED_KEYS = new Set(['win', 'lwin', 'rwin', 'windows', 'meta', 'super', 'cmd', 'command', 'os', 'hyper']);
const MODIFIERS = new Set(['ctrl', 'alt', 'shift', 'win', 'rwin']);
const DENIED_CHORDS = new Set(['ctrl+alt+delete', 'ctrl+shift+esc']);
const CLOSE_CHORDS = new Set(['alt+f4', 'ctrl+w', 'ctrl+q', 'ctrl+shift+w', 'ctrl+f4']);
const DESTRUCTIVE_KEYS = new Set(['delete', 'shift+delete']);
const KNOWN_KEYS = new Set([
    'backspace', 'tab', 'enter', 'esc', 'space', 'pageup', 'pagedown', 'end', 'home',
    'left', 'up', 'right', 'down', 'printscreen', 'insert', 'delete', 'apps', 'capslock', 'numlock',
    'scrolllock', 'pause', 'volumemute', 'volumedown', 'volumeup', 'medianext', 'mediaprev',
    'mediastop', 'playpause', 'browserback', 'browserforward',
    'multiply', 'add', 'subtract', 'decimal', 'divide', 'separator'
]);
for (let i = 1; i <= 24; i += 1) KNOWN_KEYS.add(`f${i}`);
for (let i = 0; i <= 9; i += 1) KNOWN_KEYS.add(`numpad${i}`);

function normalizeName(name) {
    const key = String(name || '').trim().toLowerCase().replace(/\s+/g, '');
    return ALIASES[key] || key;
}

/**
 * Parses "Ctrl+Shift+S" into a canonical chord description.
 * Returns { ok, canonical, modifiers, key, denied, reason, closes, destructive }.
 */
function classifyChord(chord, options = {}) {
    const autonomous = options.autonomousControl === true;
    const raw = String(chord || '').trim();
    if (!raw) return { ok: false, denied: false, reason: '按键不能为空' };
    let parts;
    if (raw === '+') parts = ['+'];
    else {
        parts = raw.split('+');
        if (raw.endsWith('+')) parts = parts.filter(Boolean).concat(['=']);
        parts = parts.filter(p => p !== '');
    }
    const names = parts.map(normalizeName).map(name => autonomous && DENIED_KEYS.has(name) ? (name === 'rwin' ? 'rwin' : 'win') : name);
    if (names.length === 0) return { ok: false, denied: false, reason: `无法解析按键: ${raw}` };
    for (const name of names) {
        if (!autonomous && DENIED_KEYS.has(name)) {
            return { ok: false, denied: true, reason: '禁止使用 Windows 键及任何含 Win 键的组合（这是硬性规则）' };
        }
    }
    const modifiers = names.slice(0, -1);
    const key = names[names.length - 1];
    for (const m of modifiers) {
        if (!MODIFIERS.has(m)) return { ok: false, denied: false, reason: `不支持的修饰键: ${m}` };
    }
    if (MODIFIERS.has(key) && names.length === 1 && !['win', 'rwin'].includes(key)) return { ok: false, denied: false, reason: '不能单独按修饰键' };
    const order = ['ctrl', 'alt', 'shift', 'win', 'rwin'];
    const sortedMods = order.filter(m => modifiers.includes(m));
    const canonical = [...sortedMods, key].join('+');
    if (autonomous && canonical === 'ctrl+alt+delete') {
        return { ok: false, denied: false, reason: 'Windows 的 Ctrl+Alt+Delete 安全注意序列无法通过 SendInput 模拟' };
    }
    if (!autonomous && DENIED_CHORDS.has(canonical)) {
        return { ok: false, denied: true, reason: `组合键 ${canonical} 被禁止（系统级快捷键）` };
    }
    if (!(KNOWN_KEYS.has(key) || (autonomous && ['win', 'rwin'].includes(key)) || /^[a-z0-9]$/.test(key) || (key.length === 1))) {
        return { ok: false, denied: false, reason: `未知按键名: ${key}` };
    }
    return {
        ok: true,
        canonical,
        modifiers: sortedMods,
        key,
        denied: false,
        closes: CLOSE_CHORDS.has(canonical),
        destructive: DESTRUCTIVE_KEYS.has(canonical),
        submits: canonical === 'enter' || canonical === 'ctrl+enter'
    };
}

module.exports = { classifyChord, normalizeName, CLOSE_CHORDS, DENIED_CHORDS };
