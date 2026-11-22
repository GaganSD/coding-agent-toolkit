import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAgentDir,
  VERSION,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import { chromePaint, ComposerEditor, composerPaddingX } from "./composer.ts";
import { requestNecessaryRender } from "./render-request.ts";
import { copyWithFeedback } from "./copy-feedback.ts";
import { ComposerSelectionController } from "./composer-selection.ts";
import { installConversationBridge } from "./conversation-bridge.ts";
import { installImagePlaceholders } from "./image-placeholders.ts";
import { installExitCommand } from "./exit.ts";
import { installPromptPicker } from "./prompts.ts";
import { installDiff } from "./diff.ts";
import { installRead } from "./read.ts";
import { installToolStyle } from "./tool-style.ts";
import { ToolGroups } from "./tool-groups.ts";
import { GitBranchPoller } from "./git-branch.ts";
import { formatSurfaces, has, parseSurfaceConfig, type SurfaceConfig } from "./surfaces.ts";
import { Sidebar } from "./sidebar.ts";
import { commandResources, parseSidebarFolds, sidebarMessageCounts, sidebarText, sidebarUsage, SidebarMcpFiles, SidebarSkills, type SidebarFolds, type SidebarResources } from "./sidebar-data.ts";
import { inspectSidebarText } from "./sidebar-inspector.ts";
import { SlateDiagnostics } from "./diagnostics.ts";
import { TurnCompletion } from "./turn-completion.ts";
import { ContextUsageCache } from "./context-usage.ts";
import { branchPerf } from "./perf-stats.ts";
import { estimateAssistantTokens, TokenRateTracker } from "./token-rate.ts";
import { createWordPicker } from "./working-words.ts";
import { isProgressStyle, PROGRESS_STYLES, setProgressStyle, setWaveActive, type ProgressStyle } from "./working-wave.ts";
import { formatLiveThinking, ThinkingFoldTracker } from "./thinking-fold.ts";
import { HiddenThinkingLabel } from "./hidden-thinking-label.ts";
import {
  decorateThinkingRows as paintThinkingRows,
  HIDDEN_THINKING_LABEL,
  ThinkingDurations,
  thinkingRowsKey,
  type ThinkingView,
} from "./thinking-label.ts";
import {
  type LogoStyle,
  formatFocusedContextResources,
  formatFocusedContextTokens,
  logoArgumentCompletions,
  LOGO_USAGE,
  modelStatusLabel,
  parseMessageLength,
  parseLogoArgs,
  parseMessageLengthArg,
  parseSidebarPercent,
  parseSidebarWidthArg,
  parseSlateArgs,
  resolveMessageLength,
  messageLengthMessage,
  slateArgumentCompletions,
  SLATE_USAGE,
  SLATE_VERSION,
  SIDEBAR_PERCENT_MEDIUM,
  SIDEBAR_PERCENT_NARROW,
  SIDEBAR_PERCENT_WIDE,
  MESSAGE_LENGTH_DEFAULT,
  MESSAGE_LENGTH_LONG,
  MESSAGE_LENGTH_SHORT,
  withCurrent,
  withoutCurrent,
  type ModelDisplay,
  SLATE_ISSUES_URL,
} from "./layout.ts";
import { SlateHeader } from "./header.ts";
import { openExternalArgs } from "./bug.ts";
import { ChatSurface, findChatContainer, layoutRootOf } from "./chat-surface.ts";
import { persistTheme, SLATE_NATIVE_THEME } from "./install-defaults.ts";
import { selectSlateTheme } from "./theme-selector.ts";
import { loadShortcuts, promptShortcutKey, type SlateShortcuts } from "./shortcuts.ts";
import { createCalloutPalette, decorateCallouts } from "./callouts.ts";

const PROGRESS_LABELS: Record<ProgressStyle, string> = {
  waves: "Waves",
  "dna-helix": "DNA helix",
  snake: "Snake",
  "cylon-scanner": "Cylon scanner",
};

type SlateConfig = SurfaceConfig & {
  density: "comfortable" | "compact";
  sidebarPercent?: number;
  focused?: boolean;
  messageLength?: number | "all";
  modelDisplay?: ModelDisplay;
  showPid?: boolean;
  logo?: LogoStyle;
  progress?: ProgressStyle;
  toolStyle?: "default" | "claudecode";
  effortBorderColor?: boolean;
  shortcuts?: SlateShortcuts;
  sidebarSections: SidebarFolds;
};

type MarkdownTransformerHost = {
  registerMarkdownTransformer?: (
    transformer: (markdown: string, context: { messageType: string; isStreaming: boolean; availableWidth: number }) => string,
    options?: { messageTypes?: readonly string[] },
  ) => void;
};

function loadMessageLength(value: unknown): number | "all" | undefined {
  if (value === "all") return "all";
  return parseMessageLength(value);
}

function loadModelDisplay(value: unknown): ModelDisplay | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Partial<ModelDisplay>;
  const display: ModelDisplay = {};
  if (Array.isArray(raw.stripPrefixes)) {
    const prefixes = raw.stripPrefixes.filter((p): p is string => typeof p === "string" && p.length > 0);
    if (prefixes.length > 0) display.stripPrefixes = prefixes;
  }
  if (typeof raw.providerAliases === "object" && raw.providerAliases !== null) {
    const aliases: Record<string, string> = {};
    for (const [key, alias] of Object.entries(raw.providerAliases)) {
      if (typeof alias === "string" && alias.length > 0) aliases[key] = alias;
    }
    if (Object.keys(aliases).length > 0) display.providerAliases = aliases;
  }
  if (raw.providerSuffix === true) display.providerSuffix = true;
  return Object.keys(display).length > 0 ? display : undefined;
}

function loadConfig(configPath: string): { config: SlateConfig; raw: Record<string, unknown>; error?: string } {
  let text: string | undefined;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") text = "";
  }
  const parsed = parseSurfaceConfig(text);
  const value = parsed.value as Record<string, unknown> & SurfaceConfig;
  const sidebarPercent = parseSidebarPercent(value.sidebarPercent);
  const messageLength = loadMessageLength(value.messageLength);
  const modelDisplay = loadModelDisplay(value.modelDisplay);
  const shortcuts = loadShortcuts(value.shortcuts);
  return {
    raw: parsed.ok && text !== undefined ? JSON.parse(text) as Record<string, unknown> : value,
    config: {
      version: value.version,
      surfaces: value.surfaces,
      composerMetadata: value.composerMetadata,
      density: value.density === "compact" ? "compact" : "comfortable",
      ...(sidebarPercent === undefined ? {} : { sidebarPercent }),
      focused: value.focused !== false,
      ...(messageLength === undefined ? {} : { messageLength }),
      ...(modelDisplay === undefined ? {} : { modelDisplay }),
      showPid: value.showPid === true,
      effortBorderColor: value.effortBorderColor === true,
      ...(value.logo === "minimal" || value.logo === "original" ? { logo: value.logo } : {}),
      ...(value.toolStyle === "default" ? { toolStyle: "default" as const } : {}),
      ...(isProgressStyle(value.progress) ? { progress: value.progress } : {}),
      ...(shortcuts === undefined ? {} : { shortcuts }),
      sidebarSections: parseSidebarFolds(value.sidebarSections),
    },
    ...(!parsed.ok ? { error: parsed.error } : {}),
  };
}

