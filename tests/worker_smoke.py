# -*- coding: utf-8 -*-
"""Manual protocol smoke test for the desktop worker.

    python tests/worker_smoke.py            # read-only ops only (no input is ever injected)
    python tests/worker_smoke.py --real     # also launches Notepad, types into it and closes it

The --real run injects input into the live desktop: keep hands off the mouse/keyboard.
"""
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
WORKER = os.path.join(HERE, "..", "worker", "desktop_worker.py")


class Client:
    def __init__(self):
        self.proc = subprocess.Popen(
            [sys.executable, WORKER],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.next_id = 0
        self.events = []

    def call(self, op, timeout=20, **args):
        self.next_id += 1
        req = {"id": self.next_id, "op": op, "args": args}
        self.proc.stdin.write((json.dumps(req, ensure_ascii=False) + "\n").encode("utf-8"))
        self.proc.stdin.flush()
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("worker closed stdout")
            msg = json.loads(line.decode("utf-8"))
            if "event" in msg:
                self.events.append(msg)
                print(f"    <event> {msg}")
                continue
            if msg.get("id") == self.next_id:
                return msg
        raise TimeoutError(op)

    def close(self):
        try:
            self.call("shutdown", timeout=5)
        except Exception:
            pass
        self.proc.wait(timeout=5)


def show(label, msg, limit=300):
    text = json.dumps(msg, ensure_ascii=False)
    print(f"{label}: {text[:limit]}{'...' if len(text) > limit else ''}")


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    real = "--real" in sys.argv
    c = Client()
    try:
        hello = c.call("hello", esc_watch_window_ms=15000, self_pids=[os.getpid()], generation=42,
                       user_idle_max_wait_ms=999999, type_chunk_size=0)
        show("hello", hello)
        # Protocol v2 (read-only checks): generation echo, capabilities, bounded yield config.
        assert hello["generation"] == 42 and hello["result"]["generation"] == 42, "generation is not echoed"
        assert hello["result"]["protocol"] == 2
        assert hello["result"]["capabilities"]["segmented_typing"] is True
        assert hello["result"]["config"]["user_idle_max_wait_ms"] == 30000, "yield wait is not clamped"
        assert hello["result"]["config"]["type_chunk_size"] == 1, "chunk size is not clamped"
        assert hello["result"]["capabilities"]["coordinate_validation"] is True
        # A stray / stale hello must never reset the generation (read-only; nothing is injected).
        for label, kwargs in (("hello without generation", {}), ("hello with older generation", {"generation": 1}),
                              ("hello with generation 0", {"generation": 0})):
            stray = c.call("hello", **kwargs)
            show(label + " (expect generation kept at 42)", stray)
            assert stray["generation"] == 42 and stray["result"]["generation"] == 42, label
            assert stray["result"]["generation_ignored"]["kept"] == 42, label
        c.call("hello", esc_watch_window_ms=15000, self_pids=[os.getpid()], generation=42)  # restore the real identity
        show("configure (hot, bounded)", c.call("configure", user_idle_ms=1, type_chunk_gap_ms=50))
        state = c.call("state")
        show("state", state)
        assert state["result"]["generation"] == 42
        assert "activity" in state["result"] and "yield_config" in state["result"]
        # Rejected before any wait or input: control characters and oversized text.
        bad = c.call("type_text", text="a\x07b")
        show("type_text control char (expect bad_text, nothing sent)", bad)
        assert bad["code"] == "bad_text" and bad["details"]["injected"] is False and bad["details"]["result_known"] is True
        big = c.call("type_text", text="a" * 5001)
        assert big["code"] == "text_too_long" and big["details"]["injected"] is False
        wins = c.call("list_windows")
        print(f"list_windows: {len(wins['result']['windows'])} windows")
        for w in wins["result"]["windows"][:6]:
            print(f"   [{w['id']}] {w['process_name']} fg={w['is_foreground']} {w['title'][:50]}")
        show("press_key win+d (expect denied)", c.call("press_key", key="win+d"))
        show("press_key ctrl+alt+delete (expect denied)", c.call("press_key", key="ctrl+alt+delete"))
        show("launch cmd (expect denied)", c.call("launch_app", target="cmd.exe"))
        show("resolve 记事本", c.call("resolve_app", target="记事本"))
        show("resolve nonsense", c.call("resolve_app", target="肯定不存在的软件xyz"))

        if not real:
            print("read-only smoke finished (use --real for the Notepad round trip)")
            return

        launched = c.call("launch_app", target="记事本", wait_ms=8000)
        show("launch 记事本", launched)
        windows = launched["result"]["new_windows"]
        assert windows, "Notepad window did not appear"
        hwnd = windows[0]["id"]
        rect = windows[0]["rect"]

        show("activate", c.call("activate_window", id=hwnd))
        fg = c.call("foreground")["result"]
        assert fg and fg["id"] == hwnd, f"foreground is not notepad: {fg}"

        tree = c.call("ui_tree", id=hwnd, depth=4)
        print(f"ui_tree: {tree['result']['element_count']} elements, focused={tree['result']['focused_element'] and tree['result']['focused_element']['type']}")
        editable = [e for e in tree["result"]["elements"] if e["editable"]]
        print(f"   editable elements: {[(e['index'], e['type'], e['name']) for e in editable][:5]}")
        assert editable, "no editable element found in Notepad"

        show("click editable", c.call("click_element", id=hwnd, index=editable[0]["index"]))
        show("type sendinput", c.call("type_text", text="肥牛 Feiniu 123 测试 🐮\n", mode="sendinput"))
        show("type clipboard", c.call("type_text", text="第二行来自剪贴板 Clipboard OK", mode="clipboard"))
        show("press enter", c.call("press_key", key="enter"))
        show("press ctrl+a", c.call("press_key", key="ctrl+a"))
        time.sleep(1.5)
        tree2 = c.call("ui_tree", id=hwnd, depth=4)
        doc = tree2["result"]["document_text"]
        print(f"document_text after typing: {doc!r}")
        assert "肥牛 Feiniu 123 测试" in doc, "typed text not found in document"
        assert "第二行来自剪贴板 Clipboard OK" in doc, "clipboard text not found"
        print(f"selected_text: {tree2['result']['selected_text'][:60]!r}")

        show("scroll", c.call("scroll", x=(rect["left"] + rect["right"]) // 2, y=(rect["top"] + rect["bottom"]) // 2, delta_y=2))

        # Esc from "the owner" (an external process) must abort the session.
        import ctypes
        time.sleep(0.2)
        ctypes.windll.user32.keybd_event(0x1B, 0, 0, 0)
        time.sleep(0.15)
        ctypes.windll.user32.keybd_event(0x1B, 0, 0x0002, 0)
        time.sleep(0.3)
        state = c.call("state")["result"]
        print(f"after external Esc: aborted={state['aborted']} events={[e['event'] for e in c.events]}")
        assert state["aborted"], "Esc watcher did not trigger"
        blocked = c.call("type_text", text="不应该被输入")
        show("type while aborted (expect aborted)", blocked)
        assert not blocked["ok"] and blocked["code"] == "aborted"
        show("new_turn", c.call("new_turn"))
        assert not c.call("state")["result"]["aborted"]
        c.call("activate_window", id=hwnd)

        # Close without saving: Alt+F4 then the "不保存(N)" button.
        show("alt+f4", c.call("press_key", key="alt+f4"))
        time.sleep(0.6)
        show("press n (don't save)", c.call("press_key", key="n"))
        time.sleep(0.5)
        remaining = [w for w in c.call("list_windows")["result"]["windows"] if w["id"] == hwnd]
        print(f"notepad still open: {bool(remaining)}")
        print("real smoke finished OK")
    finally:
        c.close()
        err = c.proc.stderr.read().decode("utf-8", "replace").strip()
        if err:
            print("--- worker stderr ---")
            print(err[-2000:])


if __name__ == "__main__":
    main()
