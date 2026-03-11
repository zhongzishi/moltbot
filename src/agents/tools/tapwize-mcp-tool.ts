/**
 * TapWize MCP tool - calls TapWize MCP server via HTTP/SSE protocol.
 */

import { Type } from "@sinclair/typebox";

import { getChildLogger } from "../../logging.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

const logger = getChildLogger({ module: "tapwize-mcp" });

const TAPWIZE_ACTIONS = [
  "diagnose_issue",
  "health_check",
  "get_system_metrics",
  "get_error_logs",
  "check_service_status",
] as const;

const TapwizeMcpToolSchema = Type.Object({
  action: stringEnum(TAPWIZE_ACTIONS),
  // For diagnose_issue
  issue_description: Type.Optional(
    Type.String({ description: "Description of the issue to diagnose" }),
  ),
  include_health_check: Type.Optional(
    Type.Boolean({ description: "Include health check in diagnosis" }),
  ),
  include_recent_errors: Type.Optional(
    Type.Boolean({ description: "Include recent errors in diagnosis" }),
  ),
  // For get_error_logs
  limit: Type.Optional(Type.Number({ description: "Number of items to return" })),
});

export type TapwizeMcpToolOptions = {
  url?: string;
  apiKey?: string;
};

type McpToolCallResponse = {
  jsonrpc: string;
  id: number;
  result?: {
    content: Array<{ type: string; text: string }>;
  };
  error?: { code: number; message: string };
};

/**
 * Simple MCP HTTP/SSE client that establishes SSE connection and calls tools.
 * Keeps SSE connection alive while making the tool call.
 */
async function callMcpTool(
  url: string,
  apiKey: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const sseUrl = url.endsWith("/sse") ? url : `${url}/sse`;
  const baseUrl = url.replace(/\/mcp\/sse$/, "").replace(/\/sse$/, "");
  const controller = new AbortController();

  try {
    // Step 1: Connect to SSE endpoint (keep alive)
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

    // Read SSE events to get session endpoint
    const decoder = new TextDecoder();
    let sessionEndpoint = "";
    let buffer = "";
    let toolCallSent = false;

    const readLoop = async (): Promise<McpToolCallResponse | null> => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events
        const lines = buffer.split("\n");
        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i];
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (data.startsWith("/mcp/messages?sessionId=")) {
              sessionEndpoint = data;
            } else if (data.startsWith("{")) {
              // Try to parse JSON response
              try {
                const parsed = JSON.parse(data) as McpToolCallResponse;
                if (parsed.jsonrpc && (parsed.result || parsed.error)) {
                  return parsed; // Got result, return it
                }
              } catch {
                // Not JSON, ignore
              }
            }
          }
        }
        buffer = lines[lines.length - 1];

        // Once we have session endpoint, make the tool call
        if (sessionEndpoint && !toolCallSent) {
          toolCallSent = true;
          const messagesUrl = `${baseUrl}${sessionEndpoint}`;
          // Don't await - let it run while we continue reading SSE
          fetch(messagesUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: toolName, arguments: args },
            }),
          }).catch(() => {
            // Errors will come through SSE
          });
        }
      }
      return null;
    };

    // Set timeout for entire operation
    const timeoutPromise = new Promise<McpToolCallResponse | null>((_, reject) => {
      setTimeout(() => reject(new Error("MCP call timeout")), 30000);
    });

    const toolResult = await Promise.race([readLoop(), timeoutPromise]);

    // Cleanup
    controller.abort();

    if (!toolResult) {
      return { ok: false, error: "No response received" };
    }

    if (toolResult.error) {
      return { ok: false, error: toolResult.error.message };
    }

    const textContent = toolResult.result?.content?.find(
      (c: { type: string; text: string }) => c.type === "text",
    )?.text;
    return { ok: true, result: textContent ?? toolResult.result };
  } catch (err) {
    controller.abort();
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`MCP call failed: ${message}`);
    return { ok: false, error: message };
  }
}

export function createTapwizeMcpTool(options?: TapwizeMcpToolOptions): AnyAgentTool {
  return {
    label: "TapWize",
    name: "tapwize",
    description: `Query TapWize system for diagnostics and metrics.

ACTIONS:
- diagnose_issue: AI-assisted issue diagnosis (issue_description required)
- health_check: Check system health status
- get_system_metrics: Get system metrics (stores, merchants, etc.)
- get_error_logs: Get recent error logs (limit optional)
- check_service_status: Check external service status

EXAMPLES:
1. Diagnose issue: { "action": "diagnose_issue", "issue_description": "用户无法登录" }
2. Health check: { "action": "health_check" }
3. Get error logs: { "action": "get_error_logs", "limit": 10 }`,
    parameters: TapwizeMcpToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      const url = options?.url ?? process.env.TAPWIZE_MCP_URL ?? "http://mcp-tapwize:18080/mcp/sse";
      const apiKey =
        options?.apiKey ??
        process.env.TAPWIZE_MCP_API_KEY ??
        "c60c2628e11e444c2befa186fe1fa9b8d2244b01a97b4c5660609c75fe883eab";

      if (!url || !apiKey) {
        return jsonResult({
          ok: false,
          error: "TapWize MCP not configured. Set TAPWIZE_MCP_URL and TAPWIZE_MCP_API_KEY.",
        });
      }

      const toolArgs: Record<string, unknown> = { response_format: "markdown" };

      switch (action) {
        case "diagnose_issue": {
          const issueDesc = readStringParam(params, "issue_description");
          if (!issueDesc) {
            return jsonResult({
              ok: false,
              error: "issue_description required for diagnose_issue",
            });
          }
          toolArgs.issue_description = issueDesc;
          if (typeof params.include_health_check === "boolean") {
            toolArgs.include_health_check = params.include_health_check;
          }
          if (typeof params.include_recent_errors === "boolean") {
            toolArgs.include_recent_errors = params.include_recent_errors;
          }
          const result = await callMcpTool(url, apiKey, "tapwize_diagnose_issue", toolArgs);
          return jsonResult(result);
        }

        case "health_check": {
          const result = await callMcpTool(url, apiKey, "tapwize_health_check", toolArgs);
          return jsonResult(result);
        }

        case "get_system_metrics": {
          const result = await callMcpTool(url, apiKey, "tapwize_get_system_metrics", toolArgs);
          return jsonResult(result);
        }

        case "get_error_logs": {
          if (typeof params.limit === "number") {
            toolArgs.limit = Math.floor(params.limit);
          }
          const result = await callMcpTool(url, apiKey, "tapwize_get_error_logs", toolArgs);
          return jsonResult(result);
        }

        case "check_service_status": {
          const result = await callMcpTool(url, apiKey, "tapwize_check_service_status", toolArgs);
          return jsonResult(result);
        }

        default:
          return jsonResult({ ok: false, error: `Unknown action: ${action}` });
      }
    },
  };
}
