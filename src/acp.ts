import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ACP client: drives `devin acp` (Agent Client Protocol, stdio JSON-RPC).
// Wire shape mirrored from the sesame-link bridge
// (~/projects/devartslab/sesame-link-runbook/bridge/devin-pi-bridge.mjs):
// initialize -> authenticate (meta.api_key) -> session/new -> session/prompt,
// session/update notifications carry streamed text and tool calls, and
// session/request_permission asks the client before each tool call.

const API_KEY_PATTERN = /windsurf_api_key\s*=\s*"(?<key>[^"]+)"/u;

const DEVIN_BIN =
  process.env.DEVIN_BIN ?? path.join(os.homedir(), ".local", "bin", "devin");
const CREDENTIALS =
  process.env.DEVIN_CREDENTIALS ??
  path.join(os.homedir(), ".local", "share", "devin", "credentials.toml");

const apiKey = (): string => {
  if (process.env.DEVIN_API_KEY) {
    return process.env.DEVIN_API_KEY;
  }
  const toml = fs.readFileSync(CREDENTIALS, "utf8");
  const key = toml.match(API_KEY_PATTERN)?.groups?.key;
  if (!key) {
    throw new Error(
      "No windsurf_api_key in devin credentials.toml. Run `devin auth login` or set DEVIN_API_KEY."
    );
  }
  return key;
};

export interface StationResult {
  /** stopReason reported by session/prompt. */
  stopReason?: string;
  /** The station's full streamed reply text. */
  text: string;
  /** Tool names the station used, in first-use order. */
  tools: string[];
}

interface PendingCall {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
}

/**
 * One Devin agent session in its own `devin acp` process: a fresh context per
 * station, matching the eve pipeline's "stations inherit nothing" rule.
 */
export class DevinSession {
  private child?: ChildProcess;
  private buffer = "";
  private requestId = 0;
  private readonly pending = new Map<number, PendingCall>();
  private sessionId?: string;
  private assistantText = "";
  private readonly toolNames: string[] = [];
  private readonly seenTools = new Set<string>();
  readonly onLog: (line: string) => void;

  constructor(onLog: (line: string) => void = () => undefined) {
    this.onLog = onLog;
  }

  static async start(
    cwd: string,
    onLog?: (line: string) => void
  ): Promise<DevinSession> {
    const session = new DevinSession(onLog);
    await session.spawn(cwd);
    return session;
  }

  private call(method: string, params: unknown): Promise<unknown> {
    this.requestId += 1;
    const id = this.requestId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { reject, resolve });
      this.child?.stdin?.write(
        `${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`
      );
    });
  }

  private async spawn(cwd: string): Promise<void> {
    this.child = spawn(DEVIN_BIN, ["acp"], {
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.onLog(`[devin:stderr] ${chunk.toString().trimEnd()}`);
    });
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (data: string) => this.onData(data));
    this.child.on("exit", (code) => {
      const error = new Error(`devin acp exited (code ${code})`);
      for (const { reject } of this.pending.values()) {
        reject(error);
      }
      this.pending.clear();
      this.child = undefined;
      this.sessionId = undefined;
    });
    await this.call("initialize", {
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "factory", version: "0.1.0" },
      protocolVersion: 1,
    });
    await this.call("authenticate", {
      _meta: { api_key: apiKey() },
      methodId: "devin-browser",
    });
    const created = (await this.call("session/new", {
      cwd,
      mcpServers: [],
    })) as { sessionId: string };
    this.sessionId = created.sessionId;
    this.onLog(`[acp] session ${this.sessionId}`);
  }

  /** Send a prompt and resolve with the full reply when the turn ends. */
  async prompt(
    text: string,
    timeoutMs = 30 * 60 * 1000
  ): Promise<StationResult> {
    if (!this.sessionId) {
      throw new Error("session not started");
    }
    this.assistantText = "";
    const result = (await Promise.race([
      this.call("session/prompt", {
        prompt: [{ text, type: "text" }],
        sessionId: this.sessionId,
      }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`station timed out after ${timeoutMs}ms`)),
          timeoutMs
        )
      ),
    ])) as { stopReason?: string };
    return {
      stopReason: result.stopReason,
      text: this.assistantText,
      tools: this.toolNames,
    };
  }

  private onData(data: string) {
    this.buffer += data;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      index = this.buffer.indexOf("\n");
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      this.onMessage(message);
    }
  }

  private onMessage(message: Record<string, unknown>) {
    const id = message.id as number | undefined;
    if (id !== undefined && this.pending.has(id)) {
      const call = this.pending.get(id);
      this.pending.delete(id);
      if (message.error === undefined) {
        call?.resolve(message.result);
      } else {
        const error = message.error as { message?: string };
        call?.reject(new Error(error.message ?? JSON.stringify(message.error)));
      }
      return;
    }
    if (id !== undefined && typeof message.method === "string") {
      this.answerAgentRequest(id, message);
      return;
    }
    if (message.method === "session/update") {
      const params = message.params as {
        update?: Record<string, unknown>;
      };
      this.onUpdate(params.update ?? {});
    }
  }

  private onUpdate(update: Record<string, unknown>) {
    const kind = update.sessionUpdate;
    const content = update.content as
      | { text?: string; type?: string }
      | undefined;
    if (kind === "agent_message_chunk" && content?.type === "text") {
      this.assistantText += content.text;
    } else if (kind === "tool_call") {
      const title = String(update.title ?? "tool");
      if (!this.seenTools.has(title)) {
        this.seenTools.add(title);
        this.toolNames.push(title);
      }
      this.onLog(`[tool] ${title}`);
    }
  }

  private answerAgentRequest(id: number, message: Record<string, unknown>) {
    const respond = (body: Record<string, unknown>) =>
      this.child?.stdin?.write(
        `${JSON.stringify({ id, jsonrpc: "2.0", ...body })}\n`
      );
    if (message.method === "session/request_permission") {
      const params = message.params as {
        options?: Array<{ kind?: string; optionId?: string }>;
      };
      const options = params.options ?? [];
      const pick =
        options.find((option) => option.kind === "allow_once") ??
        options.find((option) => String(option.kind).startsWith("allow")) ??
        options[0];
      respond({
        result: { outcome: { optionId: pick?.optionId, outcome: "selected" } },
      });
      this.onLog(`[permission] auto-answered ${pick?.optionId ?? "none"}`);
      return;
    }
    respond({
      error: {
        code: -32_601,
        message: `Not implemented: ${String(message.method)}`,
      },
    });
  }

  close() {
    this.child?.kill();
    this.child = undefined;
    this.sessionId = undefined;
  }
}
