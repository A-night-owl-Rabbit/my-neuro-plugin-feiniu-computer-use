# -*- coding: utf-8 -*-
"""Launch applications by alias, Start Menu shortcut name or explicit .exe path.
Never passes user text through a shell."""
import os
import re
import shutil
import subprocess
import time
import winreg
from pathlib import Path

import win_windows

ALIASES = {
    "记事本": "notepad.exe", "notepad": "notepad.exe", "笔记本": "notepad.exe",
    "画图": "mspaint.exe", "mspaint": "mspaint.exe", "paint": "mspaint.exe", "画图工具": "mspaint.exe",
    "计算器": "calc.exe", "calc": "calc.exe", "calculator": "calc.exe",
    "资源管理器": "explorer.exe", "文件资源管理器": "explorer.exe", "explorer": "explorer.exe", "文件管理器": "explorer.exe",
    "写字板": "wordpad.exe", "wordpad": "wordpad.exe",
    "截图工具": "SnippingTool.exe", "snippingtool": "SnippingTool.exe",
    "chrome": "chrome.exe", "谷歌浏览器": "chrome.exe", "google chrome": "chrome.exe",
    "edge": "msedge.exe", "microsoft edge": "msedge.exe",
    "firefox": "firefox.exe", "火狐": "firefox.exe",
    "vscode": "Code.exe", "visual studio code": "Code.exe",
    "微信": "WeChat.exe", "wechat": "WeChat.exe", "weixin": "Weixin.exe",
    "qq": "QQ.exe",
    "steam": "steam.exe",
    "任务管理器": "taskmgr.exe",
    "cmd": "cmd.exe", "命令提示符": "cmd.exe",
    "powershell": "powershell.exe", "pwsh": "pwsh.exe",
    "终端": "wt.exe", "windows terminal": "wt.exe",
    "注册表编辑器": "regedit.exe", "regedit": "regedit.exe",
}

# Defence in depth: the JS side has the full policy, the worker refuses the obvious ones.
HARD_DENIED_EXES = {
    "cmd.exe", "powershell.exe", "pwsh.exe", "wt.exe", "windowsterminal.exe", "conhost.exe",
    "regedit.exe", "mmc.exe", "taskmgr.exe", "msconfig.exe", "rundll32.exe", "mshta.exe",
    "wscript.exe", "cscript.exe", "msiexec.exe", "reg.exe", "sc.exe", "schtasks.exe",
    "bcdedit.exe", "diskpart.exe", "format.com", "netsh.exe", "certutil.exe", "bitsadmin.exe",
}

SHELL_META = re.compile(r"[&|<>^%$`;\n\r]|\bcmd\b|\bpowershell\b|\bpwsh\b", re.IGNORECASE)

_index_cache = {"built": 0.0, "items": {}}
INDEX_TTL_S = 60.0


class LaunchError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def start_menu_dirs():
    dirs = []
    program_data = os.environ.get("ProgramData")
    app_data = os.environ.get("APPDATA")
    if program_data:
        dirs.append(Path(program_data) / "Microsoft" / "Windows" / "Start Menu" / "Programs")
    if app_data:
        dirs.append(Path(app_data) / "Microsoft" / "Windows" / "Start Menu" / "Programs")
    return [d for d in dirs if d.is_dir()]


def start_menu_index(force=False):
    now = time.monotonic()
    if not force and _index_cache["items"] and now - _index_cache["built"] < INDEX_TTL_S:
        return _index_cache["items"]
    items = {}
    for base in start_menu_dirs():
        try:
            for lnk in base.rglob("*.lnk"):
                key = lnk.stem.strip().lower()
                if key and key not in items:
                    items[key] = str(lnk)
        except Exception:
            continue
    _index_cache["items"] = items
    _index_cache["built"] = now
    return items


def _app_paths_lookup(exe_name):
    for root in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        try:
            with winreg.OpenKey(root, rf"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exe_name}") as key:
                value, _ = winreg.QueryValueEx(key, None)
                value = os.path.expandvars(str(value)).strip('"')
                if value and os.path.isfile(value):
                    return value
        except OSError:
            continue
    return None


def resolve_executable(exe_name):
    found = shutil.which(exe_name)
    if found:
        return found
    return _app_paths_lookup(exe_name)


