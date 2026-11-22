#!/usr/bin/env python3
"""Drive real fullscreen Pi in a PTY, using only the Python standard library."""
import argparse
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timezone
import errno
from hashlib import sha256
import json
import math
import os
from pathlib import Path
import platform
import select
import shutil
import signal
import statistics
import struct
import subprocess
import sys
import tempfile
import time

if os.name == "posix":
    import fcntl
    import pty
    import termios

HERE = Path(__file__).resolve().parent
SLATE = HERE.parent.parent
RESULTS = HERE.parent / "results"
SURFACES = ["header", "footer", "editor", "sidebar", "tool-cards", "transcript"]
VARIANTS = {
    "native": [], "slate": SURFACES,
    "slate-no-sidebar": [s for s in SURFACES if s != "sidebar"],
    "slate-no-toolcards": [s for s in SURFACES if s not in ("tool-cards", "transcript")],
    "slate-matched-history": SURFACES,
}
DEFAULT_VARIANTS = tuple(VARIANTS)
EXTERNAL_VARIANTS = {"slate-0.4.0": SURFACES, "slate-main-before": SURFACES, "starline": []}
VARIANTS.update(EXTERNAL_VARIANTS)
FRESH_SLATE_VARIANTS = {"slate", "slate-0.4.0", "slate-main-before"}
# Keep the workload fingerprint comparable with reports before the opt-in variants.
MESSAGE_LENGTH = {variant: ("all" if variant == "slate-matched-history" else None) for variant in DEFAULT_VARIANTS}
HISTORY = {variant: ("matched-history" if MESSAGE_LENGTH.get(variant) == "all" else
                     "shipped-default" if "transcript" in surfaces else "native-unlimited")
           for variant, surfaces in VARIANTS.items()}
TERMINALS = {"200x50": (200, 50), "120x40": (120, 40)}
SIZES = {"small": 200, "medium": 1000, "large": 3000}
SCENARIOS = ["startup", "idle", "wheel_up", "wheel_down"]
WHEEL_EVENTS, WHEEL_INTERVAL, WHEEL_SETTLE, IDLE_SECONDS = 400, 0.005, 1.0, 5.0
WHEEL_LINES, QUIET_MS = 1, 750
WHEEL_WRITE_TIMEOUT = 15.0
READY = b"Synthetic scroll benchmark ready"
MOUSE = b"\x1b[?1006h"
BEGIN_PAINT, END_PAINT = b"\x1b[?2026h", b"\x1b[?2026l"
FORMAT = 2
READINESS_REVISION = 4  # Count wheel lines delivered to Pi instead of inferring drops from displacement.


def clock_ms():
    # Same clock/resolution as Date.now() in the probe; duration clocks are monotonic.
    return time.time_ns() // 1_000_000


def command(args, **kwargs):
    return subprocess.check_output(args, text=True, timeout=30, **kwargs).strip()


def find_cli():
    if os.environ.get("PI_CLI"):
        cli = Path(os.environ["PI_CLI"]).expanduser().resolve()
    else:
        cli = (Path(command(["npm", "root", "-g"])) /
               "@earendil-works/pi-coding-agent/dist/bundle/cli.js")
    if not cli.is_file():
        raise RuntimeError(f"Pi CLI not found at {cli}; set PI_CLI to Pi 1.6's cli.js")
    return cli


def isolated_path():
    roots = [Path.home() / ".pi/agent"]
    if os.environ.get("PI_CODING_AGENT_DIR"):
        roots.append(Path(os.environ["PI_CODING_AGENT_DIR"]).expanduser().absolute())
    roots += [root.resolve() for root in roots]
    paths = []
    for entry in os.environ.get("PATH", os.defpath).split(os.pathsep):
        if not entry or not os.path.isabs(entry):
            continue  # No cwd-relative executables in a temporary workspace.
        path = Path(entry)
        resolved = path.resolve()
        if not any(root == path or root in path.parents or root == resolved or root in resolved.parents for root in roots):
            paths.append(entry)
    return os.pathsep.join(paths)


def extension_paths(variants, overrides):
    paths = {variant: None if variant == "native" else SLATE for variant in variants}
    seen = set()
    for variant, directory in overrides:
        if variant not in paths or variant == "native" or variant in seen:
            raise RuntimeError(f"--extension-path needs a unique selected non-native variant, got {variant!r}")
        path = Path(directory).expanduser().resolve()
        if not path.is_dir():
            raise RuntimeError(f"Extension directory for {variant} not found: {path}")
        paths[variant] = path
        seen.add(variant)
    for variant in variants:
        if variant in EXTERNAL_VARIANTS and variant not in seen:
            raise RuntimeError(f"{variant} requires --extension-path {variant} DIR")
    return paths