function withMessageLength(current: SlateConfig, messageLength: number | "all" | undefined): SlateConfig {
  const next = { ...current };
  if (messageLength === undefined) delete next.messageLength;
  else next.messageLength = messageLength;
  return next;
}


function writeConfig(configPath: string, config: Record<string, unknown>): void {
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, configPath);
}

function withSidebarPercent(current: SlateConfig, percent: number | undefined): SlateConfig {
  const next = { ...current };
  if (percent === undefined) delete next.sidebarPercent;
  else next.sidebarPercent = percent;
  return next;
}

function widthMessage(percent: number | undefined): string {
  if (percent === undefined) return "Sidebar width reset to default";
  if (percent === SIDEBAR_PERCENT_NARROW) return "Sidebar width set to minimum";
  return `Sidebar width set to ${percent}%`;
}

class SlateFooter implements Component {
  invalidate(): void {}
  render(): string[] { return []; }
}

export default function piSlate(pi: ExtensionAPI): void {
  const configPath = join(getAgentDir(), "pi-slate.json");
  const loaded = loadConfig(configPath);
  const saveConfig = (next: SlateConfig): void => writeConfig(configPath, { ...next, footer: next.composerMetadata });
  let config = loaded.config;
  setProgressStyle(config.progress ?? "waves");
  // Runtime ownership is fixed until /reload, even when a command saves a new set.
  const selected = [...config.surfaces];
  const owns = (surface: typeof selected[number]): boolean => has(selected, surface);
  const diagnostics = new SlateDiagnostics();
  const requestedClaudeTools = owns("tool-cards") && config.toolStyle !== "default";
  let claudeTools = false;
  if (owns("tool-cards")) {
    installDiff(pi);
    if (requestedClaudeTools && typeof pi.registerToolRenderer === "function") {
      claudeTools = diagnostics.attempt("tool-style", "Slate default cards retained; the optional renderer hook failed.", () => { installToolStyle(pi); return true; }, () => false);
    }
    if (!claudeTools) installRead(pi);
  }
  if (owns("editor")) installPromptPicker(pi, promptShortcutKey(config.shortcuts));
  installExitCommand(pi);
  const sidebar = new Sidebar();
  const images = owns("editor") ? installImagePlaceholders(pi, owns("sidebar") ? sidebar : undefined, () => editorActive()) : undefined;
  const selection = new ComposerSelectionController();
  const skills = new SidebarSkills();
  const mcpFiles = new SidebarMcpFiles();
  let resources: SidebarResources = { skills: [], commands: [], prompts: [], mcp: [] };
  let sessionStartedAt = 0;
  let turnStartedAt: number | undefined;
  let lastTurnMs: number | null = null;
  let dashboardClock: ReturnType<typeof setInterval> | undefined;
  let branchFacts: { leaf?: string | null; counts: ReturnType<typeof sidebarMessageCounts>; usage: ReturnType<typeof sidebarUsage>; perf: ReturnType<typeof branchPerf> } | undefined;
  let inspectingSidebar = false;
  let sidebarYielded = false;
  let sessionEpoch = 0;
  let currentContext: ExtensionContext | undefined;
  let cachedTheme: Theme | undefined;
  // Every ctx accessor throws once the host replaces or reloads the session. Render
  // loops, timers, and microtasks outlive that handoff, so probe before use and treat
  // a stale ctx as absent rather than crashing the host on a captured reference.
  const liveContext = (): ExtensionContext | undefined => {
    const ctx = currentContext;
    if (!ctx) return undefined;
    try { void ctx.mode; } catch {
      currentContext = undefined;
      return undefined;
    }
    return ctx;
  };
  const liveTheme = (): Theme | undefined => {
    const ctx = liveContext();
    if (ctx) cachedTheme = ctx.ui.theme;
    return cachedTheme;
  };
  const markdownHost = pi as unknown as MarkdownTransformerHost;
  if (typeof markdownHost.registerMarkdownTransformer === "function") {
    markdownHost.registerMarkdownTransformer((markdown, context) => {
      const ctx = liveContext();
      if (!ctx || ctx.mode !== "tui") return markdown;
      return decorateCallouts(markdown, createCalloutPalette(ctx.ui.theme), context.availableWidth);
    }, { messageTypes: ["assistant"] });
  }
  let activeEditor: ComposerEditor | undefined;
  let gitBranch: string | null = null;
  let activeTui: TUI | undefined;
  let editorFactory: Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0];
  const editorActive = (): boolean => {
    const ctx = liveContext();
    return owns("editor") && ctx !== undefined && ctx.mode === "tui"
      && (typeof ctx.ui.getEditorComponent !== "function" || ctx.ui.getEditorComponent() === editorFactory);
  };
  let conversations: ReturnType<typeof installConversationBridge> | undefined;
  let chatSurface: ChatSurface | undefined;
  let groupPainter: ToolGroups | undefined;
  const tokenRate = new TokenRateTracker();
  const thinkingDurations = new ThinkingDurations();
  const hiddenThinkingLabel = new HiddenThinkingLabel();
  const thinkingFold = new ThinkingFoldTracker({
    onChange: () => syncThinkingStatus(),
    onComplete: ({ thinking, elapsedMs }) => thinkingDurations.record(thinking, elapsedMs),
  });
  const branch = new GitBranchPoller(pi, (next) => {
    gitBranch = next;
    if (activeTui && activeEditor && editorActive() && activeEditor.needsBranchRepaint()) return requestNecessaryRender(activeTui);
  });
  const contextUsage = new ContextUsageCache();
  let contextEdge: { percent: number | null; window: number | null; estimated: boolean; resources: string } = {
    percent: null, window: null, estimated: false, resources: formatFocusedContextResources(null, false, 0),
  };
  let requestRender = (_force = false) => {};
  let contextRepaintPending = false;
  const updateContextEdge = (next: Pick<typeof contextEdge, "percent" | "window" | "estimated">): void => {
    const label = formatFocusedContextResources(next.percent, next.estimated, resources.mcp.filter(server => server.enabled === true).length);
    contextRepaintPending ||= label !== contextEdge.resources;
    contextEdge = { ...next, resources: label };
    if (!contextRepaintPending || !activeTui || !activeEditor) return;
    try {
      if (editorActive()) contextRepaintPending = activeEditor.needsContextRepaint() && !requestNecessaryRender(activeTui);
    } catch { /* Keep the check pending if the host is temporarily unavailable. */ }
  };

  const thinkingRowState = () => ({ active: thinkingFold.active(), durations: thinkingDurations });
  const decorateThinkingRows = (component: Component, rows: readonly string[]): readonly string[] | undefined => {
    try {
      const view = component as ThinkingView;
      const state = thinkingRowState();
      if (!thinkingRowsKey(view, state)) return rows;
      const theme = liveTheme();
      if (!theme) return undefined;
      const decorated = paintThinkingRows(view, rows, {
        ...state,
        styledLabel: theme.italic(theme.fg("thinkingText", HIDDEN_THINKING_LABEL)),
      });
      // A theme change can leave the native row and styled needle temporarily out of sync.
      return decorated === rows ? undefined : decorated;
    } catch { return undefined; }
  };
  const thinkingDecorationKey = (component: Component): string => thinkingRowsKey(component as ThinkingView, thinkingRowState());
  const groupingActive = () => diagnostics.active("tool-groups", "Consecutive tool cards can be grouped.");

  const syncVisibleMessages = (): void => {
    const ctx = liveContext();
    if ((!owns("transcript") && !claudeTools) || ctx?.mode !== "tui") {
      hiddenThinkingLabel.sync(undefined);
      return;
    }
    const feature = owns("transcript") ? "transcript" : "tool-groups";
    diagnostics.attempt(feature, "Native chat retained; the optional chat adapter failed.", () => {
      const chat = findChatContainer(layoutRootOf(activeTui));
      if (chatSurface?.container !== chat) { chatSurface?.dispose(); chatSurface = undefined; }
      if (!chat) return;
      const options = {
        limit: owns("transcript") ? resolveMessageLength(config.messageLength) : Number.POSITIVE_INFINITY,
        groups: groupPainter,
        decorate: decorateThinkingRows,
        active: () => {
          const ctx = liveContext();
          return Boolean(ctx && typeof ctx.isIdle === "function" && !ctx.isIdle());
        },
        onGroupingFaultChange: (faulted: boolean) => {
          if (faulted) diagnostics.fallback("tool-groups", "Native cards shown while grouping recovers; repeated faults briefly delay retries.");
          else groupingActive();
        },
      };
      if (chatSurface) chatSurface.update(options);
      else chatSurface = new ChatSurface(chat, options);
    }, () => { chatSurface?.dispose(); chatSurface = undefined; });
    hiddenThinkingLabel.sync(ctx.ui, chatSurface ? HIDDEN_THINKING_LABEL : undefined);
    if (owns("transcript")) {
      if (chatSurface) diagnostics.active("transcript", "Display-only message window mounted.");
      else diagnostics.fallback("transcript", "Native transcript retained; no compatible fullscreen chat surface.");
    }
    if (claudeTools) {
      if (!chatSurface || !groupPainter) diagnostics.fallback("tool-groups", "Ungrouped cards retained; no compatible chat surface.");
      else if (!chatSurface.groupingFaulted) groupingActive();
    }
  };

  // A selected split allocates header width; unavailable sidebar hosts stay full-width.
  const columnWidth = (width: number): number => width;

  const syncSidebar = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui" || !ctx.sessionManager || (!owns("sidebar") && !owns("editor")) || (sidebarYielded && !editorActive())) return;
    const { tokens, percent, contextWindow, estimated } = contextUsage.get(ctx);
    if (owns("sidebar") && !sidebarYielded) {
      const leaf = ctx.sessionManager.getLeafId?.();
      if (!branchFacts || leaf === undefined || leaf !== branchFacts.leaf) {
        const entries = ctx.sessionManager.getBranch();
        branchFacts = { leaf, counts: sidebarMessageCounts(entries), usage: sidebarUsage(entries),
          perf: branchPerf(entries) };
      }
      const rate = tokenRate.rate(), model = ctx.model;
      sidebar.setSession({
        id: ctx.sessionManager.getSessionId?.() ?? "",
        name: ctx.sessionManager.getSessionName?.(),
        pid: process.pid, cwd: ctx.cwd, model: modelStatusLabel(model, config.modelDisplay), thinking: ctx.thinkingLevel ?? "—",
        usingOAuth: model ? ctx.modelRegistry.isUsingOAuth?.(model) : undefined,
        tokens, percent, contextWindow, estimated,
        rate: rate > 0 ? rate : null, startedAt: sessionStartedAt, lastTurnMs, turnStartedAt: turnStartedAt ?? null,
        working: typeof ctx.isIdle === "function" && !ctx.isIdle(), ...branchFacts.counts, usage: branchFacts.usage,
        perf: branchFacts.perf,
      });
    }
    updateContextEdge({ percent, window: contextWindow, estimated });
  };
  const refreshResources = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui" || !ctx.sessionManager || (!owns("sidebar") && !owns("editor")) || (sidebarYielded && !editorActive())) return;
    const catalog = diagnostics.attempt("command-catalog", "Previous command catalog retained; the host catalog could not be read.", () => {
      const commands = pi.getCommands();
      const catalog = commandResources(commands);
      skills.discoverCommands(commands);
      diagnostics.active("command-catalog", "Public command and skill catalog available.");
      return catalog;
    }, () => resources);
    const mcp = diagnostics.attempt("mcp-catalog", "Previous MCP declarations retained; the catalog could not be read. Use /mcp for live status.", () => {
      const registered = typeof pi.getMcpServers === "function" ? pi.getMcpServers() : [];
      const snapshot = mcpFiles.snapshot(getAgentDir(), ctx.cwd, typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted(), registered);
      if (snapshot.mcpError) diagnostics.fallback("mcp-catalog", `${snapshot.mcpError}. Check global mcp.json and trusted .pi/mcp.json; use /mcp for validation.`);
      else diagnostics.active("mcp-catalog", "Read-only configured state; Pi owns validation and connections.");
      return snapshot;
    }, () => ({ mcp: resources.mcp, ...(resources.mcpError ? { mcpError: resources.mcpError } : {}) }));
    resources = { commands: catalog.commands, prompts: catalog.prompts, skills: skills.snapshot(), ...mcp };
    if (owns("sidebar") && !sidebarYielded) sidebar.setResources(resources);
    updateContextEdge(contextEdge);
  };
  const stopDashboard = (): void => {
    clearInterval(dashboardClock); dashboardClock = undefined;
  };
  const inspect = (ctx: ExtensionContext, title: string, text: string): void => {
    if (inspectingSidebar || ctx.mode !== "tui") return;
    inspectingSidebar = true;
    void inspectSidebarText(ctx, sidebarText(title), text).catch(() => { try { ctx.ui.notify("Sidebar details unavailable", "warning"); } catch { /* Session UI may be gone. */ } })
      .finally(() => { inspectingSidebar = false; });
  };
  if (owns("sidebar")) {
    pi.on("resources_discover", () => {
      if (liveContext()?.mode === "tui") queueMicrotask(() => {
        diagnostics.attempt("resource-refresh", "Could not refresh resources; Slate will retry on the next discovery.", () => {
          const ctx = liveContext();
          if (ctx?.mode !== "tui") return;
          refreshResources(ctx);
          diagnostics.active("resource-refresh", "Resources refreshed after discovery.");
        }, () => {}, { retry: true });
      });
    });
  }

  const install = (ctx: ExtensionContext): void => {
    try { chatSurface?.dispose(); }
    finally { chatSurface = undefined; hiddenThinkingLabel.sync(undefined); }
    groupPainter = claudeTools ? new ToolGroups(liveTheme, undefined, decorateThinkingRows, thinkingDecorationKey) : undefined;
    diagnostics.reset();
    thinkingDurations.clear();
    if (requestedClaudeTools) {
      if (claudeTools) diagnostics.active("tool-style", "Public tool renderer hook installed.");
      else diagnostics.fallback("tool-style", "Slate default cards retained; the optional renderer hook is unavailable.");
    }
    sessionEpoch += 1; sidebarYielded = false;
    const mountedEpoch = sessionEpoch;
    currentContext = ctx;
    if (ctx.mode === "tui") cachedTheme = ctx.ui.theme;
    const mountedContext = (): ExtensionContext | undefined =>
      mountedEpoch === sessionEpoch ? liveContext() : undefined;
    const notify = (message: string, type: "info" | "warning" | "error"): void => {
      mountedContext()?.ui.notify(message, type);
    };
    conversations?.dispose();
    conversations = ctx.mode === "tui" && owns("editor") ? installConversationBridge(pi, {
      context: liveContext,
      editor: () => editorActive() ? activeEditor : undefined,
      tui: () => activeTui,
      canMount: () => owns("sidebar") && sidebar.splitActive && typeof (activeTui as TUI & { getFocusedComponent?: unknown })?.getFocusedComponent === "function",
      workspaceFocus: component => sidebar.ownsFocus(component),
      replaceChat: view => sidebar.replaceChat(view),
    }) : undefined;
    thinkingFold.stop();
    tokenRate.dispose();
    workingWord = undefined;
    setWaveActive(false);
    if (loaded.error) {
      diagnostics.fallback("configuration", "Slate surfaces disabled because pi-slate.json could not be read or parsed. File preserved; repair it and /reload.");
      ctx.ui.notify(loaded.error, "warning");
    }
    if (ctx.mode !== "tui") return;
    if (owns("tool-cards")) {
      // Only check tools Slate registers. Claude mode styles the native read
      // renderer without owning its registration, so native read is not a loss.
      diagnostics.attempt("tool-ownership", "Host registrations retained; tool ownership could not be inspected.", () => {
        const registeredCards = claudeTools ? ["edit", "write"] : ["edit", "write", "read"];
        const lost = pi.getAllTools().filter((tool) => registeredCards.includes(tool.name)
          && resolve(tool.sourceInfo.path) !== fileURLToPath(import.meta.url));
        if (lost.length) diagnostics.fallback("tool-ownership", `Host registrations retained for ${lost.map((tool) => tool.name).join(", ")}; first registration wins.`);
        else diagnostics.active("tool-ownership", "Selected tool registrations are available.");
      }, () => {});
    }
    if (owns("editor")) branch.start(ctx.cwd);
    sessionStartedAt = Date.now(); turnStartedAt = undefined; lastTurnMs = null; branchFacts = undefined;
    contextUsage.reset();
    contextRepaintPending = false;
    if (owns("editor") || owns("sidebar")) {
      skills.reset([]);
      skills.restore(ctx.sessionManager.getBranch(), ctx.cwd);
      refreshResources(ctx);
      tokenRate.setOnChange(() => { if (thinkingFold.elapsedMs() !== null) syncThinkingStatus(); });
      syncSidebar(ctx);
    }

    if (owns("sidebar")) {
      stopDashboard();
      sidebar.reset();
      sidebar.setThemeProvider(liveTheme);
      sidebar.setFolds(config.sidebarSections);
      sidebar.setResources(resources);
      sidebar.setPreferredWidth(config.sidebarPercent);
      sidebar.setHidden(config.focused === true);
      sidebar.setActions({
        persistFold: (section, expanded) => {
          if (!mountedContext()) return undefined;
          if (loaded.error) { notify(loaded.error, "warning"); return undefined; }
          try {
            const latest = loadConfig(configPath);
            if (latest.error) { notify(latest.error, "warning"); return undefined; }
            const previous = latest.raw.sidebarSections;
            const sections = previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {};
            const raw = { ...latest.raw, sidebarSections: { ...sections, [section]: expanded } };
            writeConfig(configPath, raw);
            const folds = parseSidebarFolds(raw.sidebarSections);
            config = { ...config, sidebarSections: folds }; return folds;
          }
          catch { notify("Could not save sidebar sections", "error"); return undefined; }
        },
        inspect: (title, text) => {
          const target = mountedContext();
          if (target) inspect(target, title, text);
        },
        persistWidth: (percent) => {
          if (!mountedContext()) return;
          try {
            const next = withSidebarPercent(config, percent);
            saveConfig(next);
            config = next;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            notify(`Could not save sidebar width: ${message}`, "error");
          }
        },
        copy: (text) => {
          const target = mountedContext();
          if (target) void copyWithFeedback(activeTui, notify, text);
        },
        openFile: (filePath) => {
          const context = mountedContext();
          if (!context) return;
          void openExternal(resolve(context.cwd, filePath)).then(opened => {
            if (!opened) notify("Could not open file", "error");
          });
        },
      });
      syncSidebar(ctx);
    }
    // belowEditor has no host leading spacer. This factory renders exactly zero rows.
    // It is a TUI handle, not a chrome owner or application bootstrap header.
    if (owns("sidebar") || owns("transcript") || claudeTools) {
      diagnostics.attempt("surface-host", "Native UI retained; the optional surface handle could not be mounted.", () => ctx.ui.setWidget("pi-slate:surface-host", (tui, theme) => {
        activeTui = tui;
        requestRender = (force = false) => tui.requestRender(force);
        queueMicrotask(() => { if (mountedContext()) syncVisibleMessages(); });
        if (owns("sidebar")) {
          const attached = diagnostics.attempt("sidebar", "Native layout retained; the optional sidebar adapter failed.", () => {
            sidebar.attach(tui, theme, () => {
              sidebarYielded = true; stopDashboard();
              diagnostics.fallback("sidebar", "Native layout retained after a later layout owner replaced Slate.");
            }, () => diagnostics.fault("sidebar-view", "Sidebar remains live with full redraws after a view-only redraw failed."));
            return sidebar.splitActive;
          }, () => { sidebar.dispose(); return false; });
          if (attached) diagnostics.active("sidebar", "Sidebar mounted; visibility follows preferences and terminal size.");
          else diagnostics.fallback("sidebar", "Native layout retained; sidebar needs a compatible fullscreen viewport.");
          if (attached && !dashboardClock) {
            let ticks = 0, refreshFaulted = false;
            dashboardClock = setInterval(() => {
              diagnostics.attempt("dashboard", "A dashboard refresh failed; Slate will retry on the next tick.", () => {
                const ctx = liveContext();
                if (!ctx || ctx.mode !== "tui" || !sidebar.splitActive) return;
                if (++ticks % 5 === 0) { refreshResources(ctx); syncSidebar(ctx); }
                else if (ctx.sessionManager.getLeafId() !== branchFacts?.leaf) syncSidebar(ctx);
                sidebar.tick();
                if (refreshFaulted) {
                  diagnostics.active("dashboard", "Background dashboard refresh resumed.");
                  refreshFaulted = false;
                }
              }, () => { refreshFaulted = true; }, { retry: true });
            }, 1000);
            dashboardClock.unref?.();
          }
        }
        return { render: () => [], invalidate() {} };
      }, { placement: "belowEditor" }), () => {});
    }
    if (owns("header")) {
      ctx.ui.setHeader((tui, theme) => {
        requestRender = (force = false) => tui.requestRender(force);
        diagnostics.active("session-notices", "Native notices and conversation content are retained without text-based filtering.");
        return new SlateHeader(theme, liveContext, columnWidth, () => {
          const ctx = liveContext();
          return {
            version: VERSION,
            model: ctx ? modelStatusLabel(ctx.model, config.modelDisplay) : "",
            thinking: ctx?.thinkingLevel ?? "",
          };
        }, () => config.logo ?? "minimal");
      });
    }
    if (owns("footer")) ctx.ui.setFooter(() => new SlateFooter());
    if (owns("editor")) {
      editorFactory = (tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager) => {
        const tuiChanged = Boolean(activeTui && activeTui !== tui);
        if (tuiChanged) conversations?.close();
        const previousDown = tuiChanged ? undefined : activeEditor?.onDownBoundary;
        activeTui = tui;
        selection.dispose();
        images?.detachEditor();
        const minimalEditorTheme: EditorTheme = {
          ...editorTheme,
          borderColor: chromePaint(ctx.ui.theme),
        };
        const metadata = (current: ExtensionContext) => ({
          project: basename(current.cwd) || current.cwd, branch: gitBranch,
          model: current.model, modelDisplay: config.modelDisplay, thinking: current.thinkingLevel,
          footer: config.composerMetadata, showPid: config.showPid === true, theme: current.ui.theme,
          effortBorderColor: config.effortBorderColor === true,
          paddingX: composerPaddingX(config.density),
          working: typeof current.isIdle === "function" && !current.isIdle(),
          workspaceHeader: owns("header"),
          dashboardVisible: sidebar.isVisible(tui.terminal.columns, tui.terminal.rows),
          ...(!sidebar.isVisible(tui.terminal.columns, tui.terminal.rows) ? { context: {
            tokens: formatFocusedContextTokens(contextEdge.percent, tokenRate.rate(), contextEdge.window), resources: contextEdge.resources,
          } } : {}),
        });
        let cachedMetadata = metadata(ctx);
        activeEditor = new ComposerEditor(
          tui,
          minimalEditorTheme,
          keybindings,
          () => {
            const ctx = liveContext();
            if (ctx) cachedMetadata = metadata(ctx);
            return cachedMetadata;
          },
          {
            paddingX: composerPaddingX(config.density),
            autocompleteMaxVisible: 8,
            embedWorkingStatus: true,
          },
        );
        if (previousDown) activeEditor.onDownBoundary = previousDown;
        // Images wrap first so composer-selection stays outermost: select-all
        // followed by backspace must clear the whole prompt before the atomic
        // image-token delete sees the keypress.
        const editor = activeEditor;
        images?.attachEditor(editor, () =>
          // A detached editor has no repaint left to deliver.
          activeEditor !== editor || !mountedContext() || !editorActive() || requestNecessaryRender(tui));
        selection.attach(activeEditor, {
          copy: (text) => mountedContext() ? copyWithFeedback(tui, notify, text) : Promise.resolve(),
          requestRender: () => tui.requestRender(),
          onPasteUnavailable: () => diagnostics.fault("paste-preview", "Native paste tokens retained; the undo-aware range adapter is unavailable."),
        });
        activeTui = tui;
        requestRender = (force = false) => tui.requestRender(force);
        return activeEditor;
      };
      ctx.ui.setEditorComponent(editorFactory);
    }
    requestRender(true);
  };

  const workingWords = createWordPicker();
  let workingWord: string | undefined;
  const syncThinkingStatus = (): void => {
    try {
      const ctx = liveContext();
      if (!ctx || !editorActive() || !workingWord || typeof ctx.ui.setWorkingMessage !== "function") return;
      const elapsed = thinkingFold.elapsedMs();
      const rate = tokenRate.rate();
      const label = elapsed === null ? workingWord : formatLiveThinking(workingWord, elapsed, rate > 0 ? rate : null);
      ctx.ui.setWorkingMessage(ctx.ui.theme.italic(label));
      requestRender();
    } catch {
      // A stale UI context must not turn the interval callback into an uncaught error.
      thinkingFold.stop();
    }
  };

  pi.on("session_start", (_event, ctx) => { install(ctx); });
  pi.on("agent_start", (_event, ctx) => {
    currentContext = ctx;
    if (ctx.mode === "tui" && (owns("sidebar") || editorActive() || owns("transcript"))) {
      turnStartedAt = Date.now(); syncSidebar(ctx);
    }
    if (!editorActive()) return;
    thinkingFold.stop();
    if (activeEditor) {
      workingWord = undefined;
      setWaveActive(true); // Pi's working indicator already schedules frames.
      return;
    }
    workingWord = workingWords.next();
    syncThinkingStatus();
  });
  pi.on("agent_end", (_event, ctx) => {
    currentContext = ctx;
    thinkingFold.stop();
    setWaveActive(false);
    if (turnStartedAt !== undefined) {
      const finishedAt = Date.now();
      lastTurnMs = Math.max(0, finishedAt - turnStartedAt);
      turnStartedAt = undefined;
      if (ctx.mode === "tui") {
        const chat = findChatContainer(layoutRootOf(activeTui));
        chat?.addChild(new TurnCompletion(lastTurnMs, finishedAt, liveTheme));
        syncVisibleMessages();
        requestRender();
      }
    }
    syncSidebar(ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    currentContext = ctx;
    syncSidebar(ctx);
  });
  pi.on("thinking_level_select", (_event, ctx) => {
    currentContext = ctx;
    syncSidebar(ctx);
    requestRender();
  });
  pi.on("message_start", (event, ctx) => {
    currentContext = ctx;
    if (event.message.role === "assistant") {
      thinkingFold.stop();
      if (ctx.mode === "tui" && (owns("editor") || owns("sidebar"))) {
        tokenRate.startMessage();
        syncSidebar(ctx); // Pi has persisted the input that started this request.
      }
    }
  });
  pi.on("message_update", (event, ctx) => {
    currentContext = ctx;
    if (event.message.role !== "assistant") return;
    if (ctx.mode === "tui" && (owns("editor") || owns("sidebar"))) tokenRate.observePartial(estimateAssistantTokens(event.message));
    const chatPainter = ctx.mode === "tui" && (owns("transcript") || claudeTools);
    if ((editorActive() && typeof ctx.ui.setWorkingMessage === "function") || chatPainter) {
      thinkingFold.observe(event.assistantMessageEvent, event.message);
    } else {
      thinkingFold.stop();
    }
  });
  pi.on("message_end", (event, ctx) => {
    currentContext = ctx;
    if (event.message.role === "assistant") {
      thinkingFold.stop();
      if (ctx.mode === "tui" && (owns("editor") || owns("sidebar"))) tokenRate.endMessage();
    } else if (owns("sidebar") && ctx.mode === "tui" && event.message.role === "toolResult") {
      skills.observeNested(event.message.nestedCalls?.calls ?? [], ctx.cwd);
    }
    refreshResources(ctx);
    syncVisibleMessages();
  });
  pi.on("session_info_changed", (_event, ctx) => { currentContext = ctx; syncSidebar(ctx); });
  if (owns("sidebar")) {
    pi.on("before_agent_start", (event, ctx) => {
      if (ctx.mode !== "tui") return;
      if (event.systemPromptOptions?.skills) skills.discover(event.systemPromptOptions.skills);
      if (event.messageType === "user") skills.observePrompt(event.prompt);
      refreshResources(ctx); syncSidebar(ctx);
    });
    pi.on("tool_execution_start", (event, ctx) => {
      if (ctx.mode !== "tui") return;
      skills.readStart(event.toolCallId, event.toolName, event.args, ctx.cwd);
      syncSidebar(ctx); // message_end precedes persistence; the tool starts after it.
    });
    pi.on("tool_execution_end", (event, ctx) => {
      if (ctx.mode !== "tui") return;
      skills.readEnd(event.toolCallId, event.isError);
      refreshResources(ctx);
    });
  }
  pi.on("turn_end", (_event, ctx) => {
    currentContext = ctx;
    syncSidebar(ctx);
  });
  pi.on("agent_settled", (_event, ctx) => {
    currentContext = ctx;
    refreshResources(ctx);
    syncSidebar(ctx);
  });
  pi.on("session_compact", (_event, ctx) => {
    currentContext = ctx;
    contextUsage.reset();
    syncSidebar(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    currentContext = ctx;
    contextUsage.reset();
    thinkingFold.stop();
    if (owns("sidebar") && ctx.mode === "tui") {
      branchFacts = undefined; skills.restore(ctx.sessionManager.getBranch(), ctx.cwd);
      refreshResources(ctx);
    }
    syncSidebar(ctx);
    syncVisibleMessages();
  });
  pi.on("session_shutdown", (_event, ctx) => {
    sessionEpoch += 1;
    workingWord = undefined;
    try {
      setWaveActive(false);
      thinkingFold.stop();
      thinkingDurations.clear();
      tokenRate.dispose();
      selection.dispose();
      images?.dispose();
      stopDashboard();
      mcpFiles.clear();
      branch.dispose();
      chatSurface?.dispose();
      chatSurface = undefined;
      groupPainter = undefined;
      conversations?.dispose();
      conversations = undefined;
      activeTui = undefined;
      sidebar.dispose();
    } finally { hiddenThinkingLabel.sync(undefined); }
    requestRender(true);
    currentContext = undefined;
    if (ctx.mode !== "tui") return;
    // Host chrome has no header/footer ownership getters. /reload resets it;
    // cleanup must not clear a successor's slots (or any unselected surface).
    activeEditor = undefined;
    contextUsage.reset();
    gitBranch = null;
    requestRender = () => {};
  });

  const apply = (next: SlateConfig, message: string, ctx: ExtensionContext): void => {
    if (loaded.error) { ctx.ui.notify(loaded.error, "warning"); return; }
    try {
      saveConfig(next);
      config = next;
      setProgressStyle(next.progress ?? "waves");
      if (owns("sidebar")) {
        sidebar.setPreferredWidth(config.sidebarPercent);
        sidebar.setHidden(config.focused === true);
        sidebar.setFolds(config.sidebarSections);
      }
      activeEditor?.setPaddingX(composerPaddingX(config.density));
      syncVisibleMessages();
      requestRender(true);
      ctx.ui.notify(message, "info");
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Could not save Slate settings: ${messageText}`, "error");
    }
  };

  const pickProgress = async (ctx: ExtensionContext): Promise<ProgressStyle | undefined> => {
    const value = await ctx.ui.select("Progress indicator", PROGRESS_STYLES.map((s) =>
      withCurrent(PROGRESS_LABELS[s], (config.progress ?? "waves") === s)));
    if (!value) return undefined;
    const key = withoutCurrent(value);
    return PROGRESS_STYLES.find((s) => PROGRESS_LABELS[s] === key);
  };

  const pickDensity = async (ctx: ExtensionContext): Promise<SlateConfig["density"] | undefined> => {
    const value = await ctx.ui.select("Density", [
      withCurrent("Comfortable", config.density === "comfortable"),
      withCurrent("Compact", config.density === "compact"),
    ]);
    const key = value ? withoutCurrent(value) : undefined;
    if (key === "Comfortable") return "comfortable";
    if (key === "Compact") return "compact";
    return undefined;
  };

  const pickFooter = async (ctx: ExtensionContext): Promise<SlateConfig["composerMetadata"] | undefined> => {
    const value = await ctx.ui.select("Composer metadata", [
      withCurrent("Standard", config.composerMetadata === "standard"),
      withCurrent("Minimal", config.composerMetadata === "minimal"),
    ]);
    const key = value ? withoutCurrent(value) : undefined;
    if (key === "Standard") return "standard";
    if (key === "Minimal") return "minimal";
    return undefined;
  };

  const applyNamedTheme = (ctx: ExtensionContext, name: string): boolean => {
    const result = ctx.ui.setTheme(name);
    if (!result.success) {
      ctx.ui.notify(result.error ?? `Could not load ${name}. Run /reload first.`, "error");
      return false;
    }
    persistTheme(ctx.cwd, name);
    requestRender(true);
    ctx.ui.notify(`Theme set to ${name === SLATE_NATIVE_THEME ? "system default" : name}`, "info");
    return true;
  };

  const pickTheme = (ctx: ExtensionContext): Promise<void> => selectSlateTheme(ctx, name => applyNamedTheme(ctx, name));

  const pickWidth = async (ctx: ExtensionContext): Promise<{ picked: true; width?: number } | undefined> => {
    const percent = sidebar.preferredWidth ?? config.sidebarPercent;
    const defaultLabel = "Default (20%, up to 40 columns)";
    const narrowLabel = "Narrow (minimum)";
    const mediumLabel = "Medium (30%)";
    const wideLabel = "Wide (40%)";
    const customLabel = percent !== undefined
      && percent !== SIDEBAR_PERCENT_NARROW
      && percent !== SIDEBAR_PERCENT_MEDIUM
      && percent !== SIDEBAR_PERCENT_WIDE
      ? `Custom (${percent}%)`
      : "Custom…";
    const choice = await ctx.ui.select("Sidebar width", [
      withCurrent(defaultLabel, percent === undefined),
      withCurrent(narrowLabel, percent === SIDEBAR_PERCENT_NARROW),
      withCurrent(mediumLabel, percent === SIDEBAR_PERCENT_MEDIUM),
      withCurrent(wideLabel, percent === SIDEBAR_PERCENT_WIDE),
      withCurrent(customLabel, customLabel.startsWith("Custom (")),
    ]);
    if (!choice) return undefined;
    const key = withoutCurrent(choice);
    if (key === defaultLabel) return { picked: true };
    if (key === narrowLabel) return { picked: true, width: SIDEBAR_PERCENT_NARROW };
    if (key === mediumLabel) return { picked: true, width: SIDEBAR_PERCENT_MEDIUM };
    if (key === wideLabel) return { picked: true, width: SIDEBAR_PERCENT_WIDE };
    if (key !== customLabel) return undefined;
    const typed = await ctx.ui.input(
      "Sidebar percent",
      percent !== undefined && percent > 0 ? String(percent) : "30",
    );
    if (!typed) return undefined;
    const parsed = parseSidebarWidthArg(typed);
    if (!parsed.ok || parsed.percent === undefined) {
      ctx.ui.notify(SLATE_USAGE, "error");
      return undefined;
    }
    return { picked: true, width: parsed.percent };
  };

  const pickMessageLength = async (ctx: ExtensionContext): Promise<{ picked: true; value?: number | "all" } | undefined> => {
    const current = config.messageLength;
    const defaultLabel = `Default (${MESSAGE_LENGTH_DEFAULT})`;
    const shortLabel = String(MESSAGE_LENGTH_SHORT);
    const longLabel = String(MESSAGE_LENGTH_LONG);
    const allLabel = "All";
    const customLabel = typeof current === "number"
      && current !== MESSAGE_LENGTH_DEFAULT
      && current !== MESSAGE_LENGTH_SHORT
      && current !== MESSAGE_LENGTH_LONG
      ? `Custom (${current})`
      : "Custom…";
    const choice = await ctx.ui.select("Message length", [
      withCurrent(defaultLabel, current === undefined || current === MESSAGE_LENGTH_DEFAULT),
      withCurrent(shortLabel, current === MESSAGE_LENGTH_SHORT),
      withCurrent(longLabel, current === MESSAGE_LENGTH_LONG),
      withCurrent(allLabel, current === "all"),
      withCurrent(customLabel, customLabel.startsWith("Custom (")),
    ]);
    if (!choice) return undefined;
    const key = withoutCurrent(choice);
    if (key === defaultLabel) return { picked: true };
    if (key === shortLabel) return { picked: true, value: MESSAGE_LENGTH_SHORT };
    if (key === longLabel) return { picked: true, value: MESSAGE_LENGTH_LONG };
    if (key === allLabel) return { picked: true, value: "all" };
    if (key !== customLabel) return undefined;
    const typed = await ctx.ui.input(
      "Visible messages",
      typeof current === "number" ? String(current) : String(MESSAGE_LENGTH_DEFAULT),
    );
    if (!typed) return undefined;
    const parsed = parseMessageLengthArg(typed);
    if (!parsed.ok) {
      ctx.ui.notify(SLATE_USAGE, "error");
      return undefined;
    }
    return { picked: true, value: parsed.value };
  };

  /** Open a file or URL with the platform opener; false on a non-zero exit or a failed launch. */
  const openExternal = async (target: string): Promise<boolean> => {
    const { command, args } = openExternalArgs(target);
    try { return (await pi.exec(command, args, { timeout: 5000 })).code === 0; } catch { return false; }
  };

  /** Open the issue tracker; only a failure needs feedback, and only to the session that asked. */
  const openIssues = async (ctx: ExtensionContext): Promise<void> => {
    const owner = sessionEpoch;
    const opened = await openExternal(SLATE_ISSUES_URL);
    if (opened || owner !== sessionEpoch) return;
    try { void ctx.mode; } catch { return; } // An invalidated context belongs to a finished session.
    ctx.ui.notify(`Open ${SLATE_ISSUES_URL}`, "error");
  };

  const applyFocused = (ctx: ExtensionContext, value?: boolean): void => {
    const on = value ?? !config.focused;
    apply({ ...config, focused: on }, on ? "Focused mode on" : "Focused mode off", ctx);
  };

  // Pi 1.4 has no built-in /theme command; core theme selection lives in /settings.
  pi.registerCommand("theme", {
    description: "Choose a theme with live preview",
    handler: async (args, ctx) => {
      if (args.trim() && args.trim() !== "slate") { ctx.ui.notify("Usage: /theme (Pi themes are also available in /settings)", "info"); return; }
      await pickTheme(ctx);
    },
  });

  pi.registerCommand("logo", {
    description: "Toggle the header logo, or set original/minimal",
    getArgumentCompletions: logoArgumentCompletions,
    handler: async (args, ctx) => {
      const parsed = parseLogoArgs(args);
      if (!parsed.ok) {
        ctx.ui.notify(LOGO_USAGE, "error");
        return;
      }
      const logo = parsed.value ?? ((config.logo ?? "minimal") === "minimal" ? "original" : "minimal");
      apply({ ...config, logo }, logo === "minimal" ? "Header logo set to minimal (classic white Pi)" : "Header logo set to original", ctx);
    },
  });

  pi.registerCommand("slate", {
    description: "Diagnostics, surfaces, density, composer metadata, sidebar, focused mode, PID display, effort border color, progress indicator, message length, theme, or report a bug",
    getArgumentCompletions: slateArgumentCompletions,
    handler: async (args, ctx) => {
      const parsed = parseSlateArgs(args);
      if (!parsed.ok) {
        ctx.ui.notify(SLATE_USAGE, "error");
        return;
      }

      let kind = parsed.kind;
      if (kind === "menu") {
        const setting = await ctx.ui.select("Slate", ["Surfaces", "Density", "Composer metadata", "Sidebar width", "Focused", "PID display", "Effort border color", "Progress indicator", "Message length", "Theme", "Diagnostics", "Report a bug"]);
        if (setting === "Surfaces") {
          const names = await ctx.ui.input("Surfaces (names separated by spaces, full, or none; reload required)", formatSurfaces(config.surfaces));
          if (!names) return;
          const choice = parseSlateArgs(`surfaces ${names === "full" || names === "none" ? names : `set ${names}`}`);
          if (!choice.ok || choice.kind !== "surfaces" || choice.value === undefined) { ctx.ui.notify(SLATE_USAGE, "error"); return; }
          apply({ ...config, surfaces: choice.value }, `Slate surfaces saved: ${formatSurfaces(choice.value)}. Run /reload (reload required).`, ctx);
          return;
        }
        if (setting === "Effort border color") kind = "effort-border";
        else if (setting === "Density") kind = "density";
        else if (setting === "Composer metadata") kind = "footer";
        else if (setting === "Sidebar width") kind = "width-menu";
        else if (setting === "Focused") kind = "focused";
        else if (setting === "PID display") kind = "pid";
        else if (setting === "Progress indicator") kind = "progress";
        else if (setting === "Message length") kind = "message-length-menu";
        else if (setting === "Theme") kind = "theme-menu";
        else if (setting === "Diagnostics") kind = "diagnostics";
        else if (setting === "Report a bug") kind = "bug";
        else return;
      }

      if (kind === "diagnostics") {
        const report = diagnostics.report(SLATE_VERSION, VERSION, selected);
        if (ctx.mode === "tui") inspect(ctx, "Slate diagnostics", report);
        else ctx.ui.notify(report, "info");
        return;
      }

      if (parsed.kind === "surfaces") {
        if (parsed.value === undefined) {
          ctx.ui.notify(`Slate surfaces: ${formatSurfaces(config.surfaces)}. Active: ${formatSurfaces(selected)}. Use /slate surfaces set <names>, full, or none; changes require /reload.`, "info");
        } else {
          apply({ ...config, surfaces: parsed.value }, `Slate surfaces saved: ${formatSurfaces(parsed.value)}. Run /reload (reload required).`, ctx);
        }
        return;
      }

      if (kind === "density") {
        const density = (parsed.kind === "density" ? parsed.value : undefined) ?? await pickDensity(ctx);
        if (!density) return;
        apply({ ...config, density }, `Density set to ${density}`, ctx);
        return;
      }

      if (kind === "footer") {
        const footer = (parsed.kind === "footer" ? parsed.value : undefined) ?? await pickFooter(ctx);
        if (!footer) return;
        apply({ ...config, composerMetadata: footer }, `Composer metadata set to ${footer}`, ctx);
        return;
      }

      if (kind === "progress") {
        const progress = (parsed.kind === "progress" ? parsed.value : undefined) ?? await pickProgress(ctx);
        if (!progress) return;
        apply({ ...config, progress }, `Progress indicator set to ${PROGRESS_LABELS[progress]}`, ctx);
        return;
      }

      if (kind === "focused") {
        applyFocused(ctx, parsed.kind === "focused" ? parsed.value : undefined);
        return;
      }

      if (kind === "pid") {
        const on = parsed.kind === "pid" && parsed.value !== undefined ? parsed.value : !config.showPid;
        apply({ ...config, showPid: on }, on ? "PID display on" : "PID display off", ctx);
        return;
      }

      if (kind === "effort-border") {
        const on = parsed.kind === "effort-border" && parsed.value !== undefined ? parsed.value : config.effortBorderColor !== true;
        apply(
          { ...config, effortBorderColor: on },
          on ? "Effort border color on" : "Effort border color off",
          ctx,
        );
        return;
      }

      if (parsed.kind === "width") {
        apply(withSidebarPercent({ ...config, focused: false }, parsed.width), widthMessage(parsed.width), ctx);
        return;
      }

      if (parsed.kind === "message-length") {
        apply(withMessageLength(config, parsed.value), messageLengthMessage(parsed.value), ctx);
        return;
      }

      if (kind === "message-length" || kind === "message-length-menu") {
        const picked = await pickMessageLength(ctx);
        if (!picked) return;
        apply(withMessageLength(config, picked.value), messageLengthMessage(picked.value), ctx);
        return;
      }

      if (kind === "bug") {
        await openIssues(ctx);
        return;
      }

      if (kind === "theme-menu") {
        await pickTheme(ctx);
        return;
      }

      const picked = await pickWidth(ctx);
      if (!picked) return;
      apply(withSidebarPercent({ ...config, focused: false }, picked.width), widthMessage(picked.width), ctx);
    },
  });
}
