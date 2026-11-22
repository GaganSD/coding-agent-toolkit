type LabelSetter = (label?: string) => void;
type LabelUI = { setHiddenThinkingLabel?: LabelSetter };
type AppliedLabel = { setter: LabelSetter; label: string };
const owners = new WeakMap<LabelUI, AppliedLabel>();

/** Setting the host label rebuilds the transcript. Track successful writes and their UI owners. */
export class HiddenThinkingLabel {
  private readonly applied = new Map<LabelUI, AppliedLabel>();

  sync(ui: LabelUI | undefined, label?: string): void {
    for (const [previous, applied] of this.applied) {
      if (previous === ui && label !== undefined) continue;
      try {
        if (owners.get(previous) === applied) {
          const setter = previous.setHiddenThinkingLabel;
          if (typeof setter !== "function") continue; // Retry if the hook returns.
          if (setter === applied.setter) setter.call(previous, undefined);
          if (owners.get(previous) === applied) owners.delete(previous);
        }
        this.applied.delete(previous);
      } catch { /* Leave the clear pending without blocking a new UI. */ }
    }
    if (!ui || label === undefined) return;
    try {
      const setter = ui.setHiddenThinkingLabel;
      const applied = this.applied.get(ui);
      if (typeof setter !== "function" || (applied?.setter === setter && applied.label === label && owners.get(ui) === applied)) return;
      setter.call(ui, label);
      const next = { setter, label };
      owners.set(ui, next);
      this.applied.set(ui, next);
    } catch { /* Optional presentation hook; retry on the next sync. */ }
  }
}
