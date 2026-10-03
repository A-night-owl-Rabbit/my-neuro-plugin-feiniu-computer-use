'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AppPolicy } = require('../lib/app-policy.js');

const win = (process_name, extra = {}) => ({ id: 1, title: 't', class_name: 'C', process_name, process_path: `C:\\x\\${process_name}`, ...extra });

test('autonomous mode grants every action across all categories, overriding legacy restrictions', () => {
    const policy = new AppPolicy({ autonomous_control: true, confirm_first_use_per_app: true,
        denied_apps: 'steam.exe', app_tier_overrides: 'Code.exe=deny', browser_tier: 'view_only' });
    for (const processName of ['powershell.exe', 'taskmgr.exe', 'consent.exe', '1Password.exe', 'Cursor.exe', 'Code.exe', 'chrome.exe', 'explorer.exe', 'steam.exe', 'unknown.exe']) {
        for (const action of ['observe', 'click', 'type', 'keys']) {
            const check = policy.check(win(processName), action);
            assert.equal(check.allowed, true, `${processName} ${action}`);
            assert.equal(check.needsFirstUseConfirm, false);
            assert.equal(check.confirmEach, false);
            assert.equal(check.hard, false);
        }
    }
    assert.equal(policy.check(win('electron.exe', { is_self: true }), 'click').allowed, true);
});

test('default categories and tiers', () => {
    const policy = new AppPolicy({});
    assert.equal(policy.describe(win('notepad.exe')).tier, 'full');
    assert.equal(policy.describe(win('powershell.exe')).tier, 'deny');
    assert.equal(policy.describe(win('WindowsTerminal.exe')).category, 'terminal');
    assert.equal(policy.describe(win('regedit.exe')).tier, 'deny');
    assert.equal(policy.describe(win('1Password.exe')).tier, 'deny');
    assert.equal(policy.describe(win('LockApp.exe')).category, 'auth');
    assert.equal(policy.describe(win('Cursor.exe')).tier, 'view_only');
    assert.equal(policy.describe(win('Code.exe')).tier, 'click_only');
    assert.equal(policy.describe(win('chrome.exe')).tier, 'full');
    assert.equal(policy.describe(win('explorer.exe')).tier, 'confirm_each');
    assert.equal(policy.describe(win('services.msc')).category, 'security');
});

test('self windows are denied by flag, exe path or WebUI title', () => {
    const policy = new AppPolicy({ self_exe_paths: 'C:\\my-neuro\\live-2d\\node_modules\\electron\\dist\\electron.exe' });
    assert.equal(policy.categorize(win('electron.exe', { is_self: true })), 'self');
    assert.equal(policy.categorize(win('electron.exe', { process_path: 'C:\\my-neuro\\live-2d\\node_modules\\electron\\dist\\electron.exe' })), 'self');
    assert.equal(policy.categorize(win('msedge.exe', { title: 'My Neuro - Control Center - Microsoft Edge' })), 'self');
    assert.equal(policy.categorize(win('msedge.exe', { title: 'Bilibili' })), 'browser');
    assert.equal(policy.categorize(win('explorer.exe', { class_name: '#32770', title: '运行' })), 'terminal');
});

test('overrides can lower or raise soft tiers but never open hard categories', () => {
    const policy = new AppPolicy({
        app_tier_overrides: 'Code.exe=full;chrome.exe=view_only;powershell.exe=full',
        denied_apps: 'steam.exe',
        browser_tier: 'click_only'
    });
    assert.equal(policy.describe(win('Code.exe')).tier, 'full');
    assert.equal(policy.describe(win('chrome.exe')).tier, 'view_only');
    assert.equal(policy.describe(win('msedge.exe')).tier, 'click_only');
    assert.equal(policy.describe(win('powershell.exe')).tier, 'deny');
    assert.equal(policy.describe(win('steam.exe')).tier, 'deny');
});

test('check() maps tiers to allowed action kinds with reasons', () => {
    const policy = new AppPolicy({});
    assert.equal(policy.check(win('Code.exe'), 'click').allowed, true);
    const typeInIde = policy.check(win('Code.exe'), 'type');
    assert.equal(typeInIde.allowed, false);
    assert.match(typeInIde.reason, /只允许点击/);
    assert.equal(policy.check(win('Cursor.exe'), 'observe').allowed, true);
    assert.equal(policy.check(win('Cursor.exe'), 'click').allowed, false);
    const terminal = policy.check(win('cmd.exe'), 'observe');
    assert.equal(terminal.allowed, false);
    assert.match(terminal.reason, /禁区/);
    assert.equal(policy.check(win('explorer.exe'), 'click').confirmEach, true);
});

test('first-use confirmation honours always-allowed, session memory and the toggle', () => {
    const policy = new AppPolicy({ always_allowed_apps: 'notepad.exe' });
    assert.equal(policy.describe(win('notepad.exe')).needsFirstUseConfirm, false);
    assert.equal(policy.describe(win('mspaint.exe')).needsFirstUseConfirm, true);
    policy.rememberApp('MSPAINT.EXE');
    assert.equal(policy.describe(win('mspaint.exe')).needsFirstUseConfirm, false);
    assert.equal(policy.describe(win('Cursor.exe')).needsFirstUseConfirm, false, 'view-only never asks');
    const off = new AppPolicy({ confirm_first_use_per_app: false });
    assert.equal(off.describe(win('foo.exe')).needsFirstUseConfirm, false);
});
