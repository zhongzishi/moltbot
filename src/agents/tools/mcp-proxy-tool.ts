/**
 * Generic MCP Proxy Tool - routes calls to any MCP server project.
 *
 * This tool provides a unified interface for Moltbot to access multiple MCP
 * projects without overwhelming the agent with hundreds of individual tools.
 *
 * Usage:
 * 1. List available tools: { project: "tapwize", action: "list_tools" }
 * 2. Call a tool: { project: "tapwize", action: "call", tool: "tapwize_health_check", args: {} }
 */

import { Type } from "@sinclair/typebox";

import { getChildLogger } from "../../logging.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

const logger = getChildLogger({ module: "mcp-proxy" });

// Available projects - add new projects here
const MCP_PROJECTS = {
  tapwize: {
    name: "TapWize",
    description: "系统诊断、错误日志、健康检查、SocialPilot 管理",
  },
  "content-matrix": {
    name: "Content Matrix",
    description: "内容源管理、AI分析、小红书发布、发布队列",
  },
} as const;

type ProjectId = keyof typeof MCP_PROJECTS;

const PROJECT_IDS = Object.keys(MCP_PROJECTS) as ProjectId[];

const McpProxyToolSchema = Type.Object({
  project: stringEnum(PROJECT_IDS, {
    description: "目标项目: tapwize=系统诊断, content-matrix=内容管理",
  }),
  action: stringEnum(["list_tools", "call"], {
    description: "list_tools=查看可用工具, call=调用工具",
  }),
  tool: Type.Optional(Type.String({ description: "要调用的工具名称 (action=call 时必填)" })),
  args: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "工具参数 (action=call 时使用)",
    }),
  ),
});

export type McpProxyToolOptions = {
  url?: string;
  apiKey?: string;
};

type McpResponse = {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
};

type McpTool = {
  name: string;
  description?: string;
  inputSchema?: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
};

type McpToolsListResult = {
  tools: McpTool[];
};

type McpToolCallResult = {
  content: Array<{ type: string; text: string }>;
};

/**
 * MCP HTTP/SSE client for tool listing and calling.
 */
async function mcpRequest(
  url: string,
  apiKey: string,
  method: "tools/list" | "tools/call",
  params?: Record<string, unknown>,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const sseUrl = url.endsWith("/sse") ? url : `${url}/sse`;
  const baseUrl = url.replace(/\/mcp\/sse$/, "").replace(/\/sse$/, "");
  const controller = new AbortController();

  try {
    // Connect to SSE endpoint
    const sseResponse = await fetch(sseUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "text/event-stream",
      },
      signal: controller.signal,
    });

    if (!sseResponse.ok) {
      return { ok: false, error: `SSE connection failed: ${sseResponse.status}` };
    }

    const reader = sseResponse.body?.getReader();
    if (!reader) {
      return { ok: false, error: "No response body" };
    }

    const decoder = new TextDecoder();
    let sessionEndpoint = "";
    let buffer = "";
    let requestSent = false;

    const readLoop = async (): Promise<McpResponse | null> => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i];
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (data.startsWith("/mcp/messages?sessionId=")) {
              sessionEndpoint = data;
            } else if (data.startsWith("{")) {
              try {
                const parsed = JSON.parse(data) as McpResponse;
                if (parsed.jsonrpc && (parsed.result !== undefined || parsed.error)) {
                  return parsed;
                }
              } catch {
                // Not valid JSON
              }
            }
          }
        }
        buffer = lines[lines.length - 1];

        // Send request once we have session endpoint
        if (sessionEndpoint && !requestSent) {
          requestSent = true;
          const messagesUrl = `${baseUrl}${sessionEndpoint}`;
          fetch(messagesUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method,
              params: params ?? {},
            }),
          }).catch(() => {
            // Errors come through SSE
          });
        }
      }
      return null;
    };

    const timeoutPromise = new Promise<McpResponse | null>((_, reject) => {
      setTimeout(() => reject(new Error("MCP request timeout")), 30000);
    });

    const response = await Promise.race([readLoop(), timeoutPromise]);
    controller.abort();

    if (!response) {
      return { ok: false, error: "No response received" };
    }

    if (response.error) {
      return { ok: false, error: response.error.message };
    }

    return { ok: true, result: response.result };
  } catch (err) {
    controller.abort();
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`MCP request failed: ${message}`);
    return { ok: false, error: message };
  }
}

