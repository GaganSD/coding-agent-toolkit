export function openExternalArgs(target: string, platform = process.platform): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [target] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", `"${target}"`] };
  return { command: "xdg-open", args: [target] };
}
