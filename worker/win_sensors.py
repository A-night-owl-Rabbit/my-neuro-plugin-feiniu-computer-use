# -*- coding: utf-8 -*-
"""Safety sensors for the desktop worker: DPI awareness, Esc watcher,
cursor-movement tracking (owner is using the mouse), system last-input time /
owner-activity detection (`UserActivityMonitor`) and lock-screen detection."""
import ctypes
import ctypes.wintypes as wintypes
import threading
import time

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

VK_ESCAPE = 0x1B
GENERIC_READ = 0x80000000
UOI_NAME = 2

user32.GetAsyncKeyState.argtypes = (ctypes.c_int,)
user32.GetAsyncKeyState.restype = ctypes.c_short
user32.GetCursorPos.argtypes = (ctypes.POINTER(wintypes.POINT),)
user32.GetCursorPos.restype = wintypes.BOOL
user32.OpenInputDesktop.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
user32.OpenInputDesktop.restype = wintypes.HANDLE
user32.CloseDesktop.argtypes = (wintypes.HANDLE,)
user32.GetUserObjectInformationW.argtypes = (
    wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)
)


class LASTINPUTINFO(ctypes.Structure):
    _fields_ = (("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD))


user32.GetLastInputInfo.argtypes = (ctypes.POINTER(LASTINPUTINFO),)
user32.GetLastInputInfo.restype = wintypes.BOOL
kernel32.GetTickCount.argtypes = ()
kernel32.GetTickCount.restype = wintypes.DWORD


def enable_dpi_awareness():
    """Per-monitor DPI awareness so every coordinate the worker sees is a physical pixel."""
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
        return "per_monitor"
    except Exception:
        pass
    try:
        user32.SetProcessDPIAware()
        return "system"
    except Exception:
        return "none"


def system_dpi():
    try:
        return int(user32.GetDpiForSystem())
    except Exception:
        return 96


user32.GetSystemMetrics.argtypes = (ctypes.c_int,)
user32.GetSystemMetrics.restype = ctypes.c_int
_SM_XVIRTUALSCREEN, _SM_YVIRTUALSCREEN, _SM_CXVIRTUALSCREEN, _SM_CYVIRTUALSCREEN = 76, 77, 78, 79


def virtual_screen():
    """Bounding box of all monitors in physical pixels: (left, top, right, bottom), right/bottom exclusive.
    None when it cannot be determined (the caller then skips range validation instead of blocking)."""
    try:
        left = int(user32.GetSystemMetrics(_SM_XVIRTUALSCREEN))
        top = int(user32.GetSystemMetrics(_SM_YVIRTUALSCREEN))
        width = int(user32.GetSystemMetrics(_SM_CXVIRTUALSCREEN))
        height = int(user32.GetSystemMetrics(_SM_CYVIRTUALSCREEN))
    except Exception:
        return None
    if width <= 0 or height <= 0:
        return None
    return (left, top, left + width, top + height)


def cursor_position():
    pt = wintypes.POINT()
    if not user32.GetCursorPos(ctypes.byref(pt)):
        return None
    return int(pt.x), int(pt.y)


def input_desktop_name():
    handle = user32.OpenInputDesktop(0, False, GENERIC_READ)
    if not handle:
        return None
    try:
        buf = ctypes.create_unicode_buffer(256)
        needed = wintypes.DWORD(0)
        ok = user32.GetUserObjectInformationW(handle, UOI_NAME, buf, ctypes.sizeof(buf), ctypes.byref(needed))
        return buf.value if ok else None
    finally:
        user32.CloseDesktop(handle)


LOCK_PROCESSES = {"lockapp.exe", "logonui.exe"}


def is_locked(foreground_process_name=None):
    """True when the secure desktop / lock screen is active. Input injection must stop."""
    name = input_desktop_name()
    if name is None or (name and name.lower() != "default"):
        return True
    if foreground_process_name and foreground_process_name.lower() in LOCK_PROCESSES:
        return True
    return False


class EscWatcher(threading.Thread):
    """Polls the Esc key while an operation session is active. A press sets `aborted`
    and invokes the callback exactly once per trigger."""

    def __init__(self, on_press, poll_interval=0.05):
        super().__init__(name="esc-watcher", daemon=True)
        self._on_press = on_press
        self._poll = poll_interval
        self._watch_until = 0.0
        self._suppress_until = 0.0
        self._stop_event = threading.Event()
        self._lock = threading.Lock()
        self.aborted = False
        self.aborted_at = None

    def extend(self, window_ms):
        with self._lock:
            self._watch_until = max(self._watch_until, time.monotonic() + max(window_ms, 0) / 1000.0)

    def suppress(self, ms):
        """Ignore Esc briefly, e.g. while the worker itself sends an Esc key."""
        with self._lock:
            self._suppress_until = time.monotonic() + max(ms, 0) / 1000.0

    def reset(self):
        with self._lock:
            self.aborted = False
            self.aborted_at = None
            self._watch_until = 0.0

    def watching(self):
        return time.monotonic() < self._watch_until

    def stop(self):
        self._stop_event.set()

    def run(self):
        while not self._stop_event.is_set():
            now = time.monotonic()
            with self._lock:
                active = now < self._watch_until and now >= self._suppress_until
            if active:
                state = user32.GetAsyncKeyState(VK_ESCAPE)
                if state & 0x8000:
                    with self._lock:
                        self.aborted = True
                        self.aborted_at = time.time()
                        self._watch_until = 0.0
                    try:
                        self._on_press()
                    except Exception:
                        pass
            time.sleep(self._poll)


class CursorTracker:
    """Remembers where the worker last left the cursor so a later displacement can be
    attributed to the owner touching the mouse."""

    def __init__(self, max_age_s=120.0):
        self._mark = None
        self._marked_at = 0.0
        self._max_age = max_age_s

    def mark(self):
        pos = cursor_position()
        if pos is not None:
            self._mark = pos
            self._marked_at = time.monotonic()

    def clear(self):
        self._mark = None
        self._marked_at = 0.0

    def user_moved(self, threshold_px):
        if self._mark is None:
            return False, 0, 0
        if time.monotonic() - self._marked_at > self._max_age:
            return False, 0, 0
        pos = cursor_position()
        if pos is None:
            return False, 0, 0
        dx = pos[0] - self._mark[0]
        dy = pos[1] - self._mark[1]
        moved = (dx * dx + dy * dy) ** 0.5 >= max(threshold_px, 1)
        return moved, dx, dy


# --------------------------------------------------------------------------- owner activity

def system_idle_ms():
    """Milliseconds since the last keyboard/mouse input anywhere in this session
    (GetLastInputInfo). Injected input counts too, which is why `UserActivityMonitor`
    remembers when the worker itself last injected. None when the API is unavailable."""
    info = LASTINPUTINFO()
    info.cbSize = ctypes.sizeof(info)
    try:
        if not user32.GetLastInputInfo(ctypes.byref(info)):
            return None
        return int((kernel32.GetTickCount() - info.dwTime) & 0xFFFFFFFF)
    except Exception:
        return None


_MOUSE_VKS = (0x01, 0x02, 0x04, 0x05, 0x06)
_KEY_VKS = tuple(range(0x08, 0xFF))


def pressed_inputs():
    """'mouse_button' / 'keyboard' while a physical-looking button or key is held down right
    now, else None. Only called while the worker is NOT injecting, so held keys are the owner's."""
    try:
        for vk in _MOUSE_VKS:
            if user32.GetAsyncKeyState(vk) & 0x8000:
                return "mouse_button"
        for vk in _KEY_VKS:
            if user32.GetAsyncKeyState(vk) & 0x8000:
                return "keyboard"
    except Exception:
        pass
    return None


YIELD_SOURCES = ("keyboard", "mouse_button", "cursor_move", "system_input")


class UserActivityMonitor:
    """Decides whether the owner is using the keyboard/mouse right now.

    Pure logic over injectable probes so it is testable without a desktop:
      * `idle_probe()`    -> ms since last system input (or None)
      * `pressed_probe()` -> 'keyboard' | 'mouse_button' | None
      * `clock()`         -> monotonic seconds; `sleep(s)`

    The worker calls `note_injection()` after every SendInput. The system "last input" time
    cannot tell our own events from the owner's, so an input is attributed to the owner only
    when it happened later than the worker's last injection plus `own_grace_s`.
    Known limit: owner input that lands *inside* the window between two of our events is
    indistinguishable from ours; key/button state and cursor displacement still catch most
    of those takeovers.
    """

    def __init__(self, idle_probe=system_idle_ms, pressed_probe=pressed_inputs,
                 clock=time.monotonic, sleep=time.sleep, own_grace_s=0.06):
        self.idle_probe = idle_probe
        self.pressed_probe = pressed_probe
        self.clock = clock
        self.sleep = sleep
        self.own_grace_s = own_grace_s
        self.last_injected_at = None
        self.injections = 0

    def note_injection(self):
        self.last_injected_at = self.clock()
        self.injections += 1

    def snapshot(self, idle_ms):
        """One reading. `active` is True when the owner touched an input device less than
        `idle_ms` ago, or is holding a key/button right now."""
        now = self.clock()
        pressed = None
        try:
            pressed = self.pressed_probe()
        except Exception:
            pressed = None
        system_idle = None
        try:
            system_idle = self.idle_probe()
        except Exception:
            system_idle = None
        owner_idle = None
        if system_idle is not None:
            last_input_at = now - system_idle / 1000.0
            ours = self.last_injected_at is not None and last_input_at <= self.last_injected_at + self.own_grace_s
            owner_idle = None if ours else int(system_idle)
        source = None
        if pressed:
            source = pressed
        elif owner_idle is not None and owner_idle < idle_ms:
            source = "system_input"
        return {
            "active": source is not None,
            "source": source,
            "system_idle_ms": system_idle,
            "owner_idle_ms": owner_idle,
        }

    def wait_until_idle(self, idle_ms, max_wait_ms, poll_ms=50, on_wait=None):
        """Block until the owner has been idle for `idle_ms`, or give up after `max_wait_ms`.
        Returns {active, source, waited_ms, snapshot}. `active` True means: still busy, do NOT inject."""
        started = self.clock()
        snap = self.snapshot(idle_ms)
        if not snap["active"]:
            return {"active": False, "source": None, "waited_ms": 0, "snapshot": snap}
        if on_wait is not None:
            try:
                on_wait(snap)
            except Exception:
                pass
        max_wait_s = max(0, max_wait_ms) / 1000.0
        while (self.clock() - started) < max_wait_s:
            self.sleep(max(1, poll_ms) / 1000.0)
            snap = self.snapshot(idle_ms)
            if not snap["active"]:
                return {"active": False, "source": None, "waited_ms": int((self.clock() - started) * 1000), "snapshot": snap}
        return {"active": True, "source": snap["source"], "waited_ms": int((self.clock() - started) * 1000), "snapshot": snap}