def extension_metadata(path):
    if path is None:
        return None
    manifest = path / "package.json"
    package = json.loads(manifest.read_text(encoding="utf-8")) if manifest.is_file() else {}
    return {"path": str(path), "name": package.get("name"), "version": package.get("version")}


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def cpu_seconds(pid):
    if sys.platform == "linux":
        # comm can contain spaces and parentheses. Strip it before indexing /proc fields.
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return (int(fields[11]) + int(fields[12])) / os.sysconf("SC_CLK_TCK")
    result = command(["ps", "-o", "time=", "-p", str(pid)])
    days, sep, clock = result.partition("-")
    return (int(days) * 86400 if sep else 0) + sum(
        60 ** i * float(part) for i, part in enumerate(reversed((clock if sep else days).split(":")))
    )


class Terminal:
    def __init__(self, fd):
        self.fd = fd
        self.bytes = 0
        self.raw_startup = bytearray()
        self.capturing = True
        self.eof = False
        os.set_blocking(fd, False)

    def drain_one(self):
        try:
            data = os.read(self.fd, 65536)
        except BlockingIOError:
            return
        except OSError as error:
            if error.errno != errno.EIO:  # EOF on Linux PTYs.
                raise
            data = b""
        if not data:
            self.eof = True
        self.bytes += len(data)
        if self.capturing:
            self.raw_startup.extend(data)
            if len(self.raw_startup) > 2**22:
                raise RuntimeError("More than 4 MiB of terminal output before the startup marker")

    def pump(self, seconds, until=None):
        end = time.monotonic() + seconds
        while not self.eof:
            timeout = end - time.monotonic()
            if timeout <= 0:
                break
            if select.select([self.fd], [], [], timeout)[0]:
                self.drain_one()
                if until and until():
                    return True
        return False

    def wheel(self, button):
        event = memoryview(f"\x1b[<{button};40;20M".encode("ascii"))
        end = time.monotonic() + WHEEL_WRITE_TIMEOUT
        while event:
            try:
                event = event[os.write(self.fd, event):]
            except BlockingIOError:
                remaining = end - time.monotonic()
                if remaining <= 0:
                    raise RuntimeError("Timed out writing wheel input to Pi")
                # Retry the write even without a writable notification: a full macOS PTY
                # can miss that notification while Pi is busy painting and reading input.
                self.pump(min(0.02, remaining))
                check_alive(self)


def signal_process(pid, sig, group=False):
    try:
        (os.killpg if group else os.kill)(pid, sig)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        # macOS can report EPERM for a group whose last process just exited.
        return sig == 0
    except OSError as error:
        print(f"Warning: cleanup signal {sig} failed: {error}", file=sys.stderr)
        return False


def stop_child(pid, term):
    # Reap an exited leader before signaling its group (macOS may reject a zombie).
    # Still signal the group if the leader exited: descendants may outlive it.
    reaped = bool(os.waitpid(pid, os.WNOHANG)[0])
    try:
        if not signal_process(pid, signal.SIGTERM, group=True) and not reaped:
            signal_process(pid, signal.SIGTERM)
        end = time.monotonic() + 5
        while time.monotonic() < end:
            if not reaped:
                reaped = bool(os.waitpid(pid, os.WNOHANG)[0])
            if reaped and not signal_process(pid, 0, group=True):
                return
            if term and not term.eof:
                term.capturing = False
                try:
                    term.pump(0.05)
                    continue
                except OSError:
                    term.eof = True  # Do not let a failed drain mask the original error.
            time.sleep(0.05)
    finally:
        if not reaped or signal_process(pid, 0, group=True):
            signal_process(pid, signal.SIGKILL, group=True)
        if not reaped:
            signal_process(pid, signal.SIGKILL)
            os.waitpid(pid, 0)


@contextmanager
def spawn(argv, cwd, env, size):
    pid = None
    term = None
    fd = None
    try:
        pid, fd = pty.fork()
        if pid == 0:
            try:
                signal.signal(signal.SIGINT, signal.SIG_DFL)
                signal.signal(signal.SIGTERM, signal.SIG_DFL)
                cols, rows = size
                fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
                os.chdir(cwd)
                os.execve(argv[0], argv, env)
            except BaseException as error:
                os.write(2, f"Error starting Pi: {error}\n".encode())
                os._exit(127)
        term = Terminal(fd)
        yield pid, term
    finally:
        if pid:
            # Let Pi shut down and Node flush its optional profile; force-reap on timeout.
            old_int = signal.signal(signal.SIGINT, signal.SIG_IGN)
            old_term = signal.signal(signal.SIGTERM, signal.SIG_IGN)
            try:
                stop_child(pid, term)
            finally:
                if fd is not None:
                    os.close(fd)
                signal.signal(signal.SIGTERM, old_term)
                signal.signal(signal.SIGINT, old_int)


def check_alive(term):
    if term.eof:
        raise RuntimeError("Pi exited before the scenario finished")


