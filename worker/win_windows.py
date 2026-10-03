# -*- coding: utf-8 -*-
"""Window enumeration, process identity and reliable foreground activation."""
import ctypes
import ctypes.wintypes as wintypes
import time

try:
    import psutil
except ImportError:  # pragma: no cover - psutil is part of the my-neuro env
    psutil = None

user32 = ctypes.WinDLL("user32", use_last_error=True)
dwmapi = ctypes.WinDLL("dwmapi", use_last_error=True)

EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
user32.EnumWindows.argtypes = (EnumWindowsProc, wintypes.LPARAM)
user32.IsWindowVisible.argtypes = (wintypes.HWND,)
user32.IsWindow.argtypes = (wintypes.HWND,)
user32.IsIconic.argtypes = (wintypes.HWND,)
user32.GetWindowTextLengthW.argtypes = (wintypes.HWND,)
user32.GetWindowTextW.argtypes = (wintypes.HWND, wintypes.LPWSTR, ctypes.c_int)
user32.GetClassNameW.argtypes = (wintypes.HWND, wintypes.LPWSTR, ctypes.c_int)
user32.GetWindowRect.argtypes = (wintypes.HWND, ctypes.POINTER(wintypes.RECT))
user32.GetWindowThreadProcessId.argtypes = (wintypes.HWND, ctypes.POINTER(wintypes.DWORD))
user32.GetWindowThreadProcessId.restype = wintypes.DWORD
user32.GetForegroundWindow.restype = wintypes.HWND
user32.SetForegroundWindow.argtypes = (wintypes.HWND,)
user32.BringWindowToTop.argtypes = (wintypes.HWND,)
user32.ShowWindow.argtypes = (wintypes.HWND, ctypes.c_int)
user32.AttachThreadInput.argtypes = (wintypes.DWORD, wintypes.DWORD, wintypes.BOOL)
user32.GetWindowLongW.argtypes = (wintypes.HWND, ctypes.c_int)
user32.GetWindowLongW.restype = wintypes.LONG
user32.GetCurrentThreadId = ctypes.WinDLL("kernel32").GetCurrentThreadId
dwmapi.DwmGetWindowAttribute.argtypes = (wintypes.HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD)

GWL_EXSTYLE = -20
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_NOACTIVATE = 0x08000000
DWMWA_CLOAKED = 14
DWMWA_EXTENDED_FRAME_BOUNDS = 9
SW_RESTORE = 9
SW_SHOW = 5

SKIP_CLASSES = {
    "Progman",               # desktop
    "Shell_TrayWnd",         # taskbar (Start button == Win key, which is denied)
    "Shell_SecondaryTrayWnd",
    "WorkerW",
    "Windows.UI.Core.CoreWindow",
    "ForegroundStaging",
    "MultitaskingViewFrame",
    "XamlExplorerHostIslandWindow",
}

_process_cache = {}


def window_title(hwnd):
    length = user32.GetWindowTextLengthW(hwnd)
    if length <= 0:
        return ""
    buf = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buf, length + 1)
    return buf.value


def window_class(hwnd):
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buf, 256)
    return buf.value


def window_rect(hwnd):
    """Visible frame bounds (excludes the invisible resize borders of modern windows)."""
    rect = wintypes.RECT()
    hr = dwmapi.DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, ctypes.byref(rect), ctypes.sizeof(rect))
    if hr != 0:
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
    return {"left": rect.left, "top": rect.top, "right": rect.right, "bottom": rect.bottom}


def is_cloaked(hwnd):
    cloaked = wintypes.DWORD(0)
    hr = dwmapi.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, ctypes.byref(cloaked), ctypes.sizeof(cloaked))
    return hr == 0 and cloaked.value != 0


def window_pid(hwnd):
    pid = wintypes.DWORD(0)
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return int(pid.value)


def process_identity(pid):
    """(name, exe_path, parent_pid) with a small cache keyed by pid + create time."""
    if psutil is None or pid <= 0:
        return "", "", 0
    try:
        proc = psutil.Process(pid)
        created = proc.create_time()
    except Exception:
        return "", "", 0
    cached = _process_cache.get(pid)
    if cached and cached[0] == created:
        return cached[1]
    name = ""
    exe = ""
    ppid = 0
    try:
        name = proc.name()
    except Exception:
        pass
    try:
        exe = proc.exe()
    except Exception:
        exe = ""
    try:
        ppid = proc.ppid()
    except Exception:
        ppid = 0
    identity = (name, exe, ppid)
    _process_cache[pid] = (created, identity)
    if len(_process_cache) > 512:
        _process_cache.clear()
    return identity


def pid_chain(pid, max_depth=6):
    """pid and its ancestors, used to recognise the companion app's own windows."""
    chain = []
    current = pid
    for _ in range(max_depth):
        if current <= 0 or current in chain:
            break
        chain.append(current)
        _, _, ppid = process_identity(current)
        current = ppid
    return chain


