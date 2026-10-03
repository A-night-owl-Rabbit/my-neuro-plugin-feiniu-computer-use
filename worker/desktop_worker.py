# -*- coding: utf-8 -*-
"""Feiniu computer-use worker: a long-lived process that sees and drives the Windows desktop.

Protocol (JSON Lines over stdin/stdout):
  request : {"id": 1, "op": "click", "args": {...}}
  response: {"id": 1, "ok": true, "result": {...}}
          | {"id": 1, "ok": false, "code": "...", "error": "...", "details": {...}}
  event   : {"event": "esc_pressed", ...}   (no id, pushed by the worker)

Desktop-changing ops (activate_window, move_mouse, click, click_element, drag, scroll,
type_text, press_key, set_value, launch_app) share one fact block, present in `result`
on success and in `details` on failure:
  yielded        True when the action was NOT run / stopped half way because the owner is active
  waited_ms      time spent waiting for the owner to stop
  yield_source   keyboard | mouse_button | cursor_move | system_input | None
  typed, input_total, completed   (type_text only; Unicode code points)
  foreground, cursor              environment right after the action / at the stop
  stopped_reason user_active | esc | locked | worker_error | None   ("timeout" is added by the JS side)
  result_known   False when something may have been injected but the outcome is not reliable
  injected       True when input/mutation had started before the failure
  generation     the worker generation handed in by `hello` (restart invalidation)

Run `python desktop_worker.py --selftest` for a read-only self check (no input injection).
"""
import json
import os
import sys
import threading
import time
import traceback

WORKER_DIR = os.path.dirname(os.path.abspath(__file__))
if WORKER_DIR not in sys.path:
    sys.path.insert(0, WORKER_DIR)

import win_sensors  # noqa: E402

DPI_MODE = win_sensors.enable_dpi_awareness()  # must run before anything measures the screen

import win_input  # noqa: E402
import win_launch  # noqa: E402
import win_uia  # noqa: E402
import win_windows  # noqa: E402

VERSION = "0.2.0"
PROTOCOL = 2

# Defaults keep the plugin behaving as before for everything except the new, bounded
# owner-yield / segmented typing parameters. BOUNDS clamp whatever the JS side sends.
CONFIG_DEFAULTS = {
    "autonomous_control": False,
    "esc_watch_window_ms": 15000,
    "user_activity_threshold_px": 40,
    "type_interval_ms": 8,
    "user_idle_yield": True,
    "user_idle_ms": 500,
    "user_idle_max_wait_ms": 3000,
    "type_chunk_size": 16,
    "type_chunk_gap_ms": 100,
    "self_pids": [],
}
CONFIG_BOUNDS = {
    "esc_watch_window_ms": (200, 600000),
    "user_activity_threshold_px": (1, 5000),
    "type_interval_ms": (0, 500),
    "user_idle_ms": (100, 5000),
    "user_idle_max_wait_ms": (0, 30000),
    "type_chunk_size": (1, 200),
    "type_chunk_gap_ms": (0, 1000),
}
LIVE_CONFIG_KEYS = tuple(CONFIG_BOUNDS) + ("user_idle_yield",)

# Ops that change the desktop and therefore wait for the owner and carry the fact block.
ACTION_OPS = frozenset({
    "activate_window", "move_mouse", "click", "click_element", "drag", "scroll",
    "type_text", "press_key", "set_value", "launch_app",
})

STOP_BY_CODE = {"user_active": "user_active", "aborted": "esc", "locked": "locked"}
WORKER_ERROR_CODES = frozenset({"internal", "send_input_failed", "move_failed", "move_mismatch"})
STOP_REASONS = ("user_active", "esc", "locked", "timeout", "worker_error")
# Error codes that by contract are raised before the desktop was changed (validation, policy, lookup
# failures, a failed focus/launch/cursor move). They never make a result "unknown" by themselves.
NO_SIDE_EFFECT_CODES = frozenset({
    "bad_target", "denied", "ambiguous", "not_found", "launch_failed", "bad_button", "scroll_too_far",
    "bad_key", "unsupported_key", "bad_text", "text_too_long", "stale_index", "no_rect", "no_value_pattern",
    "read_only", "uia_unavailable", "bad_args", "activate_failed", "move_failed", "move_mismatch",
    "out_of_screen",
})