def measured(pid, term, action):
    check_alive(term)
    cpu, nbytes = cpu_seconds(pid), term.bytes
    started, mono = clock_ms(), time.monotonic()
    action()
    ended, elapsed = clock_ms(), time.monotonic() - mono
    check_alive(term)
    return started, ended, elapsed, cpu_seconds(pid) - cpu, term.bytes - nbytes


def frame_stats(samples):
    if not samples:
        return dict.fromkeys(("mean_ms", "p50_ms", "p95_ms", "max_ms"))
    samples.sort()
    return {"mean_ms": statistics.fmean(samples), "p50_ms": statistics.median(samples),
            "p95_ms": samples[math.ceil(len(samples) * 0.95) - 1], "max_ms": samples[-1]}


def metrics(window, samples):
    start, end, elapsed, cpu, nbytes = window
    view, content = [], []
    requests = Counter()
    request_count = 0
    for event, at, *data in samples:
        if start <= at < end:
            if event == "frame":
                (content if data[0] else view).append(data[1])
            elif event == "request":
                request_count += 1
                if data:
                    requests[data[0]] += 1
    count = len(view) + len(content)
    return {"wall_s": elapsed, "cpu_s": cpu, "tty_bytes": nbytes, "bytes_per_frame": nbytes / count if count else None,
            "frames": count, "view_frames": len(view), "content_frames": len(content),
            "frame": frame_stats(view + content), "view_frame": frame_stats(view), "content_frame": frame_stats(content),
            "content_requests": request_count, "content_request_stacks": dict(requests)}


def wait_status(term, path, timeout, predicate):
    end = time.monotonic() + timeout
    status = None
    while time.monotonic() < end:
        check_alive(term)
        if path.is_file():
            status = json.loads(path.read_text(encoding="utf-8"))
            if "error" in status:
                raise RuntimeError(status["error"])
            if predicate(status):
                return status
        term.pump(min(0.05, max(0, end - time.monotonic())))
    raise RuntimeError(f"Timed out waiting for the fullscreen probe; last status: {status}")


def uses_fresh_slate(variant, args):
    return args.slate_fresh and variant in FRESH_SLATE_VARIANTS


def visible_surfaces(variant, args):
    # Fresh Slate starts focused, so the sidebar is not visible. The chat adapter is
    # not a surface: both tool grouping and the optional transcript window use it.
    if uses_fresh_slate(variant, args):
        return ["editor", "tool-cards"]
    return [surface for surface in VARIANTS[variant] if surface != "transcript"]


def transcript_config(variant, args):
    owned = not uses_fresh_slate(variant, args) and "transcript" in VARIANTS[variant]
    limit = (MESSAGE_LENGTH.get(variant) or "shipped-default") if owned else "all"
    return {"owned": owned, "limit": limit}


def attest(status, variant, expected_surfaces, expected_chat_adapter):
    active = {name for name, enabled in status["surfaces"].items() if enabled}
    expected = set(expected_surfaces)
    if active != expected:
        raise RuntimeError(f"Slate surface mismatch: missing {sorted(expected - active)}, unexpected {sorted(active - expected)}")
    if status["chat_adapter"] != expected_chat_adapter:
        raise RuntimeError(f"Expected chat_adapter={expected_chat_adapter}, got {status['chat_adapter']}")
    if variant == "starline" and not status["starlineEditor"]:
        raise RuntimeError("Starline's PolishedEditor was not mounted")
    if status["scrollTop"] is None:
        raise RuntimeError("The primary transcript ScrollView was not found")
    if status["maxScrollTop"] is None:
        raise RuntimeError("The primary transcript ScrollView's scroll range was not found")


def validate_burst(scenario, before, after, allow_dropped_input, *, busy=False):
    bottom = before["maxScrollTop"]
    range_changed = after["maxScrollTop"] != bottom or after["scrollRangeRevision"] != before["scrollRangeRevision"]
    if range_changed and not busy:
        raise RuntimeError(f"Primary ScrollView {scenario}: scroll range changed during the burst "
                           f"(maxScrollTop {bottom} → {after['maxScrollTop']}).")
    distance = WHEEL_EVENTS * WHEEL_LINES
    received = after["wheelLines"][scenario] - before["wheelLines"][scenario]
    if not 0 <= received <= distance:
        raise RuntimeError(f"Primary ScrollView {scenario}: expected up to {distance} wheel lines, got {received}")
    dropped = distance - received
    if dropped and not allow_dropped_input:
        raise RuntimeError(f"Primary ScrollView {scenario}: received {received} of {distance} wheel lines; "
                           f"{dropped} wheel lines lost. Pass --allow-dropped-input to record this instead of failing.")
    start, end = before["scrollTop"], after["scrollTop"]
    expected = max(0, start - received) if scenario == "wheel_up" else min(bottom, start + received)
    if end != expected and not range_changed:
        raise RuntimeError(f"Primary ScrollView {scenario}: expected scrollTop {expected} after {received} wheel lines, got {end}")
    return {"before": start, "after": end, "received_lines": received, "dropped_lines": dropped,
            "viewport_displacement_lines": abs(end - start), "max_scroll_top": bottom,
            "max_scroll_top_after": after["maxScrollTop"]}


