'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/**
 * Finds the python.exe of the conda environment once and caches it under data/.
 * Order: explicit config -> cache file -> `conda activate <env>` probe -> MY_NEURO_PYTHON env var.
 */
async function resolvePython(options = {}) {
    const {
        configured = '',
        condaEnv = 'my-neuro',
        cacheFile = '',
        probe = probeConda,
        log = () => {}
    } = options;

    const explicit = String(configured || '').trim().replace(/^"|"$/g, '');
    if (explicit) {
        if (fs.existsSync(explicit)) return { python: explicit, source: 'config' };
        log('warn', `配置的 python_executable 不存在: ${explicit}，改为自动解析`);
    }

    if (cacheFile && fs.existsSync(cacheFile)) {
        try {
            const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
            if (cached?.python && cached.condaEnv === condaEnv && fs.existsSync(cached.python)) {
                return { python: cached.python, source: 'cache' };
            }
        } catch (_) {
            // ignore broken cache
        }
    }

    const probed = await probe(condaEnv).catch(error => {
        log('warn', `conda 环境 ${condaEnv} 解析失败: ${error.message}`);
        return '';
    });
    if (probed && fs.existsSync(probed)) {
        writeCache(cacheFile, { python: probed, condaEnv, resolvedAt: new Date().toISOString() });
        return { python: probed, source: 'conda' };
    }

    const fromEnv = String(process.env.MY_NEURO_PYTHON || '').trim();
    if (fromEnv && fs.existsSync(fromEnv)) return { python: fromEnv, source: 'env' };

    throw new Error(
        `找不到 conda 环境 "${condaEnv}" 的 python.exe。请在插件设置里填写 python_executable（例如 C:\\path\\to\\envs\\my-neuro\\python.exe）。`
    );
}

function writeCache(cacheFile, payload) {
    if (!cacheFile) return;
    try {
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify(payload, null, 2), 'utf8');
    } catch (_) {
        // cache is best effort
    }
}

function probeConda(condaEnv, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const command = `call conda activate ${condaEnv} && python -c "import sys;print(sys.executable)"`;
        // Do not pass cmd /s: it strips quotes and turns `python -c "import sys..."` into a SyntaxError inside Electron.
        const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', command], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            try { child.kill(); } catch (_) {}
            reject(new Error(`conda 探测超时 (${timeoutMs}ms)`));
        }, timeoutMs);
        child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
        child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('exit', code => {
            clearTimeout(timer);
            const lines = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
            const candidate = lines.reverse().find(line => /python(\.exe)?$/i.test(line));
            if (code === 0 && candidate) resolve(candidate);
            else reject(new Error(`conda 返回 ${code}: ${(stderr || stdout).trim().slice(0, 300)}`));
        });
    });
}

module.exports = { resolvePython, probeConda };
