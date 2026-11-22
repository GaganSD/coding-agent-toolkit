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

    def test_busy_delivery_is_counted_when_streaming_changes_the_range(self):
        distance = WHEEL_EVENTS * WHEEL_LINES
        before = snapshot(950)
        after = snapshot(1010, down=distance - 1, bottom=1010, revision=2)
        burst = validate_burst("wheel_down", before, after, True, busy=True)
        self.assertEqual(burst["dropped_lines"], 1)
        self.assertEqual(burst["viewport_displacement_lines"], 60)
        self.assertEqual(burst["max_scroll_top"], 1000)
        self.assertEqual(burst["max_scroll_top_after"], 1010)
        with self.assertRaisesRegex(RuntimeError, "1 wheel lines lost"):
            validate_burst("wheel_down", before, after, False, busy=True)


class VariantConfigTest(unittest.TestCase):
    def test_slate_controls_select_surfaces_and_history_window(self):
        self.assertCountEqual(drive.VARIANTS["slate"], drive.SURFACES)
        self.assertIsNone(drive.MESSAGE_LENGTH["slate"], "use Slate's default transcript window")
        self.assertCountEqual(drive.VARIANTS["slate-no-toolcards"], ["header", "footer", "editor", "sidebar"])
        self.assertIsNone(drive.MESSAGE_LENGTH["slate-no-toolcards"])
        self.assertEqual(drive.MESSAGE_LENGTH["slate-matched-history"], "all")
        self.assertCountEqual(drive.VARIANTS["slate-0.4.0"], drive.SURFACES)
        self.assertIsNone(drive.MESSAGE_LENGTH.get("slate-0.4.0"))

    def test_extension_paths_distinguish_builds_in_one_suite(self):
        variants = ["native", "slate", "slate-0.4.0", "starline"]
        with tempfile.TemporaryDirectory() as tmp:
            release, starline = (Path(tmp).resolve() / name for name in ("release", "starline"))
            release.mkdir()
            starline.mkdir()
            self.assertEqual(drive.extension_paths(variants, [("starline", starline), ("slate-0.4.0", release)]),
                             {"native": None, "slate": drive.SLATE, "slate-0.4.0": release, "starline": starline})
            for overrides in ([("native", starline)], [("starline", starline), ("starline", starline)]):
                with self.subTest(overrides=overrides), self.assertRaisesRegex(RuntimeError, "unique selected non-native"):
                    drive.extension_paths(variants, overrides)
            with self.assertRaisesRegex(RuntimeError, "starline requires --extension-path"):
                drive.extension_paths(["starline"], [])
            with self.assertRaisesRegex(RuntimeError, "Extension directory for starline not found"):
                drive.extension_paths(["starline"], [("starline", starline / "missing")])
        self.assertNotIn("starline", drive.DEFAULT_VARIANTS)
        self.assertNotIn("slate-0.4.0", drive.DEFAULT_VARIANTS)

    def test_starline_requires_its_editor_and_native_scroll_view_without_slate(self):
        status = {**snapshot(1000), "surfaces": {}, "starlineEditor": True, "chat_adapter": False}
        drive.attest(status, "starline", [], False)
        with self.assertRaisesRegex(RuntimeError, "PolishedEditor was not mounted"):
            drive.attest({**status, "starlineEditor": False}, "starline", [], False)
        with self.assertRaisesRegex(RuntimeError, "primary transcript ScrollView was not found"):
            drive.attest({**status, "scrollTop": None}, "starline", [], False)
        with self.assertRaisesRegex(RuntimeError, "unexpected.*editor"):
            drive.attest({**status, "surfaces": {"editor": True}}, "starline", [], False)

    def test_chat_adapter_does_not_imply_a_transcript_window(self):
        fresh = SimpleNamespace(slate_fresh=True)
        shipped = SimpleNamespace(slate_fresh=False)
        status = {**snapshot(1000), "surfaces": {"editor": True, "tool-cards": True},
                  "starlineEditor": False, "chat_adapter": True}
        for variant in ("slate", "slate-0.4.0", "slate-main-before"):
            with self.subTest(variant=variant):
                self.assertTrue(drive.uses_fresh_slate(variant, fresh))
                surfaces = drive.visible_surfaces(variant, fresh)
                self.assertCountEqual(surfaces, ["editor", "tool-cards"])
                drive.attest(status, variant, surfaces, True)
                with self.assertRaisesRegex(RuntimeError, "Expected chat_adapter=True"):
                    drive.attest({**status, "chat_adapter": False}, variant, surfaces, True)
                self.assertEqual(drive.transcript_config(variant, fresh), {"owned": False, "limit": "all"})
                self.assertEqual(drive.transcript_config(variant, shipped), {"owned": True, "limit": "shipped-default"})
        self.assertEqual(drive.transcript_config("slate-matched-history", fresh), {"owned": True, "limit": "all"})
        self.assertFalse(drive.uses_fresh_slate("starline", fresh))


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

        args = SimpleNamespace(size="small", entries=None, seed=42, runs=1, scenario="idle", variants=["native"], terminals=["120x40"],
                               startup_timeout=30, readiness_timeout=30, capture=False, stacks=False,
                               cpu_prof=False, allow_dropped_input=True, extension_path=[], slate_fresh=False)
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
