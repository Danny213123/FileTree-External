// Minimal Model Context Protocol (MCP) integration for the agent.
//
// At run start the ChatPanel calls `buildMcpRuntime(servers)`. For each enabled
// server we discover its tools (via the Electron MAIN bridge), turn them into
// the agent's ToolDef shape, and split them into read-only vs side-effecting
// sets (the latter are approval-gated like other mutating tools). The returned
// `runTool` dispatches a namespaced tool call back to the owning server.
//
// Tool names are namespaced `mcp__<server>__<tool>` so they can never collide
// with the built-in tools; the orchestrator's runtime treats any non-built-in
// name as an MCP call and routes it through `runMcpTool` (see RunContext).

import type { ToolDef } from "../agent";
import type { McpServerConfig } from "../aiSettings";
import { mcpListTools, mcpCallTool, type McpToolInfo } from "../../api/client";

export interface McpRuntime {
  /** Read-only MCP tools, merged into the Search agent's tool list. */
  readTools: ToolDef[];
  /** Side-effecting MCP tools (gated), merged into the Action agent's tool list. */
  writeTools: ToolDef[];
  /** Names the runtime must force an approval card for (the write tools). */
  approvalNames: string[];
  /** Execute a namespaced MCP tool call. */
  runTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

const EMPTY: McpRuntime = { readTools: [], writeTools: [], approvalNames: [], runTool: async () => ({ ok: false, error: "no MCP tool" }) };

// OpenAI/Anthropic restrict tool names to [a-zA-Z0-9_-]{1,64}. Sanitize and cap.
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
}

function namespacedName(serverId: string, tool: string): string {
  return `mcp__${sanitize(serverId)}__${sanitize(tool)}`.slice(0, 64);
}

// A tool is treated as side-effecting (and thus approval-gated) when its
// annotations say it is NOT read-only or IS destructive. Absent annotations we
// default to read-only (the common case for query/lookup MCP servers).
function isWriteTool(info: McpToolInfo): boolean {
  const a = info.annotations;
  if (!a) return false;
  if (a.destructiveHint) return true;
  if (a.readOnlyHint === false) return true;
  return false;
}

export async function buildMcpRuntime(servers: McpServerConfig[]): Promise<McpRuntime> {
  const enabled = (servers ?? []).filter((s) => s.enabled && (s.transport === "http" ? s.url : s.command));
  if (!enabled.length) return EMPTY;

  const readTools: ToolDef[] = [];
  const writeTools: ToolDef[] = [];
  const approvalNames: string[] = [];
  // namespaced tool name → { server, originalName }
  const registry = new Map<string, { server: McpServerConfig; original: string }>();

  await Promise.all(
    enabled.map(async (server) => {
      let list;
      try {
        list = await mcpListTools(server);
      } catch {
        return;
      }
      if (!list.ok || !list.tools?.length) return;
      for (const info of list.tools) {
        if (!info?.name) continue;
        const name = namespacedName(server.id, info.name);
        if (registry.has(name)) continue;
        registry.set(name, { server, original: info.name });
        const def: ToolDef = {
          type: "function",
          function: {
            name,
            description: `[MCP:${server.name || server.id}] ${info.description || info.name}`.slice(0, 1024),
            parameters:
              info.inputSchema && typeof info.inputSchema === "object"
                ? (info.inputSchema as ToolDef["function"]["parameters"])
                : { type: "object", properties: {} },
          },
        };
        if (isWriteTool(info)) { writeTools.push(def); approvalNames.push(name); }
        else readTools.push(def);
      }
    }),
  );

  if (!registry.size) return EMPTY;

  const runTool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const entry = registry.get(name);
    if (!entry) return { ok: false, error: `unknown MCP tool ${name}` };
    const res = await mcpCallTool(entry.server, entry.original, args);
    if (!res.ok) return { ok: false, error: res.error || "MCP tool failed" };
    return { ok: true, content: res.content ?? "" };
  };

  return { readTools, writeTools, approvalNames, runTool };
}