def run_one(node, cli, env, root, cwd, fixture, variant, extension, terminal, args, profile_dir, capture):
    home, agent, sessions = (root / name for name in ("home", "agent", "sessions"))
    for directory in (home, agent, sessions):
        directory.mkdir(parents=True)
    # Work in a blank temp cwd; bypass folder trust only for this exact directory.
    write_json(agent / "trust.json", {str(cwd): True})
    busy = args.scenario == "busy"
    write_json(agent / "settings.json", {"packages": [], "theme": "dark", "hideThinkingBlock": busy,
                                          "quietStartup": True, "fullscreenExitOutput": "resume-hint",
                                          "fullscreenWheelScrollLines": WHEEL_LINES})
    expected_surfaces = visible_surfaces(variant, args)
    transcript = transcript_config(variant, args)
    expected_chat_adapter = transcript["owned"] or "tool-cards" in expected_surfaces
    if VARIANTS[variant] and not uses_fresh_slate(variant, args):
        slate_settings = {"version": 1, "surfaces": VARIANTS[variant], "focused": False}
        if MESSAGE_LENGTH.get(variant) is not None:
            slate_settings["messageLength"] = MESSAGE_LENGTH[variant]
        write_json(agent / "pi-slate.json", slate_settings)
    session = sessions / "synthetic.jsonl"
    shutil.copyfile(fixture, session)
    probe, status = root / "probe.jsonl", root / "status.json"
    env = dict(env, HOME=str(home), XDG_CONFIG_HOME=str(home / "config"), XDG_CACHE_HOME=str(home / "cache"),
               XDG_DATA_HOME=str(home / "data"), XDG_STATE_HOME=str(home / "state"),
               PI_CODING_AGENT_DIR=str(agent), PI_SCROLL_PROBE=str(probe), PI_SCROLL_STATUS=str(status),
               PI_SCROLL_QUIET_MS=str(QUIET_MS), PI_SCROLL_STACKS="1" if args.stacks else "0")
    argv = [node]
    if args.cpu_prof:
        profile_dir.mkdir(parents=True)
        argv += ["--cpu-prof", f"--cpu-prof-dir={profile_dir}"]
    argv += [str(cli), "--tui-mode", "fullscreen", "--no-extensions", "--no-mcp", "--no-skills",
             "--no-prompt-templates", "--no-context-files", "--tools", "bash,read,grep,ls,find,edit,write",
             "-e", str(HERE / "probe/index.ts"), "--session-dir", str(sessions), "--session", str(session)]
    if extension is not None:
        argv += ["-e", str(extension)]
    if busy:
        stage_path = root / "stage"
        stage_path.write_text("0", encoding="utf-8")
        (cwd / "fixture.txt").write_text("Synthetic read result.\n", encoding="utf-8")
        env["PI_SCROLL_BUSY_STAGE"] = str(stage_path)
        argv += ["--model", "scroll-bench/offline"]
    windows, wheel = {}, {}
    launch = time.monotonic()
    with spawn(argv, cwd, env, TERMINALS[terminal]) as (pid, term):
        def first_paint():
            begin = term.raw_startup.find(BEGIN_PAINT)
            return term.raw_startup.find(END_PAINT, begin + len(BEGIN_PAINT)) if begin >= 0 else -1

        def transcript_paint():
            marker = term.raw_startup.find(READY)
            return marker != -1 and MOUSE in term.raw_startup and term.raw_startup.find(END_PAINT, marker) != -1

        if not term.pump(args.startup_timeout, lambda: first_paint() >= 0):
            raise RuntimeError(f"Pi did not send a complete first paint; PTY tail: {term.raw_startup[-2500:]!r}")
        startup = {"wall_s": time.monotonic() - launch, "cpu_s": cpu_seconds(pid),
                   "tty_bytes": first_paint() + len(END_PAINT)}
        if not transcript_paint() and not term.pump(max(0, args.startup_timeout - (time.monotonic() - launch)), transcript_paint):
            raise RuntimeError(f"Pi did not paint the synthetic transcript in mouse mode; PTY tail: {term.raw_startup[-2500:]!r}")
        if capture:
            capture.write_bytes(term.raw_startup)
        term.capturing = False
        before_ready = time.monotonic()
        current = wait_status(term, status, args.readiness_timeout, lambda s: s["ready"])
        attest(current, variant, expected_surfaces, expected_chat_adapter)
        validation = {"surfaces": current["surfaces"], "chat_adapter": current["chat_adapter"],
                      "diff_views": current["diffViews"],
                      "starline_editor": current["starlineEditor"], "pending_diffs": current["pendingDiffs"],
                      "host_highlight_settled": current["hostHighlightSettled"],
                      "readiness_wait_s": time.monotonic() - before_ready, "wheel": wheel}

        def viewport():
            nonlocal current
            previous = current["seq"]
            os.kill(pid, signal.SIGUSR2)  # No fake terminal input or render request.
            # A host stuck in long frames (e.g. 0.3.0, full history) can starve the signal for seconds.
            current = wait_status(term, status, 20, lambda s: s["seq"] > previous)
            attest(current, variant, expected_surfaces, expected_chat_adapter)
            return current

        def burst(scenario, button):
            for i in range(WHEEL_EVENTS):
                try:
                    term.wheel(button)
                except RuntimeError as error:
                    raise RuntimeError(f"{scenario}, event {i + 1}: {error}") from error
                term.pump(WHEEL_INTERVAL)
                check_alive(term)
            term.pump(WHEEL_SETTLE)

        initial = viewport()
        start, bottom = initial["scrollTop"], initial["maxScrollTop"]
        # Pi's follow-end ScrollView starts scrollBy() at maxScrollTop.
        if start != bottom:
            raise RuntimeError(f"Primary ScrollView did not start at the bottom: scrollTop {start}, expected {bottom}")
        distance = WHEEL_EVENTS * WHEEL_LINES
        if bottom < distance:
            raise RuntimeError(f"Fixture has only {bottom} scrollable lines; need at least {distance} for a full wheel burst. "
                               "Use a larger --size or --entries.")
        windows["idle"] = measured(pid, term, lambda: term.pump(IDLE_SECONDS))
        def busy_stage(stage, predicate):
            stage_path.write_text(str(stage), encoding="utf-8")
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                frame = viewport()
                if predicate(frame["busy"]):
                    return frame
            raise RuntimeError(f"Synthetic stream did not reach stage {stage}: {current.get('busy')}")

        for scenario, button in (("wheel_up", 64), ("wheel_down", 65)):
            if busy and scenario == "wheel_down":
                stage_path.write_text("2", encoding="utf-8")
            before = viewport()  # Acknowledge any stage transition before starting the timer.
            if scenario == "wheel_up" and before["scrollTop"] != start:
                raise RuntimeError(f"Primary ScrollView moved during idle: scrollTop {start} → {before['scrollTop']}")
            counter = "thinkingDeltas" if scenario == "wheel_up" else "textDeltas"
            if busy and scenario == "wheel_up":
                before = busy_stage(1, lambda s: s["thinkingDeltas"] >= 2)
            windows[scenario] = measured(pid, term, lambda: burst(scenario, button))
            after = viewport()
            wheel[scenario] = validate_burst(scenario, before, after, args.allow_dropped_input, busy=busy)
            if busy:
                deltas = after["busy"][counter] - before["busy"][counter]
                if deltas < (2 if scenario == "wheel_up" else 6) or after["busy"]["settled"] or (
                        scenario == "wheel_down" and after["busy"]["toolsFinished"] != 1):
                    raise RuntimeError(f"Synthetic stream was not active during {scenario}: {after['busy']}")
                wheel[scenario]["stream_deltas"] = deltas
        if busy:
            validation["busy"] = busy_stage(3, lambda s: s["settled"])["busy"]
    samples = [json.loads(line) for line in probe.read_text(encoding="utf-8").splitlines()]
    result = {scenario: metrics(window, samples) for scenario, window in windows.items()}
    for scenario, row in result.items():
        burst_stat = wheel.get(scenario, {})
        row["dropped_wheel_lines"] = burst_stat.get("dropped_lines")
        row["viewport_displacement_lines"] = burst_stat.get("viewport_displacement_lines")
        row["max_scroll_top"] = burst_stat.get("max_scroll_top_after")
    if any(not result[s]["frames"] or not result[s]["tty_bytes"] for s in ("wheel_up", "wheel_down")):
        raise RuntimeError("Wheel input did not produce frames and PTY output in both directions")
    return {"startup": startup, **result, "validation": validation}


