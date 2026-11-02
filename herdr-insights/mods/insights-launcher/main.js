// Composed beside Herdr's original tabs mod; never copies or patches its code.
import { View, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, run, spaces, theme } from "herdr";

const TAB = { name: "Insights", mod: "insights" };

/** One Insights tab per space: show it if it exists, otherwise create it. */
function showInsights() {
  const active = spaces().find((space) => space.active);
  const tabIds = new Set(active?.tabs.map((tab) => tab.id) ?? []);
  const open = panes().find((pane) => pane.mod === TAB.mod && tabIds.has(pane.tab));
  if (open) return run("tab.select", { id: open.tab });
  return run("tab.new", TAB);
}

export default class InsightsLauncher extends View {
  render() {
    const t = theme();
    return h_flex().size_full().pr(10).items_center()
      .bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().id("insights-open").h(26).px(8).gap(5).flex_none()
        .items_center().rounded(6).text_size(12).bg(t.chrome).text_color(t.muted)
        .hover((style) => style.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
        .on_click(() => showInsights())
        .child(svg("mods/insights-launcher/insights.svg").size(14))
        .child("Insights"));
  }
}