def is_self_process(pid, exe, self_pids=None, self_exe_paths=None):
    """The companion's own windows: same pid as the app, or the same executable
    (Electron helper processes). Children launched by the worker are NOT self."""
    if self_pids and pid in self_pids:
        return True
    if self_exe_paths and exe:
        return exe.lower() in self_exe_paths
    return False


def describe_window(hwnd, foreground_hwnd=None, self_pids=None, self_exe_paths=None):
    if foreground_hwnd is None:
        foreground_hwnd = user32.GetForegroundWindow()
    pid = window_pid(hwnd)
    name, exe, _ = process_identity(pid)
    rect = window_rect(hwnd)
    return {
        "id": int(hwnd),
        "title": window_title(hwnd),
        "class_name": window_class(hwnd),
        "pid": pid,
        "process_name": name,
        "process_path": exe,
        "rect": rect,
        "width": max(0, rect["right"] - rect["left"]),
        "height": max(0, rect["bottom"] - rect["top"]),
        "is_foreground": int(hwnd) == int(foreground_hwnd or 0),
        "is_minimized": bool(user32.IsIconic(hwnd)),
        "is_self": is_self_process(pid, exe, self_pids, self_exe_paths),
    }


def enumerate_hwnds():
    hwnds = []

    def _cb(hwnd, _lparam):
        hwnds.append(int(hwnd))
        return True

    user32.EnumWindows(EnumWindowsProc(_cb), 0)
    return hwnds


def is_candidate(hwnd, include_minimized=True):
    if not user32.IsWindowVisible(hwnd):
        return False
    if is_cloaked(hwnd):
        return False
    ex_style = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
    if ex_style & WS_EX_TOOLWINDOW:
        return False
    if window_class(hwnd) in SKIP_CLASSES:
        return False
    title = window_title(hwnd)
    if not title.strip():
        return False
    if not include_minimized and user32.IsIconic(hwnd):
        return False
    rect = window_rect(hwnd)
    if not user32.IsIconic(hwnd) and (rect["right"] - rect["left"] <= 0 or rect["bottom"] - rect["top"] <= 0):
        return False
    return True


def list_windows(filter_text="", self_pids=None, include_self=False, self_exe_paths=None):
    foreground = user32.GetForegroundWindow()
    needle = (filter_text or "").strip().lower()
    result = []
    for hwnd in enumerate_hwnds():
        if not is_candidate(hwnd):
            continue
        info = describe_window(hwnd, foreground, self_pids, self_exe_paths)
        if info["is_self"] and not include_self:
            continue
        if needle:
            haystack = f"{info['title']} {info['process_name']} {info['class_name']}".lower()
            if needle not in haystack:
                continue
        result.append(info)
    result.sort(key=lambda w: (not w["is_foreground"], w["is_minimized"], w["title"].lower()))
    return result


def window_info(hwnd, self_pids=None, self_exe_paths=None):
    hwnd = int(hwnd)
    if not user32.IsWindow(hwnd):
        return None
    return describe_window(hwnd, None, self_pids, self_exe_paths)


def foreground_info(self_pids=None, self_exe_paths=None):
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return None
    return describe_window(hwnd, hwnd, self_pids, self_exe_paths)


def activate_window(hwnd, settle_s=0.12):
    """Bring a window to the foreground. Falls back to AttachThreadInput, then verifies."""
    hwnd = int(hwnd)
    if not user32.IsWindow(hwnd):
        return {"ok": False, "code": "not_found", "error": "窗口已不存在"}
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, SW_RESTORE)
        time.sleep(settle_s)

    user32.SetForegroundWindow(hwnd)
    time.sleep(settle_s)
    if user32.GetForegroundWindow() == hwnd:
        return {"ok": True, "method": "set_foreground", "title": window_title(hwnd)}

    current_fg = user32.GetForegroundWindow()
    current_thread = user32.GetWindowThreadProcessId(current_fg, None) if current_fg else 0
    target_thread = user32.GetWindowThreadProcessId(hwnd, None)
    my_thread = user32.GetCurrentThreadId()
    attached = []
    for thread in {current_thread, target_thread}:
        if thread and thread != my_thread and user32.AttachThreadInput(my_thread, thread, True):
            attached.append(thread)
    try:
        user32.BringWindowToTop(hwnd)
        user32.ShowWindow(hwnd, SW_SHOW)
        user32.SetForegroundWindow(hwnd)
    finally:
        for thread in attached:
            user32.AttachThreadInput(my_thread, thread, False)
    time.sleep(settle_s + 0.05)

    if user32.GetForegroundWindow() == hwnd:
        return {"ok": True, "method": "attach_thread_input", "title": window_title(hwnd)}

    actual = user32.GetForegroundWindow()
    return {
        "ok": False,
        "code": "activate_failed",
        "error": "无法把目标窗口切到前台",
        "actual_foreground": describe_window(actual) if actual else None,
    }
