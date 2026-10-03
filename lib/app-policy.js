'use strict';

const { splitList, parseOverrides } = require('./utils.js');

/** Tiers, from most to least restrictive. */
const TIERS = {
    deny: { label: '禁止', observe: false, click: false, type: false, keys: false, confirmEach: false },
    view_only: { label: '只能看', observe: true, click: false, type: false, keys: false, confirmEach: false },
    click_only: { label: '只点击', observe: true, click: true, type: false, keys: false, confirmEach: false },
    confirm_each: { label: '每步确认', observe: true, click: true, type: true, keys: true, confirmEach: true },
    full: { label: '全控制', observe: true, click: true, type: true, keys: true, confirmEach: false }
};

const CATEGORY_DEFAULTS = {
    self: { tier: 'deny', label: '肥牛自己' },
    terminal: { tier: 'deny', label: '终端' },
    security: { tier: 'deny', label: '系统安全工具' },
    auth: { tier: 'deny', label: '登录/授权对话框' },
    password_manager: { tier: 'deny', label: '密码管理器' },
    agent_app: { tier: 'view_only', label: 'AI 助手应用' },
    ide: { tier: 'click_only', label: '代码编辑器' },
    browser: { tier: 'full', label: '浏览器' },
    system_ui: { tier: 'confirm_each', label: '系统界面' },
    other: { tier: 'full', label: '普通应用' }
};

