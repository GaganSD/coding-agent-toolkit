// The release allowlist and CI test partition. New publishable packages belong here.
export const packages = {
  "pi-ask": {
    name: "@gagansd/pi-ask", tests: "tests",
    integration: ["contract.test.ts", "ask-tool.test.ts", "answer-commands.test.ts", "config-store.test.ts", "token-ceiling.test.ts", "background.test.ts", "background-panel.test.ts", "background-delivery.test.ts", "background-recovery.test.ts", "journal-failure.test.ts", "expiry-flow.test.ts", "skip-cancel-flow.test.ts"],
    commands: ["answer", "ask-settings", "ask-panel"], tools: ["ask_user"],
    hooks: ["session_start", "session_tree", "session_shutdown", "session_compact", "turn_end", "agent_before_settle", "agent_settled", "agent_start"],
  },
  "pi-automode": {
    name: "@gagansd/pi-automode", tests: "tests",
    integration: ["gate.test.ts", "host-smoke.test.ts", "launcher.test.ts", "ui.test.ts"],
    commands: ["automode"], tools: [], hooks: ["tool_call"],
  },
  "pi-slate": {
    name: "pi-slate", tests: "tests",
    integration: ["install-defaults.test.ts", "sidebar-split.test.ts", "diff-tools.test.ts", "read.test.ts", "tool-groups.test.ts", "tool-style-load.test.ts", "host-compat.test.mjs", "git-diff.test.ts", "package.test.mjs", "prompts.test.ts"],
    commands: ["slate", "prompts", "exit"], tools: [],
  },
  "pi-subagents": {
    name: "@gagansd/pi-subagents", tests: "test",
    integration: ["integration.test.ts", "extension.test.ts", "extension-native.test.ts", "native.test.ts", "package.test.ts"],
    commands: ["subagents"], tools: ["subagent"],
  },
  "pi-web-search": {
    name: "@gagansd/pi-web-search", tests: "tests",
    integration: ["integration.test.ts", "registration.test.ts", "native-sdk.test.ts", "package/package-content.test.ts", "package/validation.test.ts"],
    commands: ["web-search"], tools: ["search"],
  },
};

export function packageConfig(path) {
  if (!Object.hasOwn(packages, path)) throw new Error(`Unknown package: ${path}`);
  return packages[path];
}
