import { Container, type Component } from "@earendil-works/pi-tui";

const CHAT_RENDERER = Symbol("pi-slate.chat-renderer");
const views = new WeakMap<Container, { owner: object; children: () => Component[] }>();

/** A display projection never changes the host's authoritative children or message state. */
export function chatViewChildren(container: Container): Component[] {
  return views.get(container)?.children() ?? container.children;
}
export function installChatView(container: Container, children: () => Component[]): () => void {
  const owner = {};
  views.set(container, { owner, children });
  return () => { if (views.get(container)?.owner === owner) views.delete(container); };
}
export function markChatRenderer<T extends Container["render"]>(render: T, consumesView: () => boolean = () => true): T {
  return Object.assign(render, { [CHAT_RENDERER]: consumesView });
}
export function consumesChatView(render: Container["render"]): boolean {
  const capability = (render as { [CHAT_RENDERER]?: () => boolean })[CHAT_RENDERER];
  return typeof capability === "function" && capability();
}
/** Unknown render owners are preserved, not bypassed. Our adapters explicitly share the view contract. */
export function compatibleChatRenderer(render: Container["render"]): boolean {
  return render === Container.prototype.render || typeof (render as { [CHAT_RENDERER]?: unknown })[CHAT_RENDERER] === "function";
}
