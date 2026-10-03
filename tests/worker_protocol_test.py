# -*- coding: utf-8 -*-
"""Protocol regressions for owner-yield, segmented typing, fact block and error classification.

Nothing here touches the real desktop: SendInput / click / key presses are replaced with
recording stubs, the Esc watcher is a stub, and time/idle/foreground probes are fakes."""
import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "worker"))
import desktop_worker  # noqa: E402
import win_input  # noqa: E402
import win_sensors  # noqa: E402
from desktop_worker import DesktopWorker  # noqa: E402

REAL_VIRTUAL_SCREEN = win_sensors.virtual_screen  # the untouched probe, for the one test that wants the real thing

FOREGROUND = {"id": 100, "title": "无标题 - 记事本", "process_name": "notepad.exe", "pid": 4000}


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def now(self):
        return self.t

    def sleep(self, seconds):
        self.t += seconds


class FakeInput:
    """Idle/pressed probes backed by the fake clock."""

    def __init__(self, clock):
        self.clock = clock
        self.last_input_at = None
        self.pressed = None
        self.busy_until = None  # owner keeps touching the mouse until this fake time

    def idle(self):
        if self.busy_until is not None and self.clock.t < self.busy_until:
            return 10  # last input 10 ms ago
        if self.last_input_at is None:
            return 10_000_000
        return max(0, int((self.clock.t - self.last_input_at) * 1000))

    def pressed_probe(self):
        return self.pressed


class StubEsc:
    def __init__(self, *_args, **_kwargs):
        self.aborted = False
        self.aborted_at = None
        self.extended = 0
        self.suppressed = 0

    def start(self):
        pass

    def stop(self):
        pass

    def extend(self, _ms):
        self.extended += 1

    def suppress(self, _ms):
        self.suppressed += 1

    def reset(self):
        self.aborted = False

    def watching(self):
        return True


class Sink(io.BytesIO):
    pass


