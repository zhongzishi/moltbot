import fs from "node:fs";
import path from "node:path";
import { CONFIG_PATH, type HookMappingConfig, type HooksConfig } from "../config/config.js";
import { buildResponseFormatPrompt } from "../hooks/hook-response-format.js";
import { importFileModule, resolveFunctionModuleExport } from "../hooks/module-loader.js";
import {
  extractCardId,
  formatActionMessage,
  isActionBySelf,
  isInterestingAction,
  type TrelloWebhookPayload,
} from "../hooks/trello-ops.js";
import type { HookMessageChannel } from "./hooks.js";

// Trello member ID of the owner - skip notifications for self-actions
const TRELLO_OWNER_ID = "6136d01536ab5143671ab605";

export type HookMappingResolved = {
  id: string;
  matchPath?: string;
  matchSource?: string;
  action: "wake" | "agent";
  wakeMode?: "now" | "next-heartbeat";
  name?: string;
  agentId?: string;
  sessionKey?: string;
  messageTemplate?: string;
  textTemplate?: string;
  deliver?: boolean;
  allowUnsafeExternalContent?: boolean;
  channel?: HookMessageChannel;
  to?: string;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
  transform?: HookMappingTransformResolved;
};

export type HookMappingTransformResolved = {
  modulePath: string;
  exportName?: string;
};

export type HookMappingContext = {
  payload: Record<string, unknown>;
  headers: Record<string, string>;
  url: URL;
  path: string;
};

export type HookAction =
  | {
      kind: "wake";
      text: string;
      mode: "now" | "next-heartbeat";
    }
  | {
      kind: "agent";
      message: string;
      name?: string;
      agentId?: string;
      wakeMode: "now" | "next-heartbeat";
      sessionKey?: string;
      deliver?: boolean;
      allowUnsafeExternalContent?: boolean;
      channel?: HookMessageChannel;
      to?: string;
      model?: string;
      thinking?: string;
      timeoutSeconds?: number;
    };

export type HookMappingResult =
  | { ok: true; action: HookAction }
  | { ok: true; action: null; skipped: true }
  | { ok: false; error: string };

const hookPresetMappings: Record<string, HookMappingConfig[]> = {
  gmail: [
    {
      id: "gmail",
      match: { path: "gmail" },
      action: "agent",
      wakeMode: "now",
      name: "Gmail",
      deliver: true,
      // Transform handled by builtinGmailTransform
    },
  ],
  trello: [
    {
      id: "trello",
      match: { path: "trello" },
      action: "agent",
      wakeMode: "now",
      name: "Trello",
      deliver: true,
      // Transform handled by builtinTrelloTransform
    },
  ],
};

const transformCache = new Map<string, HookTransformFn>();

type HookTransformResult = Partial<{
  kind: HookAction["kind"];
  text: string;
  mode: "now" | "next-heartbeat";
  message: string;
  agentId: string;
  wakeMode: "now" | "next-heartbeat";
  name: string;
  sessionKey: string;
  deliver: boolean;
  allowUnsafeExternalContent: boolean;
  channel: HookMessageChannel;
  to: string;
  model: string;
  thinking: string;
  timeoutSeconds: number;
}> | null;

type HookTransformFn = (
  ctx: HookMappingContext,
) => HookTransformResult | Promise<HookTransformResult>;

export function resolveHookMappings(
  hooks?: HooksConfig,
  opts?: { configDir?: string },
): HookMappingResolved[] {
  const presets = hooks?.presets ?? [];
  const gmailAllowUnsafe = hooks?.gmail?.allowUnsafeExternalContent;
  const mappings: HookMappingConfig[] = [];
  if (hooks?.mappings) {
    mappings.push(...hooks.mappings);
  }
  for (const preset of presets) {
    const presetMappings = hookPresetMappings[preset];
    if (!presetMappings) {
      continue;
    }
    if (preset === "gmail" && typeof gmailAllowUnsafe === "boolean") {
      mappings.push(
        ...presetMappings.map((mapping) => ({
          ...mapping,
          allowUnsafeExternalContent: gmailAllowUnsafe,
        })),
      );
      continue;
    }
    mappings.push(...presetMappings);
  }
  if (mappings.length === 0) {
    return [];
  }

  const configDir = path.resolve(opts?.configDir ?? path.dirname(CONFIG_PATH));
  const transformsRootDir = path.join(configDir, "hooks", "transforms");
  const transformsDir = resolveOptionalContainedPath(
    transformsRootDir,
    hooks?.transformsDir,
    "Hook transformsDir",
  );

  return mappings.map((mapping, index) => normalizeHookMapping(mapping, index, transformsDir));
}

