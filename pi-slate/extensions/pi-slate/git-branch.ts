import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Composer branch facts must not require taking the host's footer slot. */
export class GitBranchPoller {
  private timer?: ReturnType<typeof setInterval>;
  private generation = 0;

  private readonly pi: Pick<ExtensionAPI, "exec">;
  private readonly onChange: (branch: string | null) => boolean | void;

  constructor(pi: Pick<ExtensionAPI, "exec">, onChange: (branch: string | null) => boolean | void) {
    this.pi = pi;
    this.onChange = onChange;
  }

  start(cwd: string): void {
    this.dispose();
    const generation = this.generation;
    let pending = false;
    let previous: string | null | undefined;
    const refresh = async (): Promise<void> => {
      if (pending) return;
      pending = true;
      let branch: string | null = null;
      try {
        const result = await this.pi.exec("git", ["-C", cwd, "branch", "--show-current"], { timeout: 2000 });
        if (result.code === 0) branch = result.stdout.trim() || null;
      } catch { /* No branch label when Git is unavailable. */ }
      finally { pending = false; }
      if (generation !== this.generation || branch === previous) return;
      previous = branch;
      // A failed repaint must not deduplicate the next poll.
      try { if (this.onChange(branch) === false) previous = undefined; } catch { /* The editor or TUI may have been replaced. */ }
    };
    void refresh();
    this.timer = setInterval(() => void refresh(), 5000);
    this.timer.unref();
  }

  dispose(): void {
    this.generation += 1;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