def resolve(target, autonomous_control=False):
    """Returns {kind, path, exe_name, display}. kind in alias|start_menu|start_menu_partial|path."""
    text = str(target or "").strip().strip('"')
    if not text:
        raise LaunchError("bad_target", "没有指定要启动的应用")
    if not autonomous_control and SHELL_META.search(text):
        raise LaunchError("denied", "启动目标含有命令行元字符，已拒绝")

    lower = text.lower()
    if lower in ALIASES:
        exe = ALIASES[lower]
        path = resolve_executable(exe)
        if path:
            return {"kind": "alias", "path": path, "exe_name": os.path.basename(path).lower(), "display": text}
        # UWP aliases such as calc.exe resolve through App Paths / PATH; if not, fall through

    index = start_menu_index()
    if lower in index:
        path = index[lower]
        return {"kind": "start_menu", "path": path, "exe_name": _lnk_target_name(path), "display": Path(path).stem}
    partial = [k for k in index if lower in k]
    if len(partial) == 1:
        path = index[partial[0]]
        return {"kind": "start_menu_partial", "path": path, "exe_name": _lnk_target_name(path), "display": Path(path).stem}
    if len(partial) > 1:
        names = sorted(Path(index[k]).stem for k in partial)[:8]
        raise LaunchError("ambiguous", "开始菜单里有多个匹配项，请说得更具体：" + "、".join(names))

    if lower.endswith(".exe") and (os.path.sep in text or "/" in text):
        if os.path.isfile(text):
            return {"kind": "path", "path": text, "exe_name": os.path.basename(text).lower(), "display": Path(text).stem}
        raise LaunchError("not_found", f"找不到可执行文件: {text}")
    if lower.endswith(".exe"):
        path = resolve_executable(text)
        if path:
            return {"kind": "path", "path": path, "exe_name": os.path.basename(path).lower(), "display": Path(path).stem}

    raise LaunchError("not_found", f"找不到名为“{text}”的应用（别名、开始菜单和 PATH 都没有）")


def _lnk_target_name(lnk_path):
    """Best-effort target exe name of a shortcut via the Shell COM object; falls back to the stem."""
    try:
        import win32com.client  # pywin32 is available in the my-neuro env

        shell = win32com.client.Dispatch("WScript.Shell")
        shortcut = shell.CreateShortCut(lnk_path)
        target = str(shortcut.Targetpath or "")
        if target:
            return os.path.basename(target).lower()
    except Exception:
        pass
    return Path(lnk_path).stem.lower() + ".exe"


def launch(target, wait_ms=6000, self_pids=None, self_exe_paths=None, autonomous_control=False):
    resolved = resolve(target, autonomous_control=autonomous_control)
    exe_name = (resolved.get("exe_name") or "").lower()
    if not autonomous_control and exe_name in HARD_DENIED_EXES:
        raise LaunchError("denied", f"{exe_name} 属于禁止启动的程序")

    before = {w["id"] for w in win_windows.list_windows(self_pids=self_pids, include_self=True,
                                                          self_exe_paths=self_exe_paths)}
    started_at = time.time()
    try:
        if resolved["path"].lower().endswith(".lnk"):
            os.startfile(resolved["path"])
        else:
            # Console applications now allowed by autonomous mode need a visible window.
            flag_name = "CREATE_NEW_CONSOLE" if exe_name in {"cmd.exe", "powershell.exe", "pwsh.exe"} else "DETACHED_PROCESS"
            subprocess.Popen([resolved["path"]], shell=False, close_fds=True,
                             creationflags=getattr(subprocess, flag_name, 0))
    except Exception as exc:
        raise LaunchError("launch_failed", f"启动失败: {exc}")

    deadline = time.monotonic() + max(wait_ms, 500) / 1000.0
    new_windows = []
    while time.monotonic() < deadline:
        time.sleep(0.2)
        current = win_windows.list_windows(self_pids=self_pids, self_exe_paths=self_exe_paths,
                                           include_self=autonomous_control)
        new_windows = [w for w in current if w["id"] not in before]
        if new_windows:
            matching = [w for w in new_windows if w["process_name"].lower() == exe_name]
            if matching or exe_name.endswith(".lnk") or not exe_name:
                new_windows = matching or new_windows
                break
    return {
        "resolved": resolved,
        "new_windows": new_windows,
        "elapsed_ms": int((time.time() - started_at) * 1000),
    }