export async function applyHookMappings(
  mappings: HookMappingResolved[],
  ctx: HookMappingContext,
): Promise<HookMappingResult | null> {
  if (mappings.length === 0) {
    return null;
  }
  for (const mapping of mappings) {
    if (!mappingMatches(mapping, ctx)) {
      continue;
    }

    // Built-in Trello transform
    if (mapping.id === "trello") {
      const trelloResult = builtinTrelloTransform(ctx);
      if (trelloResult === null) {
        return { ok: true, action: null, skipped: true };
      }
      return {
        ok: true,
        action: {
          kind: "agent",
          message: trelloResult.message ?? "",
          name: trelloResult.name,
          wakeMode: trelloResult.wakeMode ?? "now",
          sessionKey: trelloResult.sessionKey ?? `hook:trello:${Date.now()}`,
          deliver: trelloResult.deliver ?? mapping.deliver,
        },
      };
    }

    // Built-in Gmail transform
    if (mapping.id === "gmail") {
      const gmailResult = builtinGmailTransform(ctx);
      if (gmailResult === null) {
        return { ok: true, action: null, skipped: true };
      }
      return {
        ok: true,
        action: {
          kind: "agent",
          message: gmailResult.message ?? "",
          name: gmailResult.name,
          wakeMode: gmailResult.wakeMode ?? "now",
          sessionKey: gmailResult.sessionKey ?? `hook:gmail:${Date.now()}`,
          deliver: gmailResult.deliver ?? mapping.deliver,
          allowUnsafeExternalContent: mapping.allowUnsafeExternalContent,
        },
      };
    }

    const base = buildActionFromMapping(mapping, ctx);
    if (!base.ok) {
      return base;
    }

    let override: HookTransformResult = null;
    if (mapping.transform) {
      const transform = await loadTransform(mapping.transform);
      override = await transform(ctx);
      if (override === null) {
        return { ok: true, action: null, skipped: true };
      }
    }

    if (!base.action) {
      return { ok: true, action: null, skipped: true };
    }
    const merged = mergeAction(base.action, override, mapping.action);
    if (!merged.ok) {
      return merged;
    }
    return merged;
  }
  return null;
}

function builtinTrelloTransform(ctx: HookMappingContext): HookTransformResult {
  const payload = ctx.payload as unknown as TrelloWebhookPayload;

  // Validate payload structure
  if (!payload?.action?.type || !payload?.model?.id) {
    return null; // Skip invalid payloads
  }

  // Skip uninteresting actions
  if (!isInterestingAction(payload.action)) {
    return null;
  }

  // Skip self-actions (user's own operations)
  if (isActionBySelf(payload, TRELLO_OWNER_ID)) {
    return null;
  }

  const message = formatActionMessage(payload);
  const cardId = extractCardId(payload);
  const actionType = payload.action.type;
  const boardId = payload.model.id;

  // Build session key based on card (if available) or board
  const sessionKey = cardId ? `hook:trello:card:${cardId}` : `hook:trello:board:${boardId}`;

  // Build system prompt based on action type
  const responseFormat = buildResponseFormatPrompt("trello");

  const mcpHint = `
## 可用工具

### mcp - MCP 服务调用
通过 mcp 工具调用 TapWize 系统诊断功能:
- 诊断问题: mcp(project="tapwize", action="call", tool="tapwize_diagnose_issue", args={"issue_description": "问题描述"})
- 健康检查: mcp(project="tapwize", action="call", tool="tapwize_health_check", args={})
- 错误日志: mcp(project="tapwize", action="call", tool="tapwize_get_error_logs", args={})
- 系统指标: mcp(project="tapwize", action="call", tool="tapwize_get_system_metrics", args={})

### trello - Trello 卡片操作
- trello add_comment: 在卡片上添加评论（需要 card_id 和 text）
`;

  let systemContext = "";
  if (actionType === "commentCard") {
    systemContext = `
你收到了一个 Trello 卡片上的新评论。请根据评论内容类型采取不同行动：
${responseFormat}

## 如果是 Bug 报告：
1. 使用 mcp 工具诊断问题: mcp(project="tapwize", action="call", tool="tapwize_diagnose_issue", args={"issue_description": "问题描述"})
2. 使用 mcp 工具查看错误日志: mcp(project="tapwize", action="call", tool="tapwize_get_error_logs", args={})
3. 分析完成后，使用 trello add_comment 在卡片上回复：
   - 简要说明你发现的问题原因
   - 表示"已收到反馈，问题正在处理中"

## 如果是新需求/功能请求：
1. 使用 mcp 工具了解系统状态: mcp(project="tapwize", action="call", tool="tapwize_get_system_metrics", args={})
2. 分析需求的可行性和影响范围
3. 直接向我报告分析结果（不需要使用任何工具发送，你的回复会自动通知我）
   - 报告内容包括：需求概述、技术分析、建议方案、预估影响
4. 不需要在 Trello 上回复

## 如果无法判断类型：
先使用 mcp 工具收集信息，然后根据分析结果决定行动。

${mcpHint}
当前卡片 ID: ${cardId || "未知"}
看板 ID: ${boardId}
`;
  } else if (actionType === "createCard") {
    systemContext = `
Trello 看板上创建了新卡片。请根据卡片内容类型采取不同行动：
${responseFormat}

## 如果是 Bug 报告：
1. 使用 mcp 工具诊断: mcp(project="tapwize", action="call", tool="tapwize_diagnose_issue", args={"issue_description": "问题描述"})
2. 使用 mcp 工具查看错误: mcp(project="tapwize", action="call", tool="tapwize_get_error_logs", args={})
3. 使用 trello add_comment 回复卡片：说明问题原因 + "问题已记录，即将修复"

## 如果是新需求/功能请求：
1. 使用 mcp 工具了解系统: mcp(project="tapwize", action="call", tool="tapwize_get_system_metrics", args={})
2. 分析需求可行性
3. 直接向我报告分析结果（你的回复会自动通知我）
   - 报告格式：需求概述 → 技术分析 → 建议方案 → 影响评估

${mcpHint}
当前卡片 ID: ${cardId || "未知"}
看板 ID: ${boardId}
`;
  } else if (actionType === "updateCard") {
    systemContext = `
Trello 卡片状态发生了变化。简单通知我这个变化即可。
${responseFormat}
当前卡片 ID: ${cardId || "未知"}
看板 ID: ${boardId}
`;
  }

  return {
    message: systemContext + "\n\n" + message,
    sessionKey,
    name: `Trello: ${actionType}`,
    deliver: true, // Always notify user
    wakeMode: "now" as const,
  };
}

