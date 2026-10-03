# -*- coding: utf-8 -*-
"""Autonomy regressions. Input injection and process launches are mocked; no desktop actions."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "worker"))
import win_input
import win_launch
from desktop_worker import DesktopWorker


class WorkerAutonomyTests(unittest.TestCase):
    def test_windows_keys_and_system_shortcuts(self):
        for chord in ["win", "lwin+e", "rwin", "meta+tab", "win+r", "ctrl+shift+esc"]:
            with self.subTest(chord=chord):
                win_input.parse_chord(chord, autonomous_control=True)
                with self.assertRaises(win_input.InputError):
                    win_input.parse_chord(chord, autonomous_control=False)
        with self.assertRaises(win_input.InputError) as error:
            win_input.parse_chord("ctrl+alt+delete", autonomous_control=True)
        self.assertEqual(error.exception.code, "unsupported_key")

    def test_win_key_emits_down_and_up_with_supported_virtual_keys(self):
        with patch.object(win_input, "_send") as send, \
                patch.object(win_input, "_vk_events", side_effect=lambda vk, keyup=False: (vk, keyup)), \
                patch.object(win_input.time, "sleep"):
            win_input.press_key("win+r", autonomous_control=True)
        self.assertEqual([call.args[0] for call in send.call_args_list],
                         [(0x5B, False), (ord("R"), False), (ord("R"), True), (0x5B, True)])
        self.assertIn(0x5B, win_input.EXTENDED_VKS)
        self.assertIn(0x5C, win_input.EXTENDED_VKS)

    def test_terminal_resolution_and_launch_no_longer_denied(self):
        with patch.object(win_launch, "resolve_executable", return_value=r"C:\Windows\System32\cmd.exe"):
            self.assertEqual(win_launch.resolve("cmd", autonomous_control=True)["exe_name"], "cmd.exe")
            with self.assertRaises(win_launch.LaunchError):
                win_launch.resolve("cmd", autonomous_control=False)
        resolved = {"kind": "alias", "path": r"C:\Windows\System32\cmd.exe", "exe_name": "cmd.exe"}
        new_window = {"id": 55, "process_name": "cmd.exe"}
        with patch.object(win_launch, "resolve", return_value=resolved), \
                patch.object(win_launch.win_windows, "list_windows", side_effect=[[], [new_window]]), \
                patch.object(win_launch.subprocess, "Popen") as launch, \
                patch.object(win_launch.time, "sleep"):
            result = win_launch.launch("cmd", autonomous_control=True)
        self.assertEqual(result["new_windows"], [new_window])
        self.assertEqual(launch.call_args.args[0], [resolved["path"]])
        self.assertIs(launch.call_args.kwargs["shell"], False)
        self.assertEqual(launch.call_args.kwargs["creationflags"], win_launch.subprocess.CREATE_NEW_CONSOLE)
        with patch.object(win_launch, "resolve", return_value=resolved), \
                patch.object(win_launch.subprocess, "Popen") as launch:
            with self.assertRaises(win_launch.LaunchError):
                win_launch.launch("cmd", autonomous_control=False)
            launch.assert_not_called()

    def test_worker_passes_negotiated_mode_to_keys_resolve_and_launch(self):
        # Avoid constructing the live Esc listener or touching foreground windows.
        worker = DesktopWorker.__new__(DesktopWorker)
        worker.config = {"autonomous_control": True, "esc_watch_window_ms": 15000}
        worker.self_pids = set()
        worker.self_exe_paths = set()
        from unittest.mock import Mock
        worker.esc = Mock()
        worker._before_input = Mock()
        worker._after_input = Mock()
        worker._foreground = Mock(return_value=None)
        worker._check_abort_and_lock = Mock()
        with patch.object(win_input, "press_key", return_value={}) as press:
            worker.op_press_key({"key": "win+r"})
            self.assertIs(press.call_args.kwargs["autonomous_control"], True)
        with patch.object(win_launch, "resolve", return_value={}) as resolve:
            worker.op_resolve_app({"target": "cmd"})
            self.assertIs(resolve.call_args.kwargs["autonomous_control"], True)
        with patch.object(win_launch, "launch", return_value={}) as launch:
            worker.op_launch_app({"target": "cmd"})
            self.assertIs(launch.call_args.kwargs["autonomous_control"], True)
        worker.config["autonomous_control"] = False
        with patch.object(win_input, "press_key") as press:
            with self.assertRaises(win_input.InputError):
                worker.op_press_key({"key": "win+r"})
            press.assert_not_called()


if __name__ == "__main__":
    unittest.main()