class WorkerError(Exception):
    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code = code
        self.details = dict(details or {})


class ActionContext:
    """Facts collected while one desktop-changing request runs."""

    def __init__(self, op, injections_before=0):
        self.op = op
        self.injections_before = injections_before
        self.waited_ms = 0
        self.yielded = False
        self.yield_source = None
        self.mutated = False
        self.typed = None
        self.input_total = None
        self.count_exact = True   # False while keys are being sent and the exact count is not yet known


def coerce_coordinate(value, name):
    """A finite number, or a clear `bad_args` error (booleans and NaN/inf are not coordinates)."""
    if isinstance(value, bool) or value is None:
        raise WorkerError("bad_args", f"坐标参数 {name} 必须是数字")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise WorkerError("bad_args", f"坐标参数 {name} 必须是数字")
    if number != number or number in (float("inf"), float("-inf")):
        raise WorkerError("bad_args", f"坐标参数 {name} 必须是有限数字")
    return int(round(number))


def clamp_config_value(key, value):
    low, high = CONFIG_BOUNDS[key]
    return max(low, min(high, int(value)))


def _monitors():
    try:
        import mss

        with mss.MSS() as sct:
            return [
                {"index": i, "left": m["left"], "top": m["top"], "width": m["width"], "height": m["height"]}
                for i, m in enumerate(sct.monitors)
            ]
    except Exception as exc:
        return [{"error": str(exc)}]


YIELD_SOURCE_LABELS = {
    "keyboard": "键盘", "mouse_button": "鼠标按键", "cursor_move": "鼠标移动", "system_input": "键盘或鼠标",
}


