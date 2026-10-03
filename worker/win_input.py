# -*- coding: utf-8 -*-
"""Mouse / keyboard injection through SendInput. All coordinates are physical pixels."""
import ctypes
import ctypes.wintypes as wintypes
import time

user32 = ctypes.WinDLL("user32", use_last_error=True)

INPUT_MOUSE = 0
INPUT_KEYBOARD = 1

KEYEVENTF_EXTENDEDKEY = 0x0001
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
KEYEVENTF_SCANCODE = 0x0008

MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_HWHEEL = 0x1000
WHEEL_DELTA = 120

MAPVK_VK_TO_VSC = 0

ULONG_PTR = ctypes.c_size_t


class MOUSEINPUT(ctypes.Structure):
    _fields_ = (
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    )


class KEYBDINPUT(ctypes.Structure):
    _fields_ = (
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    )


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = (("uMsg", wintypes.DWORD), ("wParamL", wintypes.WORD), ("wParamH", wintypes.WORD))


class _INPUTUNION(ctypes.Union):
    _fields_ = (("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT))


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = (("type", wintypes.DWORD), ("u", _INPUTUNION))


user32.SendInput.argtypes = (wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int)
user32.SendInput.restype = wintypes.UINT
user32.SetCursorPos.argtypes = (ctypes.c_int, ctypes.c_int)
user32.SetCursorPos.restype = wintypes.BOOL
user32.GetCursorPos.argtypes = (ctypes.POINTER(wintypes.POINT),)
user32.MapVirtualKeyW.argtypes = (wintypes.UINT, wintypes.UINT)
user32.MapVirtualKeyW.restype = wintypes.UINT
user32.VkKeyScanW.argtypes = (wintypes.WCHAR,)
user32.VkKeyScanW.restype = ctypes.c_short
user32.GetDoubleClickTime.restype = wintypes.UINT


class InputError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


_INJECTION_HOOK = None


def set_injection_hook(hook):
    """`hook()` runs after every successful SendInput so the worker can tell its own
    input events apart from the owner's (see win_sensors.UserActivityMonitor)."""
    global _INJECTION_HOOK
    _INJECTION_HOOK = hook


def _send(*inputs):
    count = len(inputs)
    array = (INPUT * count)(*inputs)
    sent = user32.SendInput(count, array, ctypes.sizeof(INPUT))
    if sent:
        hook = _INJECTION_HOOK
        if hook is not None:
            try:
                hook()
            except Exception:
                pass
    if sent != count:
        err = ctypes.get_last_error()
        raise InputError("send_input_failed", f"SendInput 只发送了 {sent}/{count} 条事件 (winerror={err})")


def _mouse_input(flags, data=0):
    inp = INPUT(type=INPUT_MOUSE)
    inp.mi = MOUSEINPUT(0, 0, data & 0xFFFFFFFF, flags, 0, 0)
    return inp


def _key_input(vk=0, scan=0, flags=0):
    inp = INPUT(type=INPUT_KEYBOARD)
    inp.ki = KEYBDINPUT(vk, scan, flags, 0, 0)
    return inp


# --------------------------------------------------------------------------- mouse

def cursor_position():
    pt = wintypes.POINT()
    user32.GetCursorPos(ctypes.byref(pt))
    return int(pt.x), int(pt.y)


def move_mouse(x, y):
    x = int(round(x))
    y = int(round(y))
    if not user32.SetCursorPos(x, y):
        raise InputError("move_failed", "SetCursorPos 失败")
    time.sleep(0.02)
    actual = cursor_position()
    if abs(actual[0] - x) > 2 or abs(actual[1] - y) > 2:
        raise InputError("move_mismatch", f"光标未到达目标位置，期望 ({x},{y})，实际 {actual}")
    return actual


_BUTTONS = {
    "left": (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
    "right": (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
    "middle": (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
}


def _button_flags(button):
    key = (button or "left").lower()
    key = {"l": "left", "r": "right", "m": "middle"}.get(key, key)
    if key not in _BUTTONS:
        raise InputError("bad_button", f"不支持的鼠标键: {button}")
    return _BUTTONS[key]


def click(x, y, button="left", count=1, press_ms=40):
    move_mouse(x, y)
    down, up = _button_flags(button)
    count = max(1, min(int(count or 1), 3))
    gap = min(0.12, max(0.05, user32.GetDoubleClickTime() / 4000.0))
    for i in range(count):
        _send(_mouse_input(down))
        time.sleep(press_ms / 1000.0)
        _send(_mouse_input(up))
        if i + 1 < count:
            time.sleep(gap)
    return {"x": x, "y": y, "button": button, "count": count}


def drag(from_x, from_y, to_x, to_y, duration_ms=500, button="left"):
    down, up = _button_flags(button)
    move_mouse(from_x, from_y)
    time.sleep(0.05)
    _send(_mouse_input(down))
    time.sleep(0.05)
    steps = max(4, int(max(duration_ms, 80) / 16))
    for i in range(1, steps + 1):
        t = i / steps
        cx = from_x + (to_x - from_x) * t
        cy = from_y + (to_y - from_y) * t
        user32.SetCursorPos(int(round(cx)), int(round(cy)))
        _send(_mouse_input(MOUSEEVENTF_MOVE))
        time.sleep(max(duration_ms, 80) / 1000.0 / steps)
    user32.SetCursorPos(int(round(to_x)), int(round(to_y)))
    time.sleep(0.05)
    _send(_mouse_input(up))
    return {"from": [from_x, from_y], "to": [to_x, to_y]}


def scroll(x, y, delta_y=0, delta_x=0):
    """delta_* are wheel notches; positive delta_y scrolls down, positive delta_x scrolls right."""
    move_mouse(x, y)
    time.sleep(0.03)
    steps_y = int(delta_y or 0)
    steps_x = int(delta_x or 0)
    if abs(steps_y) > 30 or abs(steps_x) > 30:
        raise InputError("scroll_too_far", "单次滚动不能超过 30 格")
    for _ in range(abs(steps_y)):
        _send(_mouse_input(MOUSEEVENTF_WHEEL, (-WHEEL_DELTA if steps_y > 0 else WHEEL_DELTA)))
        time.sleep(0.02)
    for _ in range(abs(steps_x)):
        _send(_mouse_input(MOUSEEVENTF_HWHEEL, (WHEEL_DELTA if steps_x > 0 else -WHEEL_DELTA)))
        time.sleep(0.02)
    return {"x": x, "y": y, "delta_y": steps_y, "delta_x": steps_x}


# ------------------------------------------------------------------------ keyboard

VK = {
    "backspace": 0x08, "tab": 0x09, "clear": 0x0C, "enter": 0x0D, "return": 0x0D,
    "shift": 0x10, "ctrl": 0x11, "control": 0x11, "alt": 0x12, "menu": 0x12,
    "pause": 0x13, "capslock": 0x14, "esc": 0x1B, "escape": 0x1B, "space": 0x20,
    "pageup": 0x21, "pgup": 0x21, "pagedown": 0x22, "pgdn": 0x22, "end": 0x23, "home": 0x24,
    "left": 0x25, "up": 0x26, "right": 0x27, "down": 0x28,
    "printscreen": 0x2C, "prtsc": 0x2C, "insert": 0x2D, "ins": 0x2D, "delete": 0x2E, "del": 0x2E,
    "apps": 0x5D, "contextmenu": 0x5D,
    "numpad0": 0x60, "numpad1": 0x61, "numpad2": 0x62, "numpad3": 0x63, "numpad4": 0x64,
    "numpad5": 0x65, "numpad6": 0x66, "numpad7": 0x67, "numpad8": 0x68, "numpad9": 0x69,
    "multiply": 0x6A, "add": 0x6B, "separator": 0x6C, "subtract": 0x6D, "decimal": 0x6E, "divide": 0x6F,
    "numlock": 0x90, "scrolllock": 0x91,
    "volumemute": 0xAD, "volumedown": 0xAE, "volumeup": 0xAF,
    "medianext": 0xB0, "mediaprev": 0xB1, "mediastop": 0xB2, "playpause": 0xB3,
    "browserback": 0xA6, "browserforward": 0xA7,
}
for _i in range(1, 25):
    VK[f"f{_i}"] = 0x70 + _i - 1
for _c in "abcdefghijklmnopqrstuvwxyz":
    VK[_c] = ord(_c.upper())
for _d in "0123456789":
    VK[_d] = ord(_d)

KEY_ALIASES = {
    "ctl": "ctrl", "cmdorctrl": "ctrl", "controlorcommand": "ctrl", "option": "alt",
    "esc": "esc", "escape": "esc", "spacebar": "space", "bksp": "backspace",
    "pg_up": "pageup", "pg_dn": "pagedown", "arrowup": "up", "arrowdown": "down",
    "arrowleft": "left", "arrowright": "right", "kp_enter": "enter", "numpadenter": "enter",
    "plus": "=", "minus": "-", "period": ".", "comma": ",", "slash": "/", "backslash": "\\",
    "semicolon": ";", "quote": "'", "grave": "`", "backquote": "`", "bracketleft": "[",
    "bracketright": "]", "equal": "=",
}

DENIED_KEYS = {"win", "lwin", "rwin", "windows", "meta", "super", "cmd", "command", "os", "hyper"}
MODIFIERS = {"ctrl": 0x11, "alt": 0x12, "shift": 0x10, "win": 0x5B, "rwin": 0x5C}
VK.update({"win": 0x5B, "rwin": 0x5C})
EXTENDED_VKS = {0x2D, 0x2E, 0x24, 0x23, 0x21, 0x22, 0x25, 0x26, 0x27, 0x28, 0x90, 0x2C, 0x6F, 0x5B, 0x5C, 0x5D, 0xA3, 0xA5}
DENIED_CHORDS = {frozenset(["ctrl", "alt", "delete"]), frozenset(["ctrl", "shift", "esc"])}


def normalize_key_name(name):
    key = str(name or "").strip().lower().replace(" ", "")
    return KEY_ALIASES.get(key, key)


def parse_chord(chord, autonomous_control=False):
    """Parse keys with the same permission mode as the JS action pipeline."""
    raw = str(chord or "").strip()
    if not raw:
        raise InputError("bad_key", "按键不能为空")
    if raw in ("+", "-"):
        parts = [raw]
    else:
        parts = [p for p in raw.replace("－", "-").split("+")]
        # a trailing '+' means the plus key itself, e.g. 'ctrl++'
        if raw.endswith("+") and parts and parts[-1] == "":
            parts = [p for p in parts if p != ""] + ["="]
    names = [normalize_key_name(p) for p in parts if p != ""]
    if autonomous_control:
        names = [("rwin" if n == "rwin" else "win") if n in DENIED_KEYS else n for n in names]
    if not names:
        raise InputError("bad_key", f"无法解析按键: {chord}")
    for n in names:
        if not autonomous_control and n in DENIED_KEYS:
            raise InputError("denied", "不允许使用 Windows 键及其组合键")
    modifiers = [n for n in names[:-1]]
    key = names[-1]
    for m in modifiers:
        if m not in MODIFIERS:
            raise InputError("bad_key", f"不支持的修饰键: {m}")
    if key in MODIFIERS and len(names) == 1 and key not in ("win", "rwin"):
        raise InputError("bad_key", "不能单独按修饰键")
    chord_keys = frozenset(modifiers + [key])
    if autonomous_control and chord_keys == frozenset(["ctrl", "alt", "delete"]):
        raise InputError("unsupported_key", "Windows 的 Ctrl+Alt+Delete 安全注意序列无法通过 SendInput 模拟")
    if not autonomous_control and chord_keys in DENIED_CHORDS:
        raise InputError("denied", f"组合键 {chord} 被禁止")
    return modifiers, key


def _resolve_vk(key):
    if key in VK:
        return VK[key], False
    if len(key) == 1:
        code = user32.VkKeyScanW(key)
        if code == -1:
            raise InputError("bad_key", f"当前键盘布局无法输入字符: {key}")
        vk = code & 0xFF
        needs_shift = bool((code >> 8) & 1)
        return vk, needs_shift
    raise InputError("bad_key", f"未知按键名: {key}")


def _vk_events(vk, keyup=False):
    scan = user32.MapVirtualKeyW(vk, MAPVK_VK_TO_VSC)
    flags = KEYEVENTF_KEYUP if keyup else 0
    if vk in EXTENDED_VKS:
        flags |= KEYEVENTF_EXTENDEDKEY
    return _key_input(vk, scan, flags)


def press_key(chord, repeat=1, hold_ms=30, gap_ms=40, autonomous_control=False):
    modifiers, key = parse_chord(chord, autonomous_control=autonomous_control)
    vk, needs_shift = _resolve_vk(key)
    mod_vks = [MODIFIERS[m] for m in modifiers]
    if needs_shift and MODIFIERS["shift"] not in mod_vks:
        mod_vks.append(MODIFIERS["shift"])
    repeat = max(1, min(int(repeat or 1), 20))
    for i in range(repeat):
        for mv in mod_vks:
            _send(_vk_events(mv))
        time.sleep(0.01)
        _send(_vk_events(vk))
        time.sleep(hold_ms / 1000.0)
        _send(_vk_events(vk, keyup=True))
        for mv in reversed(mod_vks):
            _send(_vk_events(mv, keyup=True))
        if i + 1 < repeat:
            time.sleep(gap_ms / 1000.0)
    return {"chord": chord, "modifiers": modifiers, "key": key, "repeat": repeat}


def _unicode_events(char):
    """One (down, up) pair per UTF-16 code unit, so surrogate pairs type correctly."""
    events = []
    data = char.encode("utf-16-le")
    for i in range(0, len(data), 2):
        code = data[i] | (data[i + 1] << 8)
        events.append((_key_input(0, code, KEYEVENTF_UNICODE), _key_input(0, code, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)))
    return events


CONTROL_CHARS = {c for c in map(chr, range(0, 32))} - {"\n", "\r", "\t"}

DEFAULT_CHUNK_SIZE = 16


def validate_text(text):
    """Reject control characters up front, before a single key is sent."""
    for ch in str(text):
        if ch in CONTROL_CHARS:
            raise InputError("bad_text", "文本包含不允许的控制字符")


def split_chunks(text, size=DEFAULT_CHUNK_SIZE):
    """Splits into runs of at most `size` Unicode code points (never code units or bytes).
    A CRLF pair is kept together so a chunk boundary can not separate \\r from \\n."""
    text = str(text)
    size = max(1, int(size or DEFAULT_CHUNK_SIZE))
    chunks = []
    start = 0
    while start < len(text):
        end = min(len(text), start + size)
        if end < len(text) and text[end - 1] == "\r" and text[end] == "\n":
            end += 1
        chunks.append(text[start:end])
        start = end
    return chunks


def _type_chunk(chunk, interval_ms, sleep, progress=None):
    """Types one chunk; returns how many code points were consumed (CRLF counts as 2).
    `progress[0]` is advanced after each fully sent character so a failure keeps an honest count."""
    i = 0
    while i < len(chunk):
        ch = chunk[i]
        if ch == "\r":
            if i + 1 < len(chunk) and chunk[i + 1] == "\n":
                i += 1
            press_key("enter")
        elif ch == "\n":
            press_key("enter")
        elif ch == "\t":
            press_key("tab")
        else:
            for down, up in _unicode_events(ch):
                _send(down)
                sleep(0.002)
                _send(up)
        i += 1
        if progress is not None:
            progress[0] = i
        if interval_ms > 0:
            sleep(interval_ms / 1000.0)
    return i


def type_text_sendinput(text, interval_ms=8, chunk_size=DEFAULT_CHUNK_SIZE, chunk_gap_ms=0,
                        checkpoint=None, sleep=time.sleep):
    """Types literal text with KEYEVENTF_UNICODE in chunks of `chunk_size` code points;
    newlines become Enter, tabs become Tab.

    Between chunks the worker waits `chunk_gap_ms`, then calls `checkpoint(typed)`. A truthy
    return value (Esc / lock screen / owner activity, supplied by the worker) stops typing:
    the result then carries `completed=False`, the exact `typed` count and the checkpoint
    value as `stop`. `typed` always counts Unicode code points actually sent."""
    text = str(text)
    validate_text(text)
    chunks = split_chunks(text, chunk_size)
    typed = 0
    stop = None
    sent_chunks = 0
    for index, chunk in enumerate(chunks):
        if index > 0:
            if chunk_gap_ms > 0:
                sleep(chunk_gap_ms / 1000.0)
            if checkpoint is not None:
                stop = checkpoint(typed)
                if stop:
                    break
        progress = [0]
        try:
            typed += _type_chunk(chunk, interval_ms, sleep, progress)
        except InputError as exc:
            exc.typed = typed + progress[0]  # fully sent characters only; one more may be half sent
            exc.input_total = len(text)
            raise
        sent_chunks += 1
    return {
        "typed": typed,
        "input_total": len(text),
        "completed": stop is None and typed == len(text),
        "mode": "sendinput",
        "segmented": True,
        "chunk_size": max(1, int(chunk_size or DEFAULT_CHUNK_SIZE)),
        "chunks_sent": sent_chunks,
        "chunks_total": len(chunks),
        "stop": stop or None,
    }


def type_text_clipboard(text, settle_ms=250, restore_delay_ms=1200):
    """Paste via the clipboard. The previous clipboard text is restored later in the
    background, and only if the clipboard still holds our text — restoring too early
    makes a slow target app paste the *old* content. One paste is atomic: it can not be
    split or stopped half way, so the result says `segmented=False`."""
    import threading
    from win_clipboard import get_text, set_text  # local import: clipboard module is optional

    text = str(text)
    validate_text(text)
    previous = get_text()
    set_text(text)
    time.sleep(0.05)
    press_key("ctrl+v")
    time.sleep(settle_ms / 1000.0)

    def _restore():
        time.sleep(restore_delay_ms / 1000.0)
        try:
            if get_text() == text:
                set_text(previous if previous is not None else "")
        except Exception:
            pass

    if previous is not None and previous != text:
        threading.Thread(target=_restore, name="clipboard-restore", daemon=True).start()
    return {
        "typed": len(text), "input_total": len(text), "completed": True, "mode": "clipboard",
        "segmented": False, "stop": None,
        "clipboard_restore": "scheduled" if previous is not None else "none",
    }


def type_text(text, mode="sendinput", interval_ms=8, chunk_size=DEFAULT_CHUNK_SIZE, chunk_gap_ms=0, checkpoint=None):
    if not str(text):
        return {"typed": 0, "input_total": 0, "completed": True, "mode": mode, "segmented": mode != "clipboard", "stop": None}
    if mode == "clipboard":
        return type_text_clipboard(text)
    return type_text_sendinput(text, interval_ms=interval_ms, chunk_size=chunk_size,
                               chunk_gap_ms=chunk_gap_ms, checkpoint=checkpoint)
