import type { Theme } from "@earendil-works/pi-coding-agent";

export const plainTheme = { fg: (_token: string, text: string) => text, bold: (text: string) => text, style: (text: string) => text } as unknown as Theme;