class ProtocolBase(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.fake_input = FakeInput(self.clock)
        self.cursor = [500, 400]
        self.locked = False
        self.screen = (0, 0, 1920, 1080)  # virtual screen used by the worker's coordinate validation
        self.sends = []
        patches = [
            patch.object(desktop_worker.win_sensors, "EscWatcher", StubEsc),
            patch.object(desktop_worker.win_sensors, "cursor_position", lambda: tuple(self.cursor)),
            patch.object(desktop_worker.win_sensors, "is_locked", lambda _name=None: self.locked),
            patch.object(desktop_worker.win_windows, "foreground_info", lambda *_a, **_k: dict(FOREGROUND)),
            patch.object(desktop_worker, "_monitors", lambda: [{"index": 0}]),
            patch.object(desktop_worker.win_sensors, "virtual_screen", lambda: self.screen),
            patch.object(win_input, "_send", self._fake_send),
            patch.object(win_input.time, "sleep", lambda _s: None),
            patch.object(desktop_worker.traceback, "print_exc", lambda *a, **k: None),  # expected, keep the log quiet
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.out = Sink()
        self.worker = DesktopWorker(self.out)
        self.worker.activity = win_sensors.UserActivityMonitor(
            idle_probe=self.fake_input.idle, pressed_probe=self.fake_input.pressed_probe,
            clock=self.clock.now, sleep=self.clock.sleep)
        win_input.set_injection_hook(self.worker.activity.note_injection)
        self.addCleanup(win_input.set_injection_hook, None)
        self.owner_takes_over_after_sends = None
        self.fail_send_at = None
        self.worker.handle({"id": 0, "op": "hello", "args": {
            "generation": 7, "type_interval_ms": 0, "type_chunk_gap_ms": 0,
            "user_idle_ms": 500, "user_idle_max_wait_ms": 0, "autonomous_control": True}})
        self.out.seek(0)
        self.out.truncate()

    def _fake_send(self, *inputs):
        if self.fail_send_at is not None and len(self.sends) + 1 >= self.fail_send_at:
            raise win_input.InputError("send_input_failed", "SendInput 只发送了 0/1 条事件")
        self.sends.append(len(inputs))
        self.clock.t += 0.001
        self.worker.activity.note_injection()
        self.fake_input.last_input_at = self.clock.t  # injected input also updates the system last-input time
        if self.owner_takes_over_after_sends and len(self.sends) == self.owner_takes_over_after_sends:
            self.clock.t += 0.2
            self.fake_input.last_input_at = self.clock.t - 0.05  # the owner typed 50 ms ago

    def request(self, op, **args):
        self.out.seek(0)
        self.out.truncate()
        self.worker.handle({"id": 1, "op": op, "args": args})
        lines = [json.loads(line) for line in self.out.getvalue().decode("utf-8").splitlines() if line.strip()]
        responses = [m for m in lines if "event" not in m]
        self.events = [m for m in lines if "event" in m]
        self.assertEqual(len(responses), 1, lines)
        return responses[0]


class UserActivityMonitorTests(unittest.TestCase):
    def make(self):
        clock = FakeClock()
        fake = FakeInput(clock)
        monitor = win_sensors.UserActivityMonitor(idle_probe=fake.idle, pressed_probe=fake.pressed_probe,
                                                  clock=clock.now, sleep=clock.sleep)
        return clock, fake, monitor

    def test_idle_owner_does_not_wait(self):
        clock, fake, monitor = self.make()
        outcome = monitor.wait_until_idle(500, 3000)
        self.assertFalse(outcome["active"])
        self.assertEqual(outcome["waited_ms"], 0)

    def test_recent_owner_input_waits_until_idle_then_proceeds(self):
        clock, fake, monitor = self.make()
        fake.last_input_at = clock.t - 0.1
        seen = []
        outcome = monitor.wait_until_idle(500, 3000, poll_ms=50, on_wait=seen.append)
        self.assertFalse(outcome["active"])
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0]["source"], "system_input")
        self.assertTrue(300 <= outcome["waited_ms"] <= 500, outcome)

    def test_gives_up_after_max_wait_without_injecting(self):
        clock, fake, monitor = self.make()
        fake.busy_until = clock.t + 60
        outcome = monitor.wait_until_idle(500, 400, poll_ms=50)
        self.assertTrue(outcome["active"])
        self.assertEqual(outcome["source"], "system_input")
        self.assertTrue(400 <= outcome["waited_ms"] <= 500, outcome)

    def test_zero_max_wait_reports_immediately(self):
        clock, fake, monitor = self.make()
        fake.last_input_at = clock.t
        outcome = monitor.wait_until_idle(500, 0)
        self.assertTrue(outcome["active"])
        self.assertEqual(outcome["waited_ms"], 0)

    def test_own_injection_is_not_attributed_to_the_owner(self):
        clock, fake, monitor = self.make()
        clock.t += 1
        monitor.note_injection()
        fake.last_input_at = clock.t  # SendInput updated the system last-input time
        clock.t += 0.01
        self.assertFalse(monitor.snapshot(500)["active"])
        self.assertIsNone(monitor.snapshot(500)["owner_idle_ms"])

    def test_owner_input_after_injection_plus_grace_is_attributed(self):
        clock, fake, monitor = self.make()
        monitor.note_injection()
        clock.t += 0.2
        fake.last_input_at = clock.t - 0.05
        snap = monitor.snapshot(500)
        self.assertTrue(snap["active"])
        self.assertEqual(snap["source"], "system_input")
        self.assertIn(snap["owner_idle_ms"], (49, 50))  # float clock, int ms

    def test_held_key_or_button_counts_as_owner(self):
        clock, fake, monitor = self.make()
        fake.pressed = "keyboard"
        self.assertEqual(monitor.snapshot(500)["source"], "keyboard")
        fake.pressed = "mouse_button"
        self.assertEqual(monitor.snapshot(500)["source"], "mouse_button")

    def test_unavailable_probes_never_block(self):
        monitor = win_sensors.UserActivityMonitor(idle_probe=lambda: None, pressed_probe=lambda: None)
        self.assertFalse(monitor.snapshot(500)["active"])
        broken = win_sensors.UserActivityMonitor(idle_probe=lambda: 1 / 0, pressed_probe=lambda: 1 / 0)
        self.assertFalse(broken.snapshot(500)["active"])