class DesktopWorker:
    def __init__(self, out_stream):
        self._out = out_stream
        self._out_lock = threading.Lock()
        self.config = dict(CONFIG_DEFAULTS)
        self.config["self_pids"] = []
        self.generation = 0
        self.self_pids = set()
        self.self_exe_paths = set()
        self.last_action_at = None
        self._ctx = None
        self.cursor = win_sensors.CursorTracker()
        self.activity = win_sensors.UserActivityMonitor()
        win_input.set_injection_hook(self.activity.note_injection)
        self.esc = win_sensors.EscWatcher(self._on_esc)
        self.esc.start()

    # ------------------------------------------------------------------ output
    def emit(self, payload):
        data = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
        with self._out_lock:
            self._out.write(data)
            self._out.flush()

    def _on_esc(self):
        self.emit({"event": "esc_pressed", "at": time.time()})

    # --------------------------------------------------------------- prechecks
    def _foreground(self):
        return win_windows.foreground_info(self.self_pids, self.self_exe_paths)

    def _window(self, hwnd):
        return win_windows.window_info(hwnd, self.self_pids, self.self_exe_paths)

    def _check_abort_and_lock(self):
        if self.esc.aborted:
            raise WorkerError("aborted", "主人按了 Esc，已停止操作，等待主人重新下令")
        fg = self._foreground()
        if win_sensors.is_locked(fg["process_name"] if fg else None):
            raise WorkerError("locked", "桌面处于锁屏或安全桌面，不能操作")
        return fg

    def _cfg(self, key):
        """Config lookup that tolerates partially built workers (tests build them with __new__)."""
        config = getattr(self, "config", None) or {}
        return config.get(key, CONFIG_DEFAULTS.get(key))

    def _ctx_get(self):
        ctx = getattr(self, "_ctx", None)
        if ctx is None:
            ctx = ActionContext("")
            self._ctx = ctx
        return ctx

    def _mark_mutation(self):
        """Call right before the step that actually changes the desktop (focus, launch, value)."""
        ctx = getattr(self, "_ctx", None)
        if ctx is not None:
            ctx.mutated = True

    def _yield_to_owner(self):
        """Wait (bounded) until the owner has stopped using keyboard/mouse. Raises
        `user_active` BEFORE any input is injected when the owner does not stop in time."""
        if not self._cfg("user_idle_yield"):
            return
        ctx = self._ctx_get()
        outcome = self.activity.wait_until_idle(
            self._cfg("user_idle_ms"),
            self._cfg("user_idle_max_wait_ms"),
            on_wait=lambda snap: self.emit({
                "event": "user_wait", "source": snap.get("source"),
                "owner_idle_ms": snap.get("owner_idle_ms"),
                "max_wait_ms": self._cfg("user_idle_max_wait_ms"),
            }),
        )
        ctx.waited_ms += outcome["waited_ms"]
        if outcome["active"]:
            ctx.yielded = True
            ctx.yield_source = outcome["source"]
            self.emit({"event": "user_activity", "source": outcome["source"], "dx": 0, "dy": 0,
                       "waited_ms": ctx.waited_ms})
            raise WorkerError(
                "user_active",
                f"主人正在操作电脑（{YIELD_SOURCE_LABELS.get(outcome['source'], '输入设备')}），"
                f"已等待 {ctx.waited_ms}ms 仍未停手，本次没有发送任何输入",
            )
        if outcome["waited_ms"] > 0:
            # time passed while waiting: Esc / lock may have happened in the meantime
            self._check_abort_and_lock()

    def _check_cursor_displacement(self):
        moved, dx, dy = self.cursor.user_moved(self._cfg("user_activity_threshold_px"))
        if moved:
            ctx = self._ctx_get()
            ctx.yielded = True
            ctx.yield_source = "cursor_move"
            self.cursor.clear()
            self.emit({"event": "user_activity", "source": "cursor_move", "dx": dx, "dy": dy})
            raise WorkerError("user_active", f"主人正在使用鼠标（光标移动了 {dx},{dy}），先停一下，本次没有发送任何输入")

    def _before_input(self, check_cursor=True):
        """Single yield gate in front of every desktop-changing op: Esc/lock, wait for the
        owner to be idle, then (for input that depends on an observation) cursor displacement."""
        fg = self._check_abort_and_lock()
        self.esc.extend(self._cfg("esc_watch_window_ms"))
        self._yield_to_owner()
        if check_cursor:
            self._check_cursor_displacement()
        return fg

    def _after_input(self):
        self.esc.extend(self._cfg("esc_watch_window_ms"))
        self.cursor.mark()
        self.last_action_at = time.time()

    def _midway_stop(self, typed=0):
        """Checkpoint between typing chunks: returns None to continue or a dict that stops typing."""
        if self.esc.aborted:
            return {"code": "aborted", "reason": "esc", "message": "主人按了 Esc，已停止后续输入"}
        fg = self._foreground()
        if win_sensors.is_locked(fg["process_name"] if fg else None):
            return {"code": "locked", "reason": "locked", "message": "桌面进入锁屏或安全桌面，已停止后续输入"}
        self.esc.extend(self._cfg("esc_watch_window_ms"))
        if self._cfg("user_idle_yield"):
            snap = self.activity.snapshot(self._cfg("user_idle_ms"))
            if snap["active"]:
                return {"code": "user_active", "reason": "user_active", "source": snap["source"],
                        "message": f"主人开始操作（{YIELD_SOURCE_LABELS.get(snap['source'], '输入设备')}），已停止后续输入"}
        moved, dx, dy = self.cursor.user_moved(self._cfg("user_activity_threshold_px"))
        if moved:
            self.cursor.clear()
            return {"code": "user_active", "reason": "user_active", "source": "cursor_move", "dx": dx, "dy": dy,
                    "message": f"主人移动了鼠标（{dx},{dy}），已停止后续输入"}
        return None

    # -------------------------------------------------------------- fact block
    def _env_snapshot(self):
        env = {"foreground": None, "cursor": None}
        try:
            env["foreground"] = self._foreground()
        except Exception:
            pass
        try:
            pos = win_sensors.cursor_position()
            env["cursor"] = {"x": pos[0], "y": pos[1]} if pos else None
        except Exception:
            pass
        return env

    def _facts(self, ctx, injected):
        facts = {
            "yielded": bool(ctx.yielded),
            "waited_ms": int(ctx.waited_ms),
            "yield_source": ctx.yield_source,
            "injected": bool(injected),
            "generation": self.generation,
        }
        if ctx.input_total is not None:
            facts["input_total"] = ctx.input_total
        if ctx.typed is not None:
            # a lower bound (fully completed characters) when an error hit mid-typing
            facts["typed"] = ctx.typed
            facts["typed_exact"] = bool(ctx.count_exact)
        return facts

    def _injected(self, ctx, code=None):
        sent = self.activity.injections > ctx.injections_before
        if code in NO_SIDE_EFFECT_CODES:
            return sent
        return sent or ctx.mutated

    def _decorate_ok(self, op, result, ctx):
        if not isinstance(result, dict):
            return result
        facts = self._facts(ctx, self._injected(ctx))
        facts.update(self._env_snapshot())
        facts["stopped_reason"] = None
        facts["result_known"] = True
        for key, value in facts.items():
            if key in ("foreground",) and result.get(key) is not None:
                continue  # the op already attached a (fresher) foreground
            result[key] = value
        return result

    def _failure_details(self, op, code, exc_details, ctx):
        injected = self._injected(ctx, code)
        details = self._facts(ctx, injected)
        details.update(self._env_snapshot())
        if code in STOP_BY_CODE:
            details["stopped_reason"] = STOP_BY_CODE[code]
        elif code in WORKER_ERROR_CODES:
            details["stopped_reason"] = "worker_error"
        else:
            details["stopped_reason"] = None
        # Known when nothing was injected, or when the exact amount typed is known.
        details["result_known"] = (not injected) or (ctx.typed is not None and ctx.count_exact)
        details.update(exc_details or {})
        return details

    # -------------------------------------------------------------------- ops
    def _apply_live_config(self, args):
        """Bounded, non-security tunables; shared by `hello` and the hot `configure` op."""
        for key in CONFIG_BOUNDS:
            if key in args:
                try:
                    self.config[key] = clamp_config_value(key, args[key])
                except (TypeError, ValueError):
                    pass
        if "user_idle_yield" in args:
            value = args["user_idle_yield"]
            self.config["user_idle_yield"] = value is True or (isinstance(value, str) and value.lower() in ("true", "1", "yes", "on"))

    def _validate_points(self, *pairs):
        """Second line of defence behind the plugin's own range check: refuse any pointer target outside
        the virtual screen BEFORE waiting for the owner or injecting anything. (SetCursorPos would otherwise
        clamp it to a screen edge and click whatever sits in that corner.)"""
        points = []
        for label, x, y in pairs:
            points.append((label, coerce_coordinate(x, f"{label}x"), coerce_coordinate(y, f"{label}y")))
        bounds = win_sensors.virtual_screen()
        if bounds is None:
            return points
        left, top, right, bottom = bounds
        for label, x, y in points:
            if not (left <= x < right and top <= y < bottom):
                raise WorkerError(
                    "out_of_screen",
                    f"{label or '坐标'}({x},{y}) 不在屏幕范围 x∈[{left},{right - 1}] y∈[{top},{bottom - 1}] 内，已拒绝，没有发送任何输入",
                    {"requested": {"x": x, "y": y}, "screen": {"left": left, "top": top, "right": right, "bottom": bottom}},
                )
        return points

    def op_configure(self, args):
        """Hot-update yield / typing parameters without restarting the worker.
        `autonomous_control` and self-process identity can only be set by `hello`."""
        self._apply_live_config(args)
        return {"config": {k: self.config.get(k) for k in LIVE_CONFIG_KEYS}, "generation": self.generation}

    def op_hello(self, args):
        self.config["autonomous_control"] = args.get("autonomous_control") is True
        # The generation only ever moves forward within one worker process: a missing, malformed, zero or older
        # value must not reset it (that would make every later receipt look stale to the plugin).
        requested = args.get("generation")
        ignored = None
        try:
            if isinstance(requested, bool) or requested is None:
                raise ValueError("missing")
            new_generation = int(requested)
        except (TypeError, ValueError):
            new_generation = None
            ignored = "missing" if requested is None else "invalid"
        if new_generation is not None:
            if new_generation >= self.generation:
                self.generation = new_generation
            else:
                ignored = "older"
        generation_ignored = {"requested": requested, "kept": self.generation, "reason": ignored} if ignored else None
        self._apply_live_config(args)
        pids = args.get("self_pids") or []
        self.self_pids = {int(p) for p in pids if str(p).isdigit()}
        self.self_exe_paths = {str(p).lower() for p in (args.get("self_exe_paths") or []) if p}
        dpi = win_sensors.system_dpi()
        result = {
            "version": VERSION,
            "protocol": PROTOCOL,
            "generation": self.generation,
            "capabilities": {
                "user_idle_yield": True,
                "segmented_typing": True,
                "clipboard_typing_segmented": False,
                "coordinate_validation": True,
                "fact_block": sorted(ACTION_OPS),
                "stop_reasons": list(STOP_REASONS),
            },
            "python": sys.executable,
            "pid": os.getpid(),
            "dpi_awareness": DPI_MODE,
            "dpi": dpi,
            "scale": round(dpi / 96.0, 3),
            "uia_available": win_uia.UIA_AVAILABLE,
            "uia_error": win_uia.UIA_ERROR,
            "monitors": _monitors(),
            "config": self.config,
            "self_pids": sorted(self.self_pids),
            "self_exe_paths": sorted(self.self_exe_paths),
        }
        if generation_ignored:
            result["generation_ignored"] = generation_ignored
        return result

    def op_new_turn(self, args):
        self.esc.reset()
        self.cursor.clear()
        return {"ok": True, "generation": self.generation}

    op_reset_abort = op_new_turn

    def op_state(self, args):
        fg = self._foreground()
        return {
            "aborted": self.esc.aborted,
            "aborted_at": self.esc.aborted_at,
            "esc_watching": self.esc.watching(),
            "is_locked": win_sensors.is_locked(fg["process_name"] if fg else None),
            "foreground": fg,
            "cursor": win_sensors.cursor_position(),
            "last_action_at": self.last_action_at,
            "generation": self.generation,
            "activity": self.activity.snapshot(self._cfg("user_idle_ms")),
            "yield_config": {k: self.config.get(k) for k in LIVE_CONFIG_KEYS},
        }

    def op_list_windows(self, args):
        return {"windows": win_windows.list_windows(
            args.get("filter", ""), self.self_pids, bool(args.get("include_self")), self.self_exe_paths
        )}

    def op_window_info(self, args):
        info = self._window(args["id"])
        if info is None:
            raise WorkerError("not_found", "窗口已不存在")
        return info

    def op_foreground(self, args):
        return self._foreground()

    def op_activate_window(self, args):
        self._before_input(check_cursor=False)
        self._mark_mutation()
        result = win_windows.activate_window(args["id"])
        if not result.get("ok"):
            raise WorkerError(result.get("code", "activate_failed"), result.get("error", "激活失败"))
        self.esc.extend(self._cfg("esc_watch_window_ms"))
        result["window"] = self._window(args["id"])
        return result

    def op_move_mouse(self, args):
        self._validate_points(("", args["x"], args["y"]))
        self._before_input(check_cursor=False)
        self._mark_mutation()
        pos = win_input.move_mouse(args["x"], args["y"])
        self.cursor.mark()
        return {"x": pos[0], "y": pos[1]}

    def op_click(self, args):
        self._validate_points(("", args["x"], args["y"]))
        self._before_input()
        result = win_input.click(args["x"], args["y"], args.get("button", "left"), args.get("count", 1))
        self._after_input()
        time.sleep(0.05)
        result["foreground"] = self._foreground()
        return result

    def op_click_element(self, args):
        self._before_input()
        element, rect = win_uia.element_rect(args["id"], args["index"])
        cx = (rect["left"] + rect["right"]) // 2
        cy = (rect["top"] + rect["bottom"]) // 2
        self._validate_points(("元素中心", cx, cy))
        result = win_input.click(cx, cy, args.get("button", "left"), args.get("count", 1))
        self._after_input()
        result["element"] = {"index": int(args["index"]), "type": element.get("type"), "name": element.get("name")}
        result["foreground"] = self._foreground()
        return result

    def op_drag(self, args):
        self._validate_points(("起点", args["from_x"], args["from_y"]), ("终点", args["to_x"], args["to_y"]))
        self._before_input()
        result = win_input.drag(
            args["from_x"], args["from_y"], args["to_x"], args["to_y"],
            args.get("duration_ms", 500), args.get("button", "left")
        )
        self._after_input()
        return result

    def op_scroll(self, args):
        self._validate_points(("", args["x"], args["y"]))
        self._before_input()
        result = win_input.scroll(args["x"], args["y"], args.get("delta_y", 0), args.get("delta_x", 0))
        self._after_input()
        return result

    def op_type_text(self, args):
        text = str(args.get("text", ""))
        if len(text) > 5000:
            raise WorkerError("text_too_long", "单次输入不能超过 5000 字")
        win_input.validate_text(text)  # reject control characters before waiting or typing anything
        ctx = self._ctx_get()
        ctx.input_total = len(text)
        ctx.typed = 0  # nothing sent yet: exact
        self._before_input()
        mode = args.get("mode") or "sendinput"
        ctx.count_exact = False  # keys are about to go out; exact again once type_text reports
        result = win_input.type_text(
            text, mode=mode,
            interval_ms=args.get("interval_ms", self._cfg("type_interval_ms")),
            chunk_size=clamp_config_value("type_chunk_size", args.get("chunk_size", self._cfg("type_chunk_size"))),
            chunk_gap_ms=clamp_config_value("type_chunk_gap_ms", args.get("chunk_gap_ms", self._cfg("type_chunk_gap_ms"))),
            checkpoint=self._midway_stop,
        )
        ctx.typed = result["typed"]
        ctx.input_total = result.get("input_total", len(text))
        ctx.count_exact = True
        self._after_input()
        stop = result.pop("stop", None)
        if stop:
            ctx.yielded = stop.get("reason") == "user_active"
            ctx.yield_source = stop.get("source")
            if stop.get("code") == "user_active":
                self.emit({"event": "user_activity", "source": stop.get("source"),
                           "dx": stop.get("dx", 0), "dy": stop.get("dy", 0), "typed": ctx.typed})
            raise WorkerError(stop["code"], f"{stop['message']}（已输入 {ctx.typed}/{ctx.input_total} 字）",
                              {"completed": False, "segmented": result.get("segmented"), "mode": result.get("mode"),
                               "chunks_sent": result.get("chunks_sent"), "chunks_total": result.get("chunks_total")})
        result["foreground"] = self._foreground()
        return result

    def op_press_key(self, args):
        autonomous = self.config["autonomous_control"]
        modifiers, key = win_input.parse_chord(args.get("key"), autonomous_control=autonomous)
        self._before_input()
        if key == "esc":
            self.esc.suppress(400)
        result = win_input.press_key(args.get("key"), args.get("repeat", 1), autonomous_control=autonomous)
        self._after_input()
        result["foreground"] = self._foreground()
        return result

    def op_ui_tree(self, args):
        return win_uia.ui_tree(
            args["id"],
            depth=int(args.get("depth", 3)),
            max_children=int(args.get("max_children", 25)),
            max_elements=int(args.get("max_elements", 150)),
            time_budget_ms=int(args.get("time_budget_ms", 4000)),
            doc_max_chars=int(args.get("doc_max_chars", 2000)),
        )

    def op_focused(self, args):
        return win_uia.focused_summary(int(args.get("doc_max_chars", 2000)))

    def op_set_value(self, args):
        self._before_input()
        self._mark_mutation()
        result = win_uia.set_value(args["id"], args["index"], args.get("value", ""))
        self._after_input()
        return result

    def op_launch_app(self, args):
        self._before_input(check_cursor=False)
        self._mark_mutation()
        result = win_launch.launch(
            args.get("target"), int(args.get("wait_ms", 6000)), self.self_pids, self.self_exe_paths,
            autonomous_control=self.config["autonomous_control"]
        )
        self._after_input()
        return result

    def op_resolve_app(self, args):
        return win_launch.resolve(args.get("target"), autonomous_control=self.config["autonomous_control"])

    def op_cursor(self, args):
        pos = win_sensors.cursor_position()
        return {"x": pos[0], "y": pos[1]} if pos else None

    def op_shutdown(self, args):
        self.esc.stop()
        return {"bye": True}

    # ------------------------------------------------------------------- loop
    def _respond_error(self, req_id, op, code, message, exc_details=None):
        payload = {"id": req_id, "ok": False, "code": code, "error": message, "generation": self.generation}
        if op in ACTION_OPS:
            try:
                payload["details"] = self._failure_details(op, code, exc_details, self._ctx_get())
            except Exception:  # never let fact collection take the loop down
                traceback.print_exc(file=sys.stderr)
        elif exc_details:
            payload["details"] = dict(exc_details)
        self.emit(payload)

    def handle(self, request):
        req_id = request.get("id")
        op = str(request.get("op") or "")
        args = request.get("args") or {}
        handler = getattr(self, f"op_{op}", None)
        if handler is None:
            self.emit({"id": req_id, "ok": False, "code": "unknown_op", "error": f"未知操作: {op}", "generation": self.generation})
            return op
        self._ctx = ActionContext(op, self.activity.injections)
        try:
            result = handler(args)
            if op in ACTION_OPS:
                try:
                    result = self._decorate_ok(op, result, self._ctx)
                except Exception:  # a finished action must never be reported as failed because of the fact block
                    traceback.print_exc(file=sys.stderr)
            self.emit({"id": req_id, "ok": True, "result": result, "generation": self.generation})
        except WorkerError as exc:
            self._respond_error(req_id, op, exc.code, str(exc), exc.details)
        except (win_input.InputError, win_uia.UiaError, win_launch.LaunchError) as exc:
            extra = {}
            typed = getattr(exc, "typed", None)
            if typed is not None:
                self._ctx.typed = typed
                self._ctx.input_total = getattr(exc, "input_total", self._ctx.input_total)
                self._ctx.count_exact = False  # one character may have been half sent when SendInput failed
                extra["completed"] = False
            self._respond_error(req_id, op, getattr(exc, "code", "error"), str(exc), extra)
        except KeyError as exc:
            self._respond_error(req_id, op, "bad_args", f"缺少参数 {exc}")
        except Exception as exc:  # keep the worker alive on unexpected errors
            traceback.print_exc(file=sys.stderr)
            self._respond_error(req_id, op, "internal", f"{type(exc).__name__}: {exc}")
        finally:
            self._ctx = None
        return op

    def serve(self, in_stream):
        for raw in in_stream:
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            try:
                request = json.loads(line)
            except json.JSONDecodeError as exc:
                self.emit({"id": None, "ok": False, "code": "bad_json", "error": str(exc), "generation": self.generation})
                continue
            if not isinstance(request, dict):
                self.emit({"id": None, "ok": False, "code": "bad_json", "error": "请求必须是 JSON 对象", "generation": self.generation})
                continue
            if self.handle(request) == "shutdown":
                break


