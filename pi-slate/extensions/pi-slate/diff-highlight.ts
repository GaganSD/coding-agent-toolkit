import { basename, extname } from "node:path";
import { bundledLanguages, createHighlighter, type BundledLanguage, type BundledTheme, type Highlighter, type ThemedToken } from "shiki";

const extensions: Record<string, string> = {
  h: "c", hh: "cpp", hpp: "cpp", cc: "cpp", cxx: "cpp", mjs: "javascript", cjs: "javascript",
  pyw: "python", pyi: "python", rs: "rust", yml: "yaml", zsh: "shellscript", bash: "shellscript",
  sh: "shellscript", env: "dotenv", mdx: "mdx",
};
const filenames: Record<string, string> = {
  dockerfile: "dockerfile", containerfile: "dockerfile", makefile: "makefile", gnumakefile: "makefile",
  gemfile: "ruby", rakefile: "ruby", "cmakelists.txt": "cmake", ".bashrc": "shellscript",
  ".zshrc": "shellscript", ".gitignore": "gitignore",
};

export function diffLanguage(path: string): BundledLanguage | "text" {
  const name = basename(path).toLowerCase();
  const ext = extname(name).slice(1);
  const language = filenames[name] ?? (name === ".env" || name.startsWith(".env.") ? "dotenv" : undefined)
    ?? extensions[ext] ?? ext;
  return Object.hasOwn(bundledLanguages, language) ? language as BundledLanguage : "text";
}

/** Lazy, shared grammar loading; no Shiki work during tool execution or startup. */
export class DiffHighlighter {
  private highlighter?: Promise<Highlighter>;
  private disposed = false;
  private loads = new Map<string, Promise<void>>();
  private redraw?: {
    timer: ReturnType<typeof setTimeout>; callbacks: Set<() => void>; done: Promise<void>; finish(): void;
  };

  repaint(invalidate: () => void): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.redraw) {
      const callbacks = new Set<() => void>();
      let finish!: () => void;
      const done = new Promise<void>(resolve => { finish = resolve; });
      // Tool contexts own their invalidation. Flush all of them in one turn so
      // Pi schedules one content frame for a burst of completed highlights.
      const timer = setTimeout(() => {
        this.redraw = undefined;
        for (const callback of callbacks) {
          try { callback(); } catch { /* Tool may belong to a closed session. */ }
        }
        finish();
      }, 100);
      timer.unref?.();
      this.redraw = { timer, callbacks, done, finish };
    }
    this.redraw.callbacks.add(invalidate);
    return this.redraw.done;
  }

  async tokens(code: string, path: string, theme: BundledTheme): Promise<ThemedToken[][] | undefined> {
    const lang = diffLanguage(path);
    if (lang === "text" || this.disposed) return undefined;
    try {
      this.highlighter ??= createHighlighter({ themes: [theme], langs: [] });
      const highlighter = await this.highlighter;
      if (this.disposed) return undefined;
      const themeKey = `theme:${theme}`;
      if (!this.loads.has(themeKey)) this.loads.set(themeKey, highlighter.loadTheme(theme));
      if (!this.loads.has(lang)) this.loads.set(lang, highlighter.loadLanguage(lang));
      await Promise.all([this.loads.get(themeKey), this.loads.get(lang)]);
      if (this.disposed) return undefined;
      return highlighter.codeToTokens(code, {
        lang, theme, tokenizeMaxLineLength: 2000, tokenizeTimeLimit: 50,
      }).tokens;
    } catch {
      // Highlighting is optional. Never turn a successful mutation into an error.
      return undefined;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.redraw) {
      clearTimeout(this.redraw.timer);
      this.redraw.finish();
      this.redraw = undefined;
    }
    void this.highlighter?.then((highlighter) => highlighter.dispose(), () => {});
    this.loads.clear();
  }
}