class SegmentedTypingTests(unittest.TestCase):
    def setUp(self):
        self.sends = []
        for p in (patch.object(win_input, "_send", lambda *i: self.sends.append(len(i))),
                  patch.object(win_input, "press_key", lambda key, *a, **k: self.sends.append(key))):
            p.start()
            self.addCleanup(p.stop)

    def test_chunks_count_unicode_code_points_not_bytes_or_utf16_units(self):
        text = "肥牛" * 10 + "🐮" * 3  # 23 code points, 29 UTF-16 units, 69 UTF-8 bytes
        chunks = win_input.split_chunks(text, 16)
        self.assertEqual([len(c) for c in chunks], [16, 7])
        self.assertEqual("".join(chunks), text)
        result = win_input.type_text_sendinput(text, interval_ms=0, chunk_size=16, sleep=lambda _s: None)
        self.assertEqual((result["typed"], result["input_total"], result["completed"]), (23, 23, True))
        self.assertEqual(result["chunks_sent"], 2)
        # astral characters need a surrogate pair: 2 UTF-16 units x (down, up)
        self.assertEqual(len(win_input._unicode_events("🐮")), 2)

    def test_crlf_is_never_split_and_counts_two(self):
        chunks = win_input.split_chunks("ab\r\ncd", 3)
        self.assertEqual(chunks, ["ab\r\n", "cd"])
        result = win_input.type_text_sendinput("a\r\nb", interval_ms=0, chunk_size=2, sleep=lambda _s: None)
        self.assertEqual((result["typed"], result["input_total"]), (4, 4))

    def test_checkpoint_stop_reports_partial_count(self):
        calls = []

        def checkpoint(typed):
            calls.append(typed)
            return {"code": "user_active", "reason": "user_active"} if typed >= 32 else None

        result = win_input.type_text_sendinput("x" * 100, interval_ms=0, chunk_size=16,
                                               checkpoint=checkpoint, sleep=lambda _s: None)
        self.assertEqual(calls, [16, 32])
        self.assertEqual((result["typed"], result["input_total"], result["completed"]), (32, 100, False))
        self.assertEqual(result["stop"]["code"], "user_active")
        self.assertEqual(result["chunks_sent"], 2)
        self.assertEqual(len(self.sends), 32 * 2)

    def test_control_characters_rejected_before_anything_is_sent(self):
        with self.assertRaises(win_input.InputError) as ctx:
            win_input.type_text_sendinput("hello\x07world", interval_ms=0, sleep=lambda _s: None)
        self.assertEqual(ctx.exception.code, "bad_text")
        self.assertEqual(self.sends, [])

    def test_send_failure_keeps_a_lower_bound_count(self):
        state = {"n": 0}

        def flaky(*inputs):
            state["n"] += 1
            if state["n"] == 11:
                raise win_input.InputError("send_input_failed", "boom")

        with patch.object(win_input, "_send", flaky):
            with self.assertRaises(win_input.InputError) as ctx:
                win_input.type_text_sendinput("x" * 40, interval_ms=0, chunk_size=16, sleep=lambda _s: None)
        self.assertEqual(ctx.exception.typed, 5)  # 5 full characters (10 events) before the 11th event failed
        self.assertEqual(ctx.exception.input_total, 40)

    def test_empty_text_and_clipboard_capability(self):
        self.assertEqual(win_input.type_text("")["typed"], 0)
        self.assertTrue(win_input.type_text("", mode="sendinput")["completed"])


