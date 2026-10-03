# -*- coding: utf-8 -*-
"""Minimal Unicode clipboard access with retries (the clipboard is often briefly locked)."""
import time

import win32clipboard
import win32con


def _open(retries=8, delay=0.03):
    last = None
    for _ in range(retries):
        try:
            win32clipboard.OpenClipboard()
            return
        except Exception as exc:  # pywintypes.error: clipboard busy
            last = exc
            time.sleep(delay)
    raise RuntimeError(f"无法打开剪贴板: {last}")


def get_text():
    _open()
    try:
        if win32clipboard.IsClipboardFormatAvailable(win32con.CF_UNICODETEXT):
            return win32clipboard.GetClipboardData(win32con.CF_UNICODETEXT)
        return None
    finally:
        win32clipboard.CloseClipboard()


def set_text(text):
    _open()
    try:
        win32clipboard.EmptyClipboard()
        win32clipboard.SetClipboardData(win32con.CF_UNICODETEXT, str(text))
    finally:
        win32clipboard.CloseClipboard()
