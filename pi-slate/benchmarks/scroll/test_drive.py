from contextlib import redirect_stdout
from io import StringIO
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import drive
from drive import WHEEL_EVENTS, WHEEL_LINES, validate_burst


def snapshot(top, up=0, down=0, bottom=1000, revision=1):
    return {"scrollTop": top, "maxScrollTop": bottom, "scrollRangeRevision": revision,
            "wheelLines": {"wheel_up": up, "wheel_down": down}}


class WheelAccountingTest(unittest.TestCase):
    def test_both_bursts_can_lose_lines_even_when_transcript_returns_to_bottom(self):
        partial = WHEEL_EVENTS * WHEEL_LINES - 4
        initial = snapshot(1000)
        turned = snapshot(1000 - partial, up=partial)
        final = snapshot(1000, up=partial, down=partial)
        up = validate_burst("wheel_up", initial, turned, True)
        down = validate_burst("wheel_down", turned, final, True)
        self.assertEqual(up["dropped_lines"], 4)
        self.assertEqual(down["dropped_lines"], 4)
        self.assertEqual(down["viewport_displacement_lines"], partial)
        for direction, before, after in (("wheel_up", initial, turned), ("wheel_down", turned, final)):
            with self.subTest(direction=direction), self.assertRaisesRegex(RuntimeError, "4 wheel lines lost"):
                validate_burst(direction, before, after, False)

    def test_lines_received_at_bottom_are_not_dropped(self):
        distance = WHEEL_EVENTS * WHEEL_LINES
        before = snapshot(1000 - (distance - 4), up=distance - 4)
        after = snapshot(1000, up=distance - 4, down=distance)
        down = validate_burst("wheel_down", before, after, False)
        self.assertEqual(down["dropped_lines"], 0)
        self.assertEqual(down["viewport_displacement_lines"], distance - 4)

    def test_range_changes_fail_even_with_overload_allowed(self):
        before = snapshot(1000)
        for after in (snapshot(601, bottom=1001, revision=2), snapshot(600, revision=3)):
            with self.subTest(after=after), self.assertRaisesRegex(RuntimeError, "scroll range changed during the burst"):
                validate_burst("wheel_up", before, after, True)


class CompareTest(unittest.TestCase):
    def test_rejects_matching_older_reports_before_rendering_new_columns(self):
        steady = {**drive.metrics((0, 1, 1.0, 0.0, 0), []), "dropped_wheel_lines": 0}
        case = {"terminal": "120x40", "variant": "native", "history": "native-unlimited",
                "median": {"startup": {"wall_s": 1, "cpu_s": 0, "tty_bytes": 0},
                           **dict.fromkeys(drive.SCENARIOS[1:], steady)}}
        old_report = {"format": drive.FORMAT, "workload": {"readiness_revision": 3}, "platform": {},
                      "pi_version": "1.6.0", "slate_version": "0.3.0", "slate_git_sha": "fixture",
                      "cases": [case]}
        with tempfile.TemporaryDirectory() as tmp, redirect_stdout(StringIO()):
            old, new = (Path(tmp) / name for name in ("old.json", "new.json"))
            for path in (old, new):
                path.write_text(json.dumps(old_report), encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "readiness revisions 3 and 3; rerun both workloads"):
                drive.compare(old, new)


@unittest.skipUnless(os.environ.get("SLATE_BENCH_TEST_PTY") == "1", "requires a real Pi 1.6 PTY; set SLATE_BENCH_TEST_PTY=1")
class PtyWheelAccountingTest(unittest.TestCase):
    def test_pi_receives_396_lines_each_way(self):
        sent = {64: 0, 65: 0}
        wheel = drive.Terminal.wheel

        def omit_first_four(term, button):
            sent[button] += 1
            if sent[button] > 4:
                wheel(term, button)

        args = SimpleNamespace(size="small", entries=None, seed=42, runs=1, variants=["native"], terminals=["120x40"],
                               startup_timeout=30, readiness_timeout=30, capture=False, stacks=False,
                               cpu_prof=False, allow_dropped_input=True)
        with tempfile.TemporaryDirectory() as tmp, patch.object(drive, "RESULTS", Path(tmp)), \
                patch.object(drive.Terminal, "wheel", omit_first_four):
            drive.suite(args)
            result, = Path(tmp).glob("*/results.json")
            run = json.loads(result.read_text())["cases"][0]["runs"][0]
        self.assertEqual(sent, {64: WHEEL_EVENTS, 65: WHEEL_EVENTS})
        for direction in ("wheel_up", "wheel_down"):
            with self.subTest(direction=direction):
                self.assertEqual(run[direction]["dropped_wheel_lines"], 4)
                self.assertEqual(run[direction]["viewport_displacement_lines"], 396)
        wheel_validation = run["validation"]["wheel"]
        self.assertEqual(wheel_validation["wheel_up"]["before"], wheel_validation["wheel_down"]["after"])


if __name__ == "__main__":
    unittest.main()
