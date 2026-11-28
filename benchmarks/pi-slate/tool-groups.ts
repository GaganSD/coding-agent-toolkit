// Run: node --experimental-strip-types benchmarks/pi-slate/tool-groups.ts
import { performance } from "node:perf_hooks";
import { Container, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { ToolGroups } from "../../pi-slate/extensions/pi-slate/tool-groups.ts";
const theme = { fg: (_: string, value: string) => value, bold: (value: string) => value } as Theme;
for (const count of [100, 1000]) {
  const chat = new Container();
  let renders = 0;
  for (let i = 0; i < count; i++) chat.addChild({
    toolName: "bash", toolCallId: `tool-${i}`, expanded: false, isPartial: false,
    result: { isError: false, content: [] }, setExpanded() {},
    render() { renders++; return ["", "✓ Bash (pwd)", "  └ 1 line · 0ms"]; }, invalidate() {},
  } as Component);
  const groups = new ToolGroups(() => theme, () => "ctrl+o to expand");
  for (let i = 0; i < 20; i++) groups.render(chat.children, 100);
  renders = 0;
  const samples: number[] = [];
  for (let i = 0; i < 100; i++) {
    const start = performance.now(); groups.render(chat.children, 100); samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  console.log(JSON.stringify({ children: count, medianMs: samples[50], p95Ms: samples[95], rendersPerChildPerFrame: renders / count / samples.length }));
}