class WorkerProtocolTests(ProtocolBase):
    def test_hello_echoes_generation_clamps_bounds_and_lists_capabilities(self):
        response = self.request("hello", generation=9, user_idle_max_wait_ms=999999, type_chunk_size=0,
                                user_idle_ms=1, type_chunk_gap_ms=-5, esc_watch_window_ms=15000)
        result = response["result"]
        self.assertEqual(response["generation"], 9)
        self.assertEqual(result["generation"], 9)
        self.assertEqual(result["config"]["user_idle_max_wait_ms"], 30000)
        self.assertEqual(result["config"]["type_chunk_size"], 1)
        self.assertEqual(result["config"]["user_idle_ms"], 100)
        self.assertEqual(result["config"]["type_chunk_gap_ms"], 0)
        self.assertTrue(result["capabilities"]["segmented_typing"])
        self.assertFalse(result["capabilities"]["clipboard_typing_segmented"])
        self.assertEqual(result["protocol"], 2)
        self.assertEqual(result["config"]["user_idle_yield"], True)

    def test_configure_is_hot_and_cannot_change_autonomy(self):
        self.assertTrue(self.worker.config["autonomous_control"])
        response = self.request("configure", user_idle_yield=False, user_idle_max_wait_ms=1234, autonomous_control=False)
        self.assertEqual(response["result"]["config"]["user_idle_max_wait_ms"], 1234)
        self.assertFalse(response["result"]["config"]["user_idle_yield"])
        self.assertTrue(self.worker.config["autonomous_control"])
        self.assertEqual(response["result"]["generation"], 7)

    def test_every_response_carries_the_generation(self):
        self.assertEqual(self.request("state")["generation"], 7)
        self.assertEqual(self.request("nope")["generation"], 7)
        self.assertEqual(self.request("click")["generation"], 7)  # bad args

    def test_idle_click_returns_the_unified_fact_block(self):
        with patch.object(win_input, "click", return_value={"x": 5, "y": 6, "button": "left", "count": 1}):
            response = self.request("click", x=5, y=6)
        result = response["result"]
        self.assertTrue(response["ok"])
        self.assertEqual((result["yielded"], result["waited_ms"], result["stopped_reason"], result["result_known"]),
                         (False, 0, None, True))
        self.assertEqual(result["generation"], 7)
        self.assertEqual(result["foreground"]["process_name"], "notepad.exe")
        self.assertEqual(result["cursor"], {"x": 500, "y": 400})

    def test_busy_owner_blocks_click_before_any_input(self):
        self.fake_input.busy_until = self.clock.t + 60
        with patch.object(win_input, "click") as click:
            response = self.request("click", x=5, y=6)
        click.assert_not_called()
        self.assertFalse(response["ok"])
        self.assertEqual(response["code"], "user_active")
        details = response["details"]
        self.assertEqual((details["yielded"], details["stopped_reason"], details["result_known"], details["injected"]),
                         (True, "user_active", True, False))
        self.assertEqual(details["yield_source"], "system_input")
        self.assertEqual(details["foreground"]["process_name"], "notepad.exe")
        self.assertTrue(any(e["event"] == "user_activity" for e in self.events))

    def test_owner_who_stops_in_time_only_delays_the_action(self):
        self.request("configure", user_idle_max_wait_ms=3000)
        self.fake_input.busy_until = self.clock.t + 0.4
        with patch.object(win_input, "click", return_value={"x": 1, "y": 1}) as click:
            response = self.request("click", x=1, y=1)
        click.assert_called_once()
        self.assertTrue(response["ok"], response)
        result = response["result"]
        self.assertGreaterEqual(result["waited_ms"], 300)
        self.assertFalse(result["yielded"])
        self.assertTrue(any(e["event"] == "user_wait" for e in self.events))

    def test_every_desktop_changing_op_yields(self):
        self.fake_input.busy_until = self.clock.t + 60
        cases = {
            "activate_window": {"id": 1}, "move_mouse": {"x": 1, "y": 1}, "click": {"x": 1, "y": 1},
            "click_element": {"id": 1, "index": 0}, "drag": {"from_x": 1, "from_y": 1, "to_x": 2, "to_y": 2},
            "scroll": {"x": 1, "y": 1, "delta_y": 1}, "type_text": {"text": "abc"}, "press_key": {"key": "enter"},
            "set_value": {"id": 1, "index": 0, "value": "v"}, "launch_app": {"target": "notepad"},
        }
        self.assertEqual(set(cases), set(desktop_worker.ACTION_OPS))
        for op, args in cases.items():
            with self.subTest(op=op):
                response = self.request(op, **args)
                self.assertEqual(response["code"], "user_active")
                self.assertTrue(response["details"]["yielded"])
                self.assertFalse(response["details"]["injected"])
        self.assertEqual(self.sends, [])

    def test_hotkey_denied_check_runs_before_waiting(self):
        self.request("hello", autonomous_control=False, generation=7)
        self.fake_input.busy_until = self.clock.t + 60
        response = self.request("press_key", key="win+d")
        self.assertEqual(response["code"], "denied")
        self.assertEqual(response["details"]["waited_ms"], 0)

    def test_yield_can_be_switched_off(self):
        self.request("configure", user_idle_yield=False)
        self.fake_input.busy_until = self.clock.t + 60
        with patch.object(win_input, "click", return_value={}):
            self.assertTrue(self.request("click", x=1, y=1)["ok"])

    def test_cursor_displacement_yields_once_then_clears(self):
        with patch.object(win_input, "click", return_value={}):
            self.assertTrue(self.request("click", x=1, y=1)["ok"])  # marks the cursor
            self.cursor[:] = [900, 900]
            response = self.request("click", x=1, y=1)
            self.assertEqual(response["code"], "user_active")
            self.assertEqual(response["details"]["yield_source"], "cursor_move")
            self.assertEqual(response["details"]["injected"], False)
            self.assertTrue(self.request("click", x=1, y=1)["ok"])

    def test_esc_and_lock_have_their_own_reasons(self):
        self.worker.esc.aborted = True
        response = self.request("click", x=1, y=1)
        self.assertEqual((response["code"], response["details"]["stopped_reason"]), ("aborted", "esc"))
        self.assertTrue(response["details"]["result_known"])
        self.worker.esc.aborted = False
        self.locked = True
        response = self.request("press_key", key="enter")
        self.assertEqual((response["code"], response["details"]["stopped_reason"]), ("locked", "locked"))

    def test_type_text_completes_with_exact_counts(self):
        text = "肥牛电脑操作" * 8 + "🐮"  # 49 code points -> 4 chunks
        response = self.request("type_text", text=text, mode="sendinput")
        result = response["result"]
        self.assertTrue(response["ok"], response)
        self.assertEqual((result["typed"], result["input_total"], result["completed"]), (49, 49, True))
        self.assertEqual(result["chunks_sent"], 4)
        self.assertTrue(result["result_known"])
        self.assertNotIn("text", result)

    def test_owner_takes_over_mid_text_reports_partial_and_stops(self):
        self.request("configure", user_idle_max_wait_ms=0, type_chunk_size=16)
        self.owner_takes_over_after_sends = 2 * 16 * 2  # after the second chunk (2 events per character)
        response = self.request("type_text", text="x" * 100, mode="sendinput")
        self.assertFalse(response["ok"])
        self.assertEqual(response["code"], "user_active")
        details = response["details"]
        self.assertEqual((details["typed"], details["input_total"], details["completed"]), (32, 100, False))
        self.assertEqual((details["stopped_reason"], details["yielded"], details["result_known"]), ("user_active", True, True))
        self.assertTrue(details["injected"])
        self.assertEqual(len(self.sends), 64, "no keys were sent after the takeover")
        self.assertIn("32/100", response["error"])
        self.assertNotIn("xxxx", response["error"])

    def test_mouse_move_mid_text_also_stops_typing(self):
        with patch.object(win_input, "click", return_value={}):
            self.request("click", x=1, y=1)  # mark the cursor position
        real_send = self._fake_send

        def move_after_first_chunk(*inputs):
            real_send(*inputs)
            if len(self.sends) == 32:
                self.cursor[:] = [self.cursor[0] + 300, self.cursor[1]]

        with patch.object(win_input, "_send", move_after_first_chunk):
            response = self.request("type_text", text="y" * 64)
        self.assertEqual(response["code"], "user_active")
        self.assertEqual(response["details"]["yield_source"], "cursor_move")
        self.assertEqual(response["details"]["typed"], 16)

    def test_esc_and_lock_mid_text(self):
        def esc_after_first_chunk(*inputs):
            self._fake_send(*inputs)
            if len(self.sends) == 32:
                self.worker.esc.aborted = True

        with patch.object(win_input, "_send", esc_after_first_chunk):
            response = self.request("type_text", text="z" * 64)
        self.assertEqual((response["code"], response["details"]["stopped_reason"], response["details"]["typed"]), ("aborted", "esc", 16))
        self.worker.esc.aborted = False
        self.sends.clear()

        def lock_after_first_chunk(*inputs):
            self._fake_send(*inputs)
            if len(self.sends) == 32:
                self.locked = True

        with patch.object(win_input, "_send", lock_after_first_chunk):
            response = self.request("type_text", text="z" * 64)
        self.assertEqual((response["code"], response["details"]["stopped_reason"], response["details"]["typed"]), ("locked", "locked", 16))

    def test_oversized_and_control_text_send_nothing(self):
        response = self.request("type_text", text="a" * 5001)
        self.assertEqual(response["code"], "text_too_long")
        response = self.request("type_text", text="ab\x07cd")
        self.assertEqual(response["code"], "bad_text")
        self.assertEqual(self.sends, [])
        self.assertFalse(response["details"]["injected"])

    def test_error_in_the_middle_of_typing_is_result_unknown_with_lower_bound(self):
        self.fail_send_at = 11
        response = self.request("type_text", text="q" * 40)
        details = response["details"]
        self.assertEqual(response["code"], "send_input_failed")
        self.assertEqual(details["stopped_reason"], "worker_error")
        self.assertEqual((details["typed"], details["typed_exact"], details["result_known"]), (5, False, False))
        self.assertTrue(details["injected"])

    def test_unexpected_exception_after_injection_is_unknown_and_worker_survives(self):
        def explode(*_a, **_k):
            self.worker.activity.note_injection()
            raise RuntimeError("native crash")

        with patch.object(win_input, "click", explode):
            response = self.request("click", x=1, y=1)
        self.assertEqual(response["code"], "internal")
        self.assertEqual(response["details"]["stopped_reason"], "worker_error")
        self.assertFalse(response["details"]["result_known"])
        self.assertTrue(response["details"]["injected"])
        self.assertTrue(self.request("state")["ok"], "the main loop keeps serving")

    def test_unexpected_exception_before_injection_is_still_known(self):
        with patch.object(win_input, "click", side_effect=RuntimeError("early")):
            response = self.request("click", x=1, y=1)
        self.assertEqual(response["code"], "internal")
        self.assertTrue(response["details"]["result_known"])
        self.assertFalse(response["details"]["injected"])

    def test_set_value_and_launch_failures_count_as_mutations(self):
        with patch.object(desktop_worker.win_uia, "set_value", side_effect=RuntimeError("uia")):
            response = self.request("set_value", id=1, index=0, value="secret")
        self.assertFalse(response["details"]["result_known"])
        self.assertNotIn("secret", json.dumps(response, ensure_ascii=False))
        with patch.object(desktop_worker.win_launch, "launch", side_effect=RuntimeError("launch")):
            response = self.request("launch_app", target="notepad")
        self.assertFalse(response["details"]["result_known"])

    def test_policy_and_lookup_failures_are_known_even_though_the_op_was_about_to_mutate(self):
        win_launch = desktop_worker.win_launch
        for code, exc in (("denied", win_launch.LaunchError("denied", "拒绝")),
                          ("not_found", win_launch.LaunchError("not_found", "没有")),
                          ("launch_failed", win_launch.LaunchError("launch_failed", "启动失败"))):
            with self.subTest(code=code), patch.object(desktop_worker.win_launch, "launch", side_effect=exc):
                response = self.request("launch_app", target="x")
                self.assertEqual(response["code"], code)
                self.assertFalse(response["details"]["injected"])
                self.assertTrue(response["details"]["result_known"])
        with patch.object(desktop_worker.win_uia, "set_value", side_effect=desktop_worker.win_uia.UiaError("no_value_pattern", "不支持")):
            response = self.request("set_value", id=1, index=0, value="v")
        self.assertTrue(response["details"]["result_known"])
        self.assertFalse(response["details"]["injected"])
        # ... but a keyboard failure after something was already sent stays unknown
        self.fail_send_at = 3  # ctrl down, a down are sent; the a-up event fails
        response = self.request("press_key", key="ctrl+a")
        self.assertEqual(response["code"], "send_input_failed")
        self.assertTrue(response["details"]["injected"])
        self.assertFalse(response["details"]["result_known"])
        self.assertEqual(response["details"]["stopped_reason"], "worker_error")

    def test_bad_args_are_known_and_non_object_args_do_not_kill_the_loop(self):
        response = self.request("click")
        self.assertEqual(response["code"], "bad_args")
        self.assertTrue(response["details"]["result_known"])
        self.out.seek(0)
        self.out.truncate()
        self.worker.handle({"id": 5, "op": "click", "args": ["not", "a", "dict"]})
        self.assertTrue(self.out.getvalue())
        self.assertTrue(self.request("state")["ok"])

    def test_serve_survives_garbage_lines_and_keeps_going(self):
        stream = io.BytesIO(b"{not json\n[1,2]\n\n" +
                            json.dumps({"id": 3, "op": "state", "args": {}}).encode() + b"\n" +
                            json.dumps({"id": 4, "op": "shutdown"}).encode() + b"\n" +
                            json.dumps({"id": 5, "op": "state"}).encode() + b"\n")
        self.out.seek(0)
        self.out.truncate()
        self.worker.serve(stream)
        messages = [json.loads(line) for line in self.out.getvalue().decode("utf-8").splitlines()]
        self.assertEqual([m.get("code") for m in messages[:2]], ["bad_json", "bad_json"])
        self.assertTrue(messages[2]["ok"] and messages[2]["id"] == 3)
        self.assertEqual(messages[3]["id"], 4)
        self.assertEqual(len(messages), 4, "nothing is processed after shutdown")

    def test_stop_reason_enum_is_stable(self):
        self.assertEqual(desktop_worker.STOP_REASONS, ("user_active", "esc", "locked", "timeout", "worker_error"))