def median_metrics(rows):
    summary = {}
    for key in rows[0]:
        values = [row[key] for row in rows]
        if key == "content_request_stacks":
            all_stacks = set().union(*(value.keys() for value in values))
            counts = {stack: statistics.median(v.get(stack, 0) for v in values) for stack in all_stacks}
            summary[key] = dict(sorted(((stack, n) for stack, n in counts.items() if n),
                                       key=lambda item: (-item[1], item[0]))[:8])
        elif isinstance(values[0], dict):
            summary[key] = median_metrics(values)
        else:
            present = [value for value in values if value is not None]
            summary[key] = statistics.median(present) if present else None
    return summary


def summarize_runs(runs):
    return {scenario: median_metrics([run[scenario] for run in runs]) for scenario in SCENARIOS}


# Metric path → (heading, numeric format). Comparisons use the same paths and order.
TIMING_COLUMNS = {"wall_s": ("Wall s", ".3f"), "cpu_s": ("CPU s", ".3f")}
STARTUP_COLUMNS = {**TIMING_COLUMNS, "tty_bytes": ("PTY bytes", ".0f")}
STEADY_COLUMNS = {
    **TIMING_COLUMNS,
    "frames": ("Frames", "g"), "view_frames": ("View", "g"), "content_frames": ("Content", "g"),
    "content_requests": ("Content requests", "g"),
    "frame.mean_ms": ("Mean ms", ".1f"), "frame.p50_ms": ("p50 ms", ".1f"),
    "frame.p95_ms": ("p95 ms", ".1f"), "frame.max_ms": ("Max ms", ".1f"),
    "view_frame.mean_ms": ("View mean ms", ".1f"), "content_frame.mean_ms": ("Content mean ms", ".1f"),
    "bytes_per_frame": ("B/frame", ".0f"), "dropped_wheel_lines": ("Dropped wheel lines", "g"),
    "viewport_displacement_lines": ("Viewport lines moved", "g"),
    "max_scroll_top": ("Max scroll offset (lines)", "g"),
}
CASE_HEADERS = ["Terminal", "Variant", "History"]