type GmailMessage = {
  id?: string;
  from?: string;
  subject?: string;
  snippet?: string;
  body?: string;
};

type GmailPayload = {
  messages?: GmailMessage[];
};

function builtinGmailTransform(ctx: HookMappingContext): HookTransformResult {
  const payload = ctx.payload as unknown as GmailPayload;

  // Validate payload structure
  if (!payload?.messages?.length) {
    return null; // Skip if no messages
  }

  const msg = payload.messages[0];
  if (!msg) return null;

  const messageId = msg.id ?? `${Date.now()}`;
  const from = msg.from ?? "未知发件人";
  const subject = msg.subject ?? "(无主题)";
  const snippet = msg.snippet ?? "";
  const body = msg.body ?? "";

  const responseFormat = buildResponseFormatPrompt("gmail");

  const systemContext = `
你收到了一封新邮件，请分析邮件内容并采取适当行动。
${responseFormat}
## 邮件信息
- **发件人**: ${from}
- **主题**: ${subject}

## 处理指南
1. 如果是需要回复的邮件，总结邮件内容并建议回复要点
2. 如果是通知类邮件，简要总结关键信息
3. 如果是垃圾邮件或营销邮件，可以简单标注忽略
4. 如果邮件涉及紧急事项，突出提醒

## 邮件内容
${snippet}
${body ? `\n详细内容:\n${body}` : ""}
`;

  return {
    message: systemContext,
    sessionKey: `hook:gmail:${messageId}`,
    name: `Gmail: ${subject.substring(0, 30)}`,
    deliver: true,
    wakeMode: "now" as const,
  };
}

function normalizeHookMapping(
  mapping: HookMappingConfig,
  index: number,
  transformsDir: string,
): HookMappingResolved {
  const id = mapping.id?.trim() || `mapping-${index + 1}`;
  const matchPath = normalizeMatchPath(mapping.match?.path);
  const matchSource = mapping.match?.source?.trim();
  const action = mapping.action ?? "agent";
  const wakeMode = mapping.wakeMode ?? "now";
  const transform = mapping.transform
    ? {
        modulePath: resolveContainedPath(transformsDir, mapping.transform.module, "Hook transform"),
        exportName: mapping.transform.export?.trim() || undefined,
      }
    : undefined;

  return {
    id,
    matchPath,
    matchSource,
    action,
    wakeMode,
    name: mapping.name,
    agentId: mapping.agentId?.trim() || undefined,
    sessionKey: mapping.sessionKey,
    messageTemplate: mapping.messageTemplate,
    textTemplate: mapping.textTemplate,
    deliver: mapping.deliver,
    allowUnsafeExternalContent: mapping.allowUnsafeExternalContent,
    channel: mapping.channel,
    to: mapping.to,
    model: mapping.model,
    thinking: mapping.thinking,
    timeoutSeconds: mapping.timeoutSeconds,
    transform,
  };
}

