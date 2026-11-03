import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Isolated read-only host adapter. Never imports the MCP client or resolves credentials. */
export type SidebarMcpHost = {
  validate(name: string, value: unknown): unknown;
  namespace(name: string): string;
  projectOverrides: boolean;
  stripBom: boolean;
};

/** Version only selects legacy parsing exceptions; capabilities determine availability. */
function hostParsing(version: string): { projectOverrides: boolean; stripBom: boolean } {
  if (version === "0.99.0" || version === "1.0.0") return { projectOverrides: false, stripBom: false };
  const release = /^1\.(\d+)\.(\d+)$/.exec(version);
  const minor = release ? Number(release[1]) : Number.NaN;
  const patch = release ? Number(release[2]) : Number.NaN;
  // 1.0.4+ and the released 1.1–1.3 minors merge project overrides and reject a BOM. 1.4+ strips it.
  if ((minor === 0 && patch >= 4) || (minor >= 1 && minor < 4)) return { projectOverrides: true, stripBom: false };
  return { projectOverrides: true, stripBom: true };
}

export async function loadSidebarMcpHost(packageDir: string, version: string): Promise<SidebarMcpHost | undefined> {
  try {
    const { projectOverrides, stripBom } = hostParsing(version);
    const native = await import(pathToFileURL(join(packageDir, "dist/core/mcp-servers.js")).href) as {
      validateMcpServerConfig?: SidebarMcpHost["validate"];
      mcpNamespace?: SidebarMcpHost["namespace"];
    };
    if (typeof native.validateMcpServerConfig !== "function") return undefined;
    if (projectOverrides && typeof native.mcpNamespace !== "function") return undefined;
    return { validate: native.validateMcpServerConfig,
      namespace: projectOverrides ? native.mcpNamespace! : name => name, projectOverrides, stripBom };
  } catch { return undefined; }
}