/**
 * Format tools list for display
 */
function formatToolsList(tools: McpTool[], project: string): string {
  const projectInfo = MCP_PROJECTS[project as ProjectId];
  const lines = [`## ${projectInfo?.name ?? project} 可用工具 (${tools.length} 个)`, ""];

  // Group tools by prefix
  const grouped = new Map<string, McpTool[]>();
  for (const tool of tools) {
    const prefix = tool.name.split("_").slice(0, 2).join("_");
    if (!grouped.has(prefix)) {
      grouped.set(prefix, []);
    }
    grouped.get(prefix)!.push(tool);
  }

  for (const [prefix, groupTools] of grouped) {
    lines.push(`### ${prefix}`);
    for (const tool of groupTools) {
      const desc = tool.description?.split("\n")[0] ?? "";
      lines.push(`- **${tool.name}**: ${desc}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function createMcpProxyTool(options?: McpProxyToolOptions): AnyAgentTool {
  const projectList = PROJECT_IDS.map((id) => `- ${id}: ${MCP_PROJECTS[id].description}`).join(
    "\n",
  );

  return {
    label: "MCP",
    name: "mcp",
    description: `调用 MCP 服务，访问各项目工具。

## 可用项目
${projectList}

## 使用方式
1. 先用 list_tools 查看项目有哪些工具:
   { "project": "content-matrix", "action": "list_tools" }

2. 再用 call 调用具体工具:
   { "project": "content-matrix", "action": "call", "tool": "matrix_list_sources", "args": {} }

## 示例
- 查看内容源: { "project": "content-matrix", "action": "call", "tool": "matrix_list_sources", "args": {} }
- 系统诊断: { "project": "tapwize", "action": "call", "tool": "tapwize_diagnose_issue", "args": { "issue_description": "登录失败" } }
- 健康检查: { "project": "tapwize", "action": "call", "tool": "tapwize_health_check", "args": {} }`,
    parameters: McpProxyToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const project = readStringParam(params, "project", { required: true });
      const action = readStringParam(params, "action", { required: true });

      if (!PROJECT_IDS.includes(project as ProjectId)) {
        return jsonResult({
          ok: false,
          error: `未知项目: ${project}。可用项目: ${PROJECT_IDS.join(", ")}`,
        });
      }

      const url = options?.url ?? process.env.MCP_PROXY_URL ?? "http://mcp-server:18080/mcp/sse";
      const apiKey =
        options?.apiKey ?? process.env.MCP_PROXY_API_KEY ?? process.env.TAPWIZE_MCP_API_KEY ?? "";

      if (!apiKey) {
        return jsonResult({
          ok: false,
          error: "MCP 未配置。请设置 MCP_PROXY_API_KEY 环境变量。",
        });
      }

      if (action === "list_tools") {
        const result = await mcpRequest(url, apiKey, "tools/list");
        if (!result.ok) {
          return jsonResult(result);
        }

        const toolsResult = result.result as McpToolsListResult;
        const tools = toolsResult.tools ?? [];

        // Filter tools by project prefix
        const projectPrefix = project === "content-matrix" ? "matrix_" : `${project}_`;
        const projectTools = tools.filter((t) => t.name.startsWith(projectPrefix));

        return jsonResult({
          ok: true,
          project,
          toolCount: projectTools.length,
          tools: projectTools.map((t) => ({
            name: t.name,
            description: t.description?.split("\n")[0] ?? "",
          })),
          formatted: formatToolsList(projectTools, project),
        });
      }

      if (action === "call") {
        const toolName = readStringParam(params, "tool");
        if (!toolName) {
          return jsonResult({
            ok: false,
            error: "action=call 时必须提供 tool 参数",
          });
        }

        const toolArgs = (params.args as Record<string, unknown>) ?? {};

        const result = await mcpRequest(url, apiKey, "tools/call", {
          name: toolName,
          arguments: toolArgs,
        });

        if (!result.ok) {
          return jsonResult(result);
        }

        const callResult = result.result as McpToolCallResult;
        const textContent = callResult.content?.find((c) => c.type === "text")?.text;

        return jsonResult({
          ok: true,
          project,
          tool: toolName,
          result: textContent ?? callResult,
        });
      }

      return jsonResult({
        ok: false,
        error: `未知操作: ${action}。可用: list_tools, call`,
      });
    },
  };
}