function mappingMatches(mapping: HookMappingResolved, ctx: HookMappingContext) {
  if (mapping.matchPath) {
    if (mapping.matchPath !== normalizeMatchPath(ctx.path)) {
      return false;
    }
  }
  if (mapping.matchSource) {
    const source = typeof ctx.payload.source === "string" ? ctx.payload.source : undefined;
    if (!source || source !== mapping.matchSource) {
      return false;
    }
  }
  return true;
}

function buildActionFromMapping(
  mapping: HookMappingResolved,
  ctx: HookMappingContext,
): HookMappingResult {
  if (mapping.action === "wake") {
    const text = renderTemplate(mapping.textTemplate ?? "", ctx);
    return {
      ok: true,
      action: {
        kind: "wake",
        text,
        mode: mapping.wakeMode ?? "now",
      },
    };
  }
  const message = renderTemplate(mapping.messageTemplate ?? "", ctx);
  return {
    ok: true,
    action: {
      kind: "agent",
      message,
      name: renderOptional(mapping.name, ctx),
      agentId: mapping.agentId,
      wakeMode: mapping.wakeMode ?? "now",
      sessionKey: renderOptional(mapping.sessionKey, ctx),
      deliver: mapping.deliver,
      allowUnsafeExternalContent: mapping.allowUnsafeExternalContent,
      channel: mapping.channel,
      to: renderOptional(mapping.to, ctx),
      model: renderOptional(mapping.model, ctx),
      thinking: renderOptional(mapping.thinking, ctx),
      timeoutSeconds: mapping.timeoutSeconds,
    },
  };
}

function mergeAction(
  base: HookAction,
  override: HookTransformResult,
  defaultAction: "wake" | "agent",
): HookMappingResult {
  if (!override) {
    return validateAction(base);
  }
  const kind = override.kind ?? base.kind ?? defaultAction;
  if (kind === "wake") {
    const baseWake = base.kind === "wake" ? base : undefined;
    const text = typeof override.text === "string" ? override.text : (baseWake?.text ?? "");
    const mode = override.mode === "next-heartbeat" ? "next-heartbeat" : (baseWake?.mode ?? "now");
    return validateAction({ kind: "wake", text, mode });
  }
  const baseAgent = base.kind === "agent" ? base : undefined;
  const message =
    typeof override.message === "string" ? override.message : (baseAgent?.message ?? "");
  const wakeMode =
    override.wakeMode === "next-heartbeat" ? "next-heartbeat" : (baseAgent?.wakeMode ?? "now");
  return validateAction({
    kind: "agent",
    message,
    wakeMode,
    name: override.name ?? baseAgent?.name,
    agentId: override.agentId ?? baseAgent?.agentId,
    sessionKey: override.sessionKey ?? baseAgent?.sessionKey,
    deliver: typeof override.deliver === "boolean" ? override.deliver : baseAgent?.deliver,
    allowUnsafeExternalContent:
      typeof override.allowUnsafeExternalContent === "boolean"
        ? override.allowUnsafeExternalContent
        : baseAgent?.allowUnsafeExternalContent,
    channel: override.channel ?? baseAgent?.channel,
    to: override.to ?? baseAgent?.to,
    model: override.model ?? baseAgent?.model,
    thinking: override.thinking ?? baseAgent?.thinking,
    timeoutSeconds: override.timeoutSeconds ?? baseAgent?.timeoutSeconds,
  });
}

function validateAction(action: HookAction): HookMappingResult {
  if (action.kind === "wake") {
    if (!action.text?.trim()) {
      return { ok: false, error: "hook mapping requires text" };
    }
    return { ok: true, action };
  }
  if (!action.message?.trim()) {
    return { ok: false, error: "hook mapping requires message" };
  }
  return { ok: true, action };
}

async function loadTransform(transform: HookMappingTransformResolved): Promise<HookTransformFn> {
  const cacheKey = `${transform.modulePath}::${transform.exportName ?? "default"}`;
  const cached = transformCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const mod = await importFileModule({ modulePath: transform.modulePath });
  const fn = resolveTransformFn(mod, transform.exportName);
  transformCache.set(cacheKey, fn);
  return fn;
}