const CATEGORY_PROCESSES = {
    terminal: ['windowsterminal.exe', 'wt.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe', 'conhost.exe', 'openconsole.exe', 'mintty.exe', 'alacritty.exe', 'wezterm-gui.exe'],
    security: ['securityhealthsystray.exe', 'sechealthui.exe', 'mmc.exe', 'regedit.exe', 'msconfig.exe', 'taskmgr.exe', 'gpedit.msc', 'secpol.msc', 'compmgmt.msc', 'services.exe', 'wf.msc'],
    auth: ['consent.exe', 'credentialuibroker.exe', 'lockapp.exe', 'logonui.exe', 'authhost.exe', 'windows.security.exe'],
    password_manager: ['1password.exe', 'bitwarden.exe', 'keepass.exe', 'keepassxc.exe', 'lastpass.exe', 'dashlane.exe', 'nordpass.exe', 'enpass.exe'],
    agent_app: ['codex.exe', 'claude.exe', 'cursor.exe', 'zcode.exe', 'chatgpt.exe', 'windsurf.exe'],
    ide: ['code.exe', 'code - insiders.exe', 'devenv.exe', 'idea64.exe', 'pycharm64.exe', 'webstorm64.exe', 'rider64.exe', 'clion64.exe', 'goland64.exe', 'sublime_text.exe', 'notepad++.exe'],
    browser: ['chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'opera.exe', 'vivaldi.exe', 'arc.exe', 'chromium.exe'],
    system_ui: ['explorer.exe', 'systemsettings.exe', 'control.exe', 'applicationframehost.exe', 'shellexperiencehost.exe', 'startmenuexperiencehost.exe', 'searchhost.exe']
};

const RUN_DIALOG_CLASS = '#32770';
const RUN_DIALOG_TITLES = ['运行', 'run'];
const SELF_TITLE_PATTERNS = [/my neuro/i, /my-neuro/i, /肥牛/];

class AppPolicy {
    constructor(config = {}) {
        this.configure(config);
        this.sessionAllowed = new Set();   // process names confirmed by the owner this session
    }

    configure(config = {}) {
        this.autonomousControl = config.autonomous_control === true;
        this.deniedApps = new Set(splitList(config.denied_apps).map(s => s.toLowerCase()));
        this.alwaysAllowed = new Set(splitList(config.always_allowed_apps, ['notepad.exe', 'mspaint.exe', 'calc.exe']).map(s => s.toLowerCase()));
        this.overrides = parseOverrides(config.app_tier_overrides);
        const browserTier = String(config.browser_tier || 'full').trim().toLowerCase();
        this.browserTier = TIERS[browserTier] ? browserTier : 'full';
        this.confirmFirstUse = config.confirm_first_use_per_app !== false;
        this.selfExePaths = new Set(splitList(config.self_exe_paths).map(s => s.toLowerCase()));
    }

    categorize(window) {
        const name = String(window?.process_name || '').toLowerCase();
        const title = String(window?.title || '');
        const cls = String(window?.class_name || '');
        const exe = String(window?.process_path || '').toLowerCase();
        if (window?.is_self || (exe && this.selfExePaths.has(exe))) return 'self';
        if (SELF_TITLE_PATTERNS.some(re => re.test(title)) && /msedge|chrome|firefox/.test(name)) return 'self';
        if (cls === RUN_DIALOG_CLASS && RUN_DIALOG_TITLES.includes(title.trim().toLowerCase())) return 'terminal';
        for (const [category, names] of Object.entries(CATEGORY_PROCESSES)) {
            if (names.includes(name)) return category;
        }
        if (name.endsWith('.msc')) return 'security';
        return 'other';
    }

    /** Autonomous mode grants full control; restricted mode retains the legacy tiers. */
    tierFor(window) {
        const category = this.categorize(window);
        const name = String(window?.process_name || '').toLowerCase();
        if (this.autonomousControl) return { category, tier: 'full', hard: false };
        const hard = ['self', 'terminal', 'security', 'auth', 'password_manager'].includes(category);
        if (hard) return { category, tier: 'deny', hard: true };
        if (this.deniedApps.has(name)) return { category, tier: 'deny', hard: false };
        let tier = CATEGORY_DEFAULTS[category]?.tier || 'full';
        if (category === 'browser') tier = this.browserTier;
        if (this.overrides[name] && TIERS[this.overrides[name]]) tier = this.overrides[name];
        return { category, tier, hard: false };
    }

    describe(window) {
        const { category, tier, hard } = this.tierFor(window);
        return {
            category,
            categoryLabel: CATEGORY_DEFAULTS[category]?.label || category,
            tier,
            tierLabel: TIERS[tier].label,
            hard,
            needsFirstUseConfirm: this.needsFirstUseConfirm(window, tier)
        };
    }

    needsFirstUseConfirm(window, tier) {
        if (this.autonomousControl) return false;
        if (!this.confirmFirstUse) return false;
        if (tier === 'deny' || tier === 'view_only') return false;
        const name = String(window?.process_name || '').toLowerCase();
        if (!name) return true;
        return !this.alwaysAllowed.has(name) && !this.sessionAllowed.has(name);
    }

    rememberApp(processName) {
        const name = String(processName || '').toLowerCase();
        if (name) this.sessionAllowed.add(name);
    }

    /**
     * Whether an action kind is allowed for a window.
     * kind: observe | click | type | keys ; returns { allowed, reason, confirmEach, tier, category }
     */
    check(window, kind) {
        const info = this.describe(window);
        const rules = TIERS[info.tier];
        const allowed = kind === 'observe' ? rules.observe : kind === 'click' ? rules.click : kind === 'type' ? rules.type : rules.keys;
        let reason = '';
        if (!allowed) {
            if (info.tier === 'deny') reason = `${info.categoryLabel}（${window?.process_name || '未知进程'}）属于禁区，肥牛不能操作`;
            else if (info.tier === 'view_only') reason = `${info.categoryLabel}目前只允许观察，不允许${kindLabel(kind)}`;
            else if (info.tier === 'click_only') reason = `${info.categoryLabel}目前只允许点击和滚动，不允许${kindLabel(kind)}`;
            else reason = `当前分级 ${info.tierLabel} 不允许${kindLabel(kind)}`;
        }
        return { allowed, reason, confirmEach: rules.confirmEach, ...info };
    }
}

function kindLabel(kind) {
    return { observe: '观察', click: '点击', type: '输入文字', keys: '按键' }[kind] || kind;
}

module.exports = { AppPolicy, TIERS, CATEGORY_DEFAULTS, CATEGORY_PROCESSES };
