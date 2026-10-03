'use strict';

const fs = require('fs');
const path = require('path');
const { redactSecrets } = require('./utils.js');
const { auditFacts } = require('./action-facts.js');

function oneLine(value, maxLength = 6000) {
    const normalized = redactSecrets(String(value ?? ''))
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, Math.max(0, maxLength - 8))}…[已截断]`;
}

/**
 * Two sinks: the WebUI tool log (through context.log, prefixed like codex-bridge) and
 * a daily JSON Lines file under data/ that is pruned after `retentionDays`.
 */
class AuditLogger {
    constructor(options = {}) {
        this.logger = options.logger || (() => {});
        this.detail = options.detail === 'full' ? 'full' : 'summary';
        this.dataDir = options.dataDir || '';
        this.retentionDays = Math.max(1, Number(options.retentionDays) || 7);
        this.logTypedText = options.logTypedText === true;
        this.now = options.now || (() => new Date());
        if (this.dataDir) this._prune();
    }

    configure(options = {}) {
        if (options.detail !== undefined) this.detail = options.detail === 'full' ? 'full' : 'summary';
        if (options.logTypedText !== undefined) this.logTypedText = options.logTypedText === true;
    }

    event(level, name, info = {}) {
        const window = oneLine(info.window || '-', 80);
        const obs = oneLine(info.obs || '-', 40);
        let message = `[TOOL] [ComputerUse] event=${oneLine(name, 60)} window=${window} obs=${obs}`;
        if (info.summary) message += ` ${oneLine(info.summary, 1200)}`;
        const facts = info.facts ? (info.facts.stopped_reason !== undefined ? info.facts : auditFacts(info.facts)) : null;
        if (facts) message += ` facts=${oneLine(JSON.stringify(facts), 600)}`;
        if (this.detail === 'full' && info.detail !== undefined) {
            let serialized = '';
            try { serialized = JSON.stringify(this._sanitize(info.detail)); } catch { serialized = String(info.detail); }
            message += ` detail=${oneLine(serialized, 3000)}`;
        }
        try { this.logger(level || 'info', oneLine(message)); } catch (_) {}
        this._append({ ts: this.now().toISOString(), level, event: name, window: info.window || null, obs: info.obs || null,
            summary: info.summary || null, facts: facts ? this._sanitize(facts) : undefined, detail: this._sanitize(info.detail) });
    }

    _sanitize(detail) {
        if (detail === undefined || detail === null) return detail;
        if (typeof detail === 'string') return redactSecrets(detail);
        if (Array.isArray(detail)) return detail.map(item => this._sanitize(item));
        if (typeof detail === 'object') {
            const out = {};
            for (const [key, value] of Object.entries(detail)) {
                if ((key === 'text' || key === 'value') && !this.logTypedText) {
                    out[`${key}_length`] = [...String(value ?? '')].length; // Unicode characters, same unit as receipts and summaries
                    continue;
                }
                if (key === 'base64') { out.base64_length = String(value ?? '').length; continue; }
                out[key] = this._sanitize(value);
            }
            return out;
        }
        return detail;
    }

    _file() {
        const d = this.now();
        const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
        return path.join(this.dataDir, `action-log-${stamp}.jsonl`);
    }

    _append(record) {
        if (!this.dataDir) return;
        try {
            fs.mkdirSync(this.dataDir, { recursive: true });
            fs.appendFileSync(this._file(), JSON.stringify(record) + '\n', 'utf8');
        } catch (_) {
            // audit file is best effort
        }
    }

    _prune() {
        try {
            if (!fs.existsSync(this.dataDir)) return;
            const cutoff = this.now().getTime() - this.retentionDays * 86400000;
            for (const name of fs.readdirSync(this.dataDir)) {
                const match = /^action-log-(\d{4})(\d{2})(\d{2})\.jsonl$/.exec(name);
                if (!match) continue;
                const fileDate = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
                if (fileDate < cutoff) fs.unlinkSync(path.join(this.dataDir, name));
            }
        } catch (_) {
            // ignore
        }
    }
}

module.exports = { AuditLogger, oneLine };
