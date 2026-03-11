/**
 * Claude Code CLI Tool for heavy brain tasks.
 * Spawns Claude Code CLI for complex coding tasks like refactoring, debugging, implementation.
 */

import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { getChildLogger } from "../../logging.js";
import { type AnyAgentTool, readStringParam } from "./common.js";

const logger = getChildLogger({ module: "claude-code-tool" });

export type ClaudeCodeToolConfig = {
  /** Path to claude CLI (default: "claude") */
  cliPath?: string;
  /** Working directory for Claude Code */
  workspaceDir?: string;
  /** Timeout in milliseconds (default: 300000 = 5 min) */
  timeoutMs?: number;
  /** Allowed tools for Claude Code (optional restriction) */
  allowedTools?: string[];
};

const ClaudeCodeToolSchema = Type.Object({
  /** The coding task/prompt to send to Claude Code */
  prompt: Type.String({ description: "The coding task to execute" }),
  /** Optional working directory override */
  workingDir: Type.Optional(Type.String({ description: "Working directory for the task" })),
  /** Optional context files to include */
  contextFiles: Type.Optional(
    Type.String({ description: "Comma-separated list of file paths for context" }),
  ),
  /** Whether to allow file edits (default: true) */
  allowEdits: Type.Optional(Type.Boolean({ description: "Allow Claude Code to edit files" })),
});

/**
 * Execute Claude Code CLI and capture output
 */
async function executeClaudeCode(
  prompt: string,
  options: {
    cliPath: string;
    workingDir: string;
    timeoutMs: number;
    contextFiles?: string[];
    allowEdits?: boolean;
  },
): Promise<{ success: boolean; output: string; exitCode: number }> {
  return new Promise((resolve) => {
    const args = ["--print", "--output-format", "text"];

    // Add context files if provided
    if (options.contextFiles && options.contextFiles.length > 0) {
      for (const file of options.contextFiles) {
        args.push("--context", file);
      }
    }

    // Add the prompt
    args.push(prompt);

    logger.info(
      { cliPath: options.cliPath, args, workingDir: options.workingDir },
      "Spawning Claude Code CLI",
    );

    const child = spawn(options.cliPath, args, {
      cwd: options.workingDir,
      env: {
        ...process.env,
        // Ensure non-interactive mode
        CI: "true",
        TERM: "dumb",
      },
      timeout: options.timeoutMs,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("error", (error) => {
      logger.error({ error }, "Claude Code CLI spawn error");
      resolve({
        success: false,
        output: `Failed to spawn Claude Code: ${error.message}`,
        exitCode: -1,
      });
    });

    child.on("close", (code) => {
      const exitCode = code ?? 0;
      const output = stdout || stderr || "(no output)";
      logger.info({ exitCode, outputLength: output.length }, "Claude Code CLI completed");
      resolve({
        success: exitCode === 0,
        output,
        exitCode,
      });
    });

    // Handle timeout
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        resolve({
          success: false,
          output: `Claude Code timed out after ${options.timeoutMs}ms`,
          exitCode: -2,
        });
      }
    }, options.timeoutMs);
  });
}

/**
 * Check if Claude Code CLI is available
 */
async function checkClaudeCodeAvailable(cliPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cliPath, ["--version"], {
      timeout: 5000,
    });

    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/**
 * Create the Claude Code CLI tool for agent use.
 */
export function createClaudeCodeTool(config?: ClaudeCodeToolConfig): AnyAgentTool {
  const cliPath = config?.cliPath ?? "claude";
  const defaultWorkspace = config?.workspaceDir ?? process.cwd();
  const timeoutMs = config?.timeoutMs ?? 300000; // 5 minutes

  return {
    label: "ClaudeCode",
    name: "claude_code",
    description: `Execute complex coding tasks using Claude Code CLI (the "heavy brain").

USE THIS TOOL FOR:
- Implementing new features
- Refactoring code
- Debugging complex issues
- Writing tests
- Code review with fixes
- Multi-file changes
- Architecture changes

DO NOT USE FOR:
- Simple questions
- Status checks
- Lookups/searches
- General conversation

PARAMETERS:
- prompt: The coding task description
- workingDir: Optional working directory
- contextFiles: Optional comma-separated file paths for context
- allowEdits: Whether to allow file edits (default: true)

EXAMPLES:

1. Implement a feature:
{
  "prompt": "Add a logout button to the header component that clears the session and redirects to /login"
}

2. Debug an issue:
{
  "prompt": "Fix the race condition in the cache invalidation logic in src/cache/manager.ts",
  "contextFiles": "src/cache/manager.ts,src/cache/types.ts"
}

3. Refactor code:
{
  "prompt": "Refactor the authentication module to use the repository pattern",
  "workingDir": "/path/to/project"
}`,
    parameters: ClaudeCodeToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const prompt = readStringParam(params, "prompt", { required: true, label: "prompt" });
      const workingDir = readStringParam(params, "workingDir") ?? defaultWorkspace;
      const contextFilesRaw = readStringParam(params, "contextFiles");
      const contextFiles = contextFilesRaw
        ? contextFilesRaw
            .split(",")
            .map((f) => f.trim())
            .filter(Boolean)
        : undefined;

      logger.info({ prompt: prompt.slice(0, 100), workingDir }, "claude-code-tool: execute");

      // Check if CLI is available
      const isAvailable = await checkClaudeCodeAvailable(cliPath);
      if (!isAvailable) {
        return {
          content: [
            {
              type: "text",
              text: `Claude Code CLI not available at "${cliPath}". Please ensure Claude Code is installed and in PATH.`,
            },
          ],
          details: { error: "cli_not_available", cliPath },
        };
      }

      // Execute Claude Code
      const result = await executeClaudeCode(prompt, {
        cliPath,
        workingDir,
        timeoutMs,
        contextFiles,
      });

      if (result.success) {
        return {
          content: [
            {
              type: "text",
              text: `Claude Code completed successfully:\n\n${result.output}`,
            },
          ],
          details: {
            success: true,
            exitCode: result.exitCode,
            workingDir,
          },
        };
      } else {
        return {
          content: [
            {
              type: "text",
              text: `Claude Code execution failed (exit code: ${result.exitCode}):\n\n${result.output}`,
            },
          ],
          details: {
            success: false,
            exitCode: result.exitCode,
            workingDir,
          },
        };
      }
    },
  };
}