def selftest():
    print(f"desktop_worker {VERSION} selftest (read-only, no input injection)")
    print(f"python: {sys.executable}")
    print(f"dpi awareness: {DPI_MODE}, system dpi: {win_sensors.system_dpi()}")
    print(f"uiautomation available: {win_uia.UIA_AVAILABLE} {win_uia.UIA_ERROR}")
    print(f"monitors: {_monitors()}")
    print(f"input desktop: {win_sensors.input_desktop_name()} locked={win_sensors.is_locked()}")
    print(f"cursor: {win_sensors.cursor_position()}")
    windows = win_windows.list_windows()
    print(f"windows: {len(windows)}")
    for w in windows[:10]:
        print(f"  [{w['id']}] {w['process_name']:<24} fg={int(w['is_foreground'])} min={int(w['is_minimized'])} {w['title'][:60]}")
    fg = win_windows.foreground_info()
    if fg and win_uia.UIA_AVAILABLE:
        started = time.time()
        tree = win_uia.ui_tree(fg["id"], depth=2, max_children=15, max_elements=60)
        print(f"foreground ui tree: {tree['element_count']} elements in {int((time.time() - started) * 1000)}ms "
              f"(truncated={tree['truncated']})")
        for el in tree["elements"][:15]:
            print(f"  [{el['index']}] {'  ' * el['depth']}{el['type']} {el['name'][:40]!r} {el['rect']}")
        print(f"focused: {tree['focused_element']}")
        print(f"document_text: {tree['document_text'][:80]!r}")
    try:
        print(f"resolve notepad -> {win_launch.resolve('记事本')}")
    except Exception as exc:
        print(f"resolve notepad failed: {exc}")
    try:
        win_input.parse_chord("win+d")
        print("DENY CHECK FAILED: win+d was accepted")
    except win_input.InputError as exc:
        print(f"deny check ok: win+d -> {exc.code}")
    print("selftest done")


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    if "--selftest" in sys.argv:
        selftest()
        return
    out = sys.stdout.buffer
    sys.stdout = sys.stderr  # anything that prints must not pollute the JSON channel
    worker = DesktopWorker(out)
    try:
        worker.serve(sys.stdin.buffer)
    except KeyboardInterrupt:
        pass
    finally:
        worker.esc.stop()


if __name__ == "__main__":
    main()