function resolveTransformFn(mod: Record<string, unknown>, exportName?: string): HookTransformFn {
  const candidate = resolveFunctionModuleExport<HookTransformFn>({
    mod,
    exportName,
    fallbackExportNames: ["default", "transform"],
  });
  if (!candidate) {
    throw new Error("hook transform module must export a function");
  }
  return candidate;
}

function resolvePath(baseDir: string, target: string): string {
  if (!target) {
    return path.resolve(baseDir);
  }
  return path.isAbsolute(target) ? path.resolve(target) : path.resolve(baseDir, target);
}

function escapesBase(baseDir: string, candidate: string): boolean {
  const relative = path.relative(baseDir, candidate);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function safeRealpathSync(candidate: string): string | null {
  try {
    const nativeRealpath = fs.realpathSync.native as ((path: string) => string) | undefined;
    return nativeRealpath ? nativeRealpath(candidate) : fs.realpathSync(candidate);
  } catch {
    return null;
  }
}

function resolveExistingAncestor(candidate: string): string | null {
  let current = path.resolve(candidate);
  while (true) {
    if (fs.existsSync(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function resolveContainedPath(baseDir: string, target: string, label: string): string {
  const base = path.resolve(baseDir);
  const trimmed = target?.trim();
  if (!trimmed) {
    throw new Error(`${label} module path is required`);
  }
  const resolved = resolvePath(base, trimmed);
  if (escapesBase(base, resolved)) {
    throw new Error(`${label} module path must be within ${base}: ${target}`);
  }

  // Block symlink escapes for existing path segments while preserving current
  // behavior for not-yet-created files.
  const baseRealpath = safeRealpathSync(base);
  const existingAncestor = resolveExistingAncestor(resolved);
  const existingAncestorRealpath = existingAncestor ? safeRealpathSync(existingAncestor) : null;
  if (
    baseRealpath &&
    existingAncestorRealpath &&
    escapesBase(baseRealpath, existingAncestorRealpath)
  ) {
    throw new Error(`${label} module path must be within ${base}: ${target}`);
  }
  return resolved;
}

function resolveOptionalContainedPath(
  baseDir: string,
  target: string | undefined,
  label: string,
): string {
  const trimmed = target?.trim();
  if (!trimmed) {
    return path.resolve(baseDir);
  }
  return resolveContainedPath(baseDir, trimmed, label);
}

function normalizeMatchPath(raw?: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
}

function renderOptional(value: string | undefined, ctx: HookMappingContext) {
  if (!value) {
    return undefined;
  }
  const rendered = renderTemplate(value, ctx).trim();
  return rendered ? rendered : undefined;
}

function renderTemplate(template: string, ctx: HookMappingContext) {
  if (!template) {
    return "";
  }
  return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, expr: string) => {
    const value = resolveTemplateExpr(expr.trim(), ctx);
    if (value === undefined || value === null) {
      return "";
    }
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    return JSON.stringify(value);
  });
}

function resolveTemplateExpr(expr: string, ctx: HookMappingContext) {
  if (expr === "path") {
    return ctx.path;
  }
  if (expr === "now") {
    return new Date().toISOString();
  }
  if (expr.startsWith("headers.")) {
    return getByPath(ctx.headers, expr.slice("headers.".length));
  }
  if (expr.startsWith("query.")) {
    return getByPath(
      Object.fromEntries(ctx.url.searchParams.entries()),
      expr.slice("query.".length),
    );
  }
  if (expr.startsWith("payload.")) {
    return getByPath(ctx.payload, expr.slice("payload.".length));
  }
  return getByPath(ctx.payload, expr);
}

// Block traversal into prototype-chain properties on attacker-controlled
// webhook payloads.  Mirrors the same blocklist used by config-paths.ts
// for config path traversal.
const BLOCKED_PATH_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function getByPath(input: Record<string, unknown>, pathExpr: string): unknown {
  if (!pathExpr) {
    return undefined;
  }
  const parts: Array<string | number> = [];
  const re = /([^.[\]]+)|(\[(\d+)\])/g;
  let match = re.exec(pathExpr);
  while (match) {
    if (match[1]) {
      parts.push(match[1]);
    } else if (match[3]) {
      parts.push(Number(match[3]));
    }
    match = re.exec(pathExpr);
  }
  let current: unknown = input;
  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof part === "number") {
      if (!Array.isArray(current)) {
        return undefined;
      }
      current = current[part] as unknown;
      continue;
    }
    if (BLOCKED_PATH_KEYS.has(part)) {
      return undefined;
    }
    if (typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