def metric(metrics, path):
    key, _, nested = path.partition(".")
    return metrics[key][nested] if nested else metrics.get(key)


def value(number, spec):
    return "—" if number is None else format(number, spec)


def delta(before, after):
    if before is None or after is None:
        return "—"
    percent = f" ({(after - before) / before:+.1%})" if before else ""
    return f"{after - before:+.3g}{percent}"


def markdown_table(headers, rows, text_cols):
    def line(cells):
        return "| " + " | ".join(cells) + " |"

    return "\n".join([line(headers), line(["---"] * text_cols + ["---:"] * (len(headers) - text_cols)),
                      *(line(row) for row in rows)])


def case_label(case):
    return [case["terminal"], case["variant"], case["history"]]


def summary_table(report):
    # Project the detailed metrics, with shorter labels and precision for sharing.
    wheel = SCENARIOS[2:]
    projection = [("First paint s", ["startup"], "wall_s", None), ("Idle content frames", ["idle"], "content_frames", None),
                  ("Wheel CPU s", wheel, "cpu_s", ".2f"), ("View mean ms", wheel, "view_frame.mean_ms", None),
                  ("Frame p95 ms", wheel, "frame.p95_ms", None), ("Wheel content frames", wheel, "content_frames", ".1f"),
                  ("B/frame", wheel, "bytes_per_frame", None), ("Dropped wheel lines", wheel, "dropped_wheel_lines", None),
                  ("Viewport lines moved", wheel, "viewport_displacement_lines", None),
                  ("Max scroll offset (lines)", wheel, "max_scroll_top", None)]
    headers, rows = CASE_HEADERS.copy(), [case_label(case) for case in report["cases"]]
    for heading, scenarios, path, spec in projection:
        columns = STARTUP_COLUMNS if scenarios == ["startup"] else STEADY_COLUMNS
        headers.append(heading + (" ↑ / ↓" if scenarios == wheel else ""))
        for row, case in zip(rows, report["cases"]):
            row.append(" / ".join(value(metric(case["median"][scenario], path), spec or columns[path][1]) for scenario in scenarios))
    return markdown_table(headers, rows, len(CASE_HEADERS))


def metric_table(cases, scenarios, columns, previous):
    comparing = previous is not None
    show_phase = scenarios != ["startup"]
    labels = [*CASE_HEADERS, "Scenario"] if show_phase else CASE_HEADERS
    prefix = "Δ " if comparing else ""
    rows = []
    for case in cases:
        label = case_label(case)
        baseline = previous.get(tuple(label)) if comparing else None
        if comparing and baseline is None:
            continue
        for scenario in scenarios:
            metrics = case["median"][scenario]
            cells = [value(metric(metrics, path), spec) if baseline is None else delta(metric(baseline[scenario], path), metric(metrics, path))
                     for path, (_, spec) in columns.items()]
            rows.append([*(label + [scenario] if show_phase else label), *cells])
    return markdown_table([*labels, *(prefix + heading for heading, _ in columns.values())], rows, len(labels))


def table(report, previous=None):
    first = metric_table(report["cases"], ["startup"], STARTUP_COLUMNS, previous)
    steady = metric_table(report["cases"], SCENARIOS[1:], STEADY_COLUMNS, previous)
    if previous is not None:
        return f"{first}\n\n{steady}"
    return f"## Spawn to first paint\n\n{first}\n\n## Post-hook steady state\n\n{steady}"


