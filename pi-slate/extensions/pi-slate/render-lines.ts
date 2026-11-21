// Snapshot producer-owned arrays when keeping them across renders.
export function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a === b || (a.length === b.length && a.every((line, i) => line === b[i]));
}