class CoordinateValidationTests(ProtocolBase):
    """Second layer behind the plugin's own range check: out-of-screen targets are refused before the worker
    waits for the owner or injects anything."""

    OPS = {
        "click": {"x": 1920, "y": 5},
        "move_mouse": {"x": 5, "y": 1080},
        "scroll": {"x": -1, "y": 5, "delta_y": 1},
        "drag_start": {"from_x": 99999, "from_y": 5, "to_x": 10, "to_y": 10},
        "drag_end": {"from_x": 10, "from_y": 10, "to_x": 10, "to_y": 5000},
    }

    def _run(self, op, args):
        return self.request("drag" if op.startswith("drag") else op, **args)

    def assert_refused_without_side_effects(self, response, stubs):
        self.assertFalse(response["ok"])
        self.assertEqual(response["code"], "out_of_screen")
        details = response["details"]
        self.assertEqual((details["injected"], details["result_known"], details["yielded"], details["waited_ms"],
                          details["stopped_reason"]), (False, True, False, 0, None))
        self.assertIn("没有发送任何输入", response["error"])
        self.assertIn("requested", details)
        self.assertEqual(details["screen"], {"left": 0, "top": 0, "right": 1920, "bottom": 1080})
        for stub in stubs:
            stub.assert_not_called()
        self.assertEqual(self.sends, [])
        self.assertEqual(self.cursor, [500, 400])

    def test_every_pointer_op_refuses_out_of_screen_targets_before_injecting(self):
        for op, args in self.OPS.items():
            with self.subTest(op=op):
                with patch.object(win_input, "click") as click, patch.object(win_input, "move_mouse") as move, \
                        patch.object(win_input, "drag") as drag, patch.object(win_input, "scroll") as scroll:
                    response = self._run(op, args)
                self.assert_refused_without_side_effects(response, [click, move, drag, scroll])
                self.assertEqual(response["generation"], 7)

    def test_validation_runs_before_waiting_for_the_owner(self):
        self.fake_input.busy_until = self.clock.t + 60  # the owner is busy: a yield would be user_active
        with patch.object(win_input, "click") as click:
            response = self.request("click", x=5000, y=5)
        click.assert_not_called()
        self.assertEqual(response["code"], "out_of_screen")
        self.assertFalse(any(e["event"] in ("user_wait", "user_activity") for e in self.events))

    def test_screen_edges_are_inside_and_one_past_is_outside(self):
        with patch.object(win_input, "click", return_value={"x": 0, "y": 0, "button": "left", "count": 1}) as click:
            for x, y in ((0, 0), (1919, 1079), (1919.4, 1078.6)):
                with self.subTest(x=x, y=y):
                    self.assertTrue(self.request("click", x=x, y=y)["ok"])
        self.assertEqual(click.call_count, 3)
        with patch.object(win_input, "click") as click:
            for x, y in ((1920, 0), (0, 1080), (-1, 0), (0, -1), (1919.6, 0)):
                with self.subTest(outside=(x, y)):
                    self.assertEqual(self.request("click", x=x, y=y)["code"], "out_of_screen")
            click.assert_not_called()

    def test_multi_monitor_virtual_screen_with_negative_origin(self):
        self.screen = (-1920, -200, 1920, 1080)
        with patch.object(win_input, "click", return_value={"x": 0, "y": 0, "button": "left", "count": 1}):
            self.assertTrue(self.request("click", x=-1920, y=-200)["ok"])
            self.assertTrue(self.request("click", x=1919, y=1079)["ok"])
        with patch.object(win_input, "click") as click:
            self.assertEqual(self.request("click", x=-1921, y=0)["code"], "out_of_screen")
            self.assertEqual(self.request("click", x=0, y=-201)["code"], "out_of_screen")
            click.assert_not_called()

    def test_non_numeric_coordinates_are_bad_args_not_injected(self):
        for bad in ("abc", None, True, float("nan"), float("inf"), [1], {"a": 1}):
            with self.subTest(bad=bad):
                with patch.object(win_input, "click") as click:
                    response = self.request("click", x=bad, y=5)
                click.assert_not_called()
                self.assertEqual(response["code"], "bad_args")
                self.assertFalse(response["details"]["injected"])
                self.assertTrue(response["details"]["result_known"])

    def test_numeric_strings_still_work_like_before(self):
        with patch.object(win_input, "click", return_value={"x": 5, "y": 6, "button": "left", "count": 1}):
            self.assertTrue(self.request("click", x="5", y="6")["ok"])

    def test_click_element_center_outside_the_screen_is_refused(self):
        rect = {"left": 3000, "top": 100, "right": 3200, "bottom": 140}
        with patch.object(desktop_worker.win_uia, "element_rect", return_value=({"type": "Button", "name": "x"}, rect)), \
                patch.object(win_input, "click") as click:
            response = self.request("click_element", id=1, index=0)
        click.assert_not_called()
        self.assertEqual(response["code"], "out_of_screen")
        self.assertFalse(response["details"]["injected"])
        self.assertEqual(self.sends, [])

    def test_inside_targets_keep_working_for_every_op(self):
        with patch.object(win_input, "click", return_value={"x": 1, "y": 1}), \
                patch.object(win_input, "move_mouse", return_value=(1, 1)), \
                patch.object(win_input, "drag", return_value={"ok": True}), \
                patch.object(win_input, "scroll", return_value={"ok": True}):
            self.assertTrue(self.request("click", x=1, y=1)["ok"])
            self.assertTrue(self.request("move_mouse", x=1, y=1)["ok"])
            self.assertTrue(self.request("drag", from_x=1, from_y=1, to_x=1919, to_y=1079)["ok"])
            self.assertTrue(self.request("scroll", x=1, y=1, delta_y=1)["ok"])

    def test_unknown_screen_size_skips_the_check_instead_of_blocking(self):
        self.screen = None
        with patch.object(win_input, "click", return_value={"x": 99999, "y": 5, "button": "left", "count": 1}):
            self.assertTrue(self.request("click", x=99999, y=5)["ok"])

    def test_hello_advertises_the_capability(self):
        self.assertTrue(self.request("hello", generation=7)["result"]["capabilities"]["coordinate_validation"])

    def test_real_virtual_screen_probe_is_sane(self):
        bounds = REAL_VIRTUAL_SCREEN()
        self.assertIsNotNone(bounds)
        left, top, right, bottom = bounds
        self.assertGreater(right - left, 100)
        self.assertGreater(bottom - top, 100)