def compare(old_path, new_path):
    old, new = (json.loads(Path(p).read_text(encoding="utf-8")) for p in (old_path, new_path))
    if old.get("format") != FORMAT or new.get("format") != FORMAT:
        raise RuntimeError("Incompatible result format")
    old_revision = old["workload"].get("readiness_revision")
    new_revision = new["workload"].get("readiness_revision")
    if old_revision != READINESS_REVISION or new_revision != READINESS_REVISION:
        raise RuntimeError(f"Cannot compare readiness revisions {old_revision!r} and {new_revision!r}; "
                           f"rerun both workloads with this benchmark (revision {READINESS_REVISION}).")
    if old["workload"] != new["workload"]:
        raise RuntimeError("Workloads differ (fixture, readiness, scroll settings, or diagnostics); compare like for like")
    if old["platform"] != new["platform"]:
        print("Warning: the results were collected on different OS/architecture versions", file=sys.stderr)
    print(f"Old: Pi {old['pi_version']}, Slate {old['slate_version']} ({old['slate_git_sha']})")
    print(f"New: Pi {new['pi_version']}, Slate {new['slate_version']} ({new['slate_git_sha']})\n")
    previous = {tuple(case_label(case)): case["median"] for case in old["cases"]}
    if not any(tuple(case_label(case)) in previous for case in new["cases"]):
        raise RuntimeError("No matching variant/terminal pairs")
    print(table(new, previous))


def suite(args):
    if sys.platform not in ("darwin", "linux"):
        raise RuntimeError("The live benchmark needs a macOS or Linux PTY; --compare is portable")
    suite_start = time.monotonic()
    extensions = extension_paths(args.variants, args.extension_path)
    extension_builds = {variant: extension_metadata(path) for variant, path in extensions.items()}
    child_path = isolated_path()
    node = shutil.which("node", path=child_path) if child_path else None
    if not node:
        raise RuntimeError("Node.js was not found in PATH")
    node = os.path.abspath(node)
    cli = find_cli()
    entries = args.entries if args.entries is not None else SIZES[args.size]
    # Inherit only executable search path and fix the relevant terminal/locale settings.
    env = {"PATH": child_path, "TERM": "xterm-256color", "COLORTERM": "truecolor",
           "LANG": "C.UTF-8" if sys.platform == "linux" else "en_US.UTF-8", "PI_TELEMETRY": "0",
           "PI_OFFLINE": "1", "PI_SKIP_VERSION_CHECK": "1"}
    with tempfile.TemporaryDirectory(prefix="pi-scroll-bench-") as tmp:
        temp = Path(tmp).resolve()
        cwd = temp / "workspace"
        cwd.mkdir()
        pi_version = command([node, str(cli), "--version"], cwd=cwd, env=dict(env, HOME=str(temp), PI_CODING_AGENT_DIR=str(temp / "version-agent")))
        fixture = temp / "fixture.jsonl"
        subprocess.run([node, str(HERE / "generate.mjs"), "--entries", str(entries), "--seed", str(args.seed),
                        "--cwd", str(cwd), "--output", str(fixture)], cwd=cwd, env=env, check=True, timeout=60)
        # Exclude the header's temporary cwd from the workload fingerprint.
        with fixture.open("rb") as handle:
            handle.readline()
            fixture_hash = sha256(handle.read()).hexdigest()
        now = datetime.now(timezone.utc)
        results = RESULTS / now.strftime("scroll-%Y%m%dT%H%M%S.%fZ")
        results.mkdir(parents=True)
        report = {
            "format": FORMAT, "date": now.isoformat(), "pi_version": pi_version,
            "slate_version": json.loads((SLATE / "package.json").read_text(encoding="utf-8"))["version"],
            "slate_git_sha": command(["git", "rev-parse", "HEAD"], cwd=SLATE),
            "slate_extensions_dirty": bool(command(["git", "status", "--porcelain", "--", "extensions"], cwd=SLATE)),
            "node_version": command([node, "--version"], env=env),
            "platform": {"os": platform.system(), "arch": platform.machine(), "release": platform.release()},
            "workload": {"entries": entries, "seed": args.seed, "fixture_sha256": fixture_hash,
                         "readiness_revision": READINESS_REVISION, "readiness_quiet_ms": QUIET_MS, "readiness_timeout_s": args.readiness_timeout, "idle_s": IDLE_SECONDS,
                         "wheel_events": WHEEL_EVENTS, "wheel_interval_s": WHEEL_INTERVAL, "wheel_settle_s": WHEEL_SETTLE,
                         "fullscreenWheelScrollLines": WHEEL_LINES, "slate_messageLength": MESSAGE_LENGTH, "offline": True,
                         "stacks": args.stacks, "cpu_prof": args.cpu_prof, "allow_dropped_input": args.allow_dropped_input},
            "runs": args.runs, "cases": [],
        }
        if args.scenario == "busy":
            report["workload"]["busy_stream_revision"] = 4
        heading = (f"Pi {pi_version} · Slate {report['slate_version']} ({report['slate_git_sha']}) · "
                   f"{entries} entries · {args.runs} runs" + (" · busy" if args.scenario == "busy" else ""))
        if args.slate_fresh:
            heading += " · fresh Slate defaults"
        print(heading, flush=True)
        print(f"Results: {results}", flush=True)
        for terminal in args.terminals:
            for variant in args.variants:
                runs, captures, profiles = [], [], []
                for i in range(1, args.runs + 1):
                    name = f"{terminal}-{variant}-{i}"
                    print(f"{name}: running", file=sys.stderr, flush=True)
                    capture = results / f"{name}.ansi" if args.capture and i == 1 else None
                    profile_dir = results / "profiles" / name
                    try:
                        runs.append(run_one(node, cli, env, temp / name, cwd, fixture, variant, extensions[variant],
                                            terminal, args, profile_dir, capture))
                    except Exception as error:
                        raise RuntimeError(f"{name}: {error}") from error
                    if capture:
                        captures.append(capture.name)
                    if args.cpu_prof:
                        paths = sorted(profile_dir.glob("*.cpuprofile"))
                        if not paths:
                            raise RuntimeError(f"{name}: Node wrote no CPU profile")
                        for path in paths:
                            profiles.append(str(path.relative_to(results)))
                            print(f"\nProfile: {path.relative_to(results)}", flush=True)
                            subprocess.run([node, str(HERE / "prof.mjs"), str(path)], env=env, check=True, timeout=60)
                history = "fresh-unlimited" if uses_fresh_slate(variant, args) else HISTORY[variant]
                report["cases"].append({"variant": variant, "terminal": terminal, "history": history,
                                        "extension": extension_builds[variant], "surfaces": visible_surfaces(variant, args),
                                        "chat_adapter": runs[0]["validation"]["chat_adapter"],
                                        "transcript": transcript_config(variant, args),
                                        "median": summarize_runs(runs), "runs": runs,
                                        "captures": captures, "profiles": profiles})
        for case in report["cases"]:
            for run in case["runs"]:
                for scenario in SCENARIOS[1:]:
                    m = run[scenario]
                    m["content_request_stacks"] = dict(sorted(m["content_request_stacks"].items(),
                                                              key=lambda item: (-item[1], item[0]))[:8])
        report["duration_s"] = time.monotonic() - suite_start
        write_json(results / "results.json", report)
        (results / "results.md").write_text(f"{heading}\n\n{table(report)}\n", encoding="utf-8")
        summary = (f"{heading} per case · {report['duration_s']:.1f} s total\n\n"
                   "Medians. ↑ / ↓ = one 400-event wheel burst per direction.\n\n" + summary_table(report))
        (results / "summary.md").write_text(summary + "\n", encoding="utf-8")
        print(summary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    size = parser.add_mutually_exclusive_group()
    size.add_argument("--size", choices=SIZES, default="large")
    size.add_argument("--entries", type=int, help="exact number of entries (excluding session header)")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--scenario", choices=("idle", "busy"), default="idle",
                        help="stream a local synthetic reply during the wheel bursts (busy), or scroll at idle (default)")
    parser.add_argument("--variants", choices=VARIANTS, nargs="+", default=DEFAULT_VARIANTS)
    parser.add_argument("--extension-path", nargs=2, metavar=("VARIANT", "DIR"), action="append", default=[],
                        help="load a different unpacked extension directory for a selected variant (repeatable)")
    parser.add_argument("--slate-fresh", action="store_true",
                        help="use untouched first-install settings for slate, slate-main-before, and slate-0.4.0")
    parser.add_argument("--terminals", choices=TERMINALS, nargs="+", default=list(TERMINALS))
    parser.add_argument("--startup-timeout", type=float, default=30.0)
    parser.add_argument("--readiness-timeout", type=float, default=30.0, help="max seconds to settle after the transcript paint")
    parser.add_argument("--capture", action="store_true", help="save a raw startup PTY capture for each case's first run")
    parser.add_argument("--stacks", action="store_true", help="collect content request stacks (diagnostic overhead)")
    parser.add_argument("--cpu-prof", action="store_true", help="save and summarize whole-process V8 CPU profiles")
    parser.add_argument("--allow-dropped-input", action="store_true",
                        help="record lost wheel lines instead of failing (for benchmarking builds that drop input)")
    parser.add_argument("--compare", nargs=2, metavar=("OLD_JSON", "NEW_JSON"))
    args = parser.parse_args()
    if args.compare:
        compare(*args.compare)
        return
    if (args.runs < 1 or not 0 <= args.seed <= 0xffffffff or
            args.entries is not None and not 12 <= args.entries <= 999999 or
            not math.isfinite(args.readiness_timeout) or args.readiness_timeout <= 0 or
            not math.isfinite(args.startup_timeout) or args.startup_timeout <= 0 or
            len(set(args.variants)) != len(args.variants) or len(set(args.terminals)) != len(args.terminals)):
        parser.error("invalid runs, seed (uint32), entries (12..999999), timeout, or duplicate cases")
    signal.signal(signal.SIGTERM, on_term)
    suite(args)


def on_term(_signum, _frame):
    raise KeyboardInterrupt


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit("Benchmark interrupted")
    except (RuntimeError, OSError, subprocess.SubprocessError, ValueError) as error:
        sys.exit(f"Benchmark failed: {error}")