class HelloGenerationTests(ProtocolBase):
    """The generation only moves forward inside one worker process."""

    def assert_generation(self, expected):
        self.assertEqual(self.request("state")["generation"], expected)

    def test_hello_without_generation_keeps_the_current_one(self):
        response = self.request("hello")
        self.assertTrue(response["ok"])
        self.assertEqual(response["generation"], 7)
        self.assertEqual(response["result"]["generation"], 7)
        self.assertEqual(response["result"]["generation_ignored"], {"requested": None, "kept": 7, "reason": "missing"})
        self.assert_generation(7)

    def test_zero_older_or_malformed_generations_never_lower_it(self):
        cases = [(0, "older"), (3, "older"), (-5, "older"), ("abc", "invalid"), (True, "invalid"),
                 (False, "invalid"), ([9], "invalid"), ({"g": 1}, "invalid")]
        for requested, reason in cases:
            with self.subTest(requested=requested):
                response = self.request("hello", generation=requested)
                self.assertEqual(response["generation"], 7)
                self.assertEqual(response["result"]["generation"], 7)
                self.assertEqual(response["result"]["generation_ignored"]["reason"], reason)
                self.assertEqual(response["result"]["generation_ignored"]["kept"], 7)
                self.assert_generation(7)

    def test_same_or_newer_generation_is_accepted_and_not_flagged(self):
        response = self.request("hello", generation=7)
        self.assertEqual(response["result"]["generation"], 7)
        self.assertNotIn("generation_ignored", response["result"])
        response = self.request("hello", generation=12)
        self.assertEqual(response["generation"], 12)
        self.assertEqual(response["result"]["generation"], 12)
        self.assertNotIn("generation_ignored", response["result"])
        self.assert_generation(12)
        self.assertEqual(self.request("hello", generation=11)["result"]["generation"], 12)  # lower again: refused
        self.assert_generation(12)

    def test_numeric_string_generation_still_works_like_before(self):
        self.assertEqual(self.request("hello", generation="15")["result"]["generation"], 15)

    def test_fresh_worker_takes_its_first_generation_and_stays_at_zero_without_one(self):
        fresh = DesktopWorker(Sink())
        self.assertEqual(fresh.generation, 0)
        fresh.op_hello({"generation": 1})
        self.assertEqual(fresh.generation, 1)
        other = DesktopWorker(Sink())
        result = other.op_hello({})
        self.assertEqual(other.generation, 0)
        self.assertEqual(result["generation_ignored"]["reason"], "missing")

    def test_receipts_after_an_ignored_hello_still_match_the_plugins_generation(self):
        self.request("hello")  # a stray hello without generation
        with patch.object(win_input, "click", return_value={"x": 5, "y": 6, "button": "left", "count": 1}):
            response = self.request("click", x=5, y=6)
        self.assertEqual(response["generation"], 7)
        self.assertEqual(response["result"]["generation"], 7)

    def test_a_stray_hello_does_not_change_the_autonomy_upwards(self):
        self.request("hello")  # no autonomous_control: can only restrict, never grant
        self.assertFalse(self.worker.config["autonomous_control"])
        self.request("hello", autonomous_control=True, generation=7)
        self.assertTrue(self.worker.config["autonomous_control"])


if __name__ == "__main__":
    unittest.main()
