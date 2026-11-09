import { execFile, spawn } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

// intake — always-on webhook daemon: a `factory` label on a GitHub issue
// spawns `cli.ts run --issue <n> --repo <owner>/<repo>`.
//
// Env: FACTORY_WEBHOOK_SECRET (required), FACTORY_INTAKE_PORT (default 3210),
// FACTORY_INTAKE_DRY_RUN=1 (log intent, spawn nothing),
// FACTORY_INTAKE_COMMENT=1 (post a status comment on the issue on run close).

const FACTORY_ROOT = path.resolve(import.meta.dirname, "..", "..");
const CLI_PATH = path.resolve(import.meta.dirname, "..", "cli.ts");
const RUNS_DIR = path.join(FACTORY_ROOT, ".factory", "runs");
const TRIGGER_LABEL = "factory";
const MAX_BODY_BYTES = 1024 * 1024;
const PR_URL_PATTERN = /draft PR: (?<url>\S+)/u;

interface IntakeOptions {
  comment?: boolean;
  dryRun?: boolean;
  port?: number;
  secret?: string;
}

interface IssuesPayload {
  action?: string;
  issue?: { number?: number };
  label?: { name?: string };
  repository?: { full_name?: string };
}

const log = (line: string): void => {
  console.error(`intake: ${line}`);
};

const send = (
  res: http.ServerResponse,
  status: number,
  body: Record<string, unknown>
): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const readBody = (req: http.IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("payload too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

const validSignature = (
  body: Buffer,
  header: string | undefined,
  secret: string
): boolean => {
  if (!header) {
    return false;
  }
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const received = Buffer.from(header);
  const wanted = Buffer.from(expected);
  return received.length === wanted.length && timingSafeEqual(received, wanted);
};

const prUrlFromLog = (logPath: string): string => {
  try {
    return (
      fs.readFileSync(logPath, "utf8").match(PR_URL_PATTERN)?.groups?.url ?? ""
    );
  } catch {
    return "";
  }
};

const postComment = (
  repo: string,
  issue: number,
  code: number | null,
  logPath: string
): void => {
  const pr = prUrlFromLog(logPath);
  const body =
    code === 0
      ? `Factory run finished.${pr ? ` Draft PR: ${pr}` : ""}`
      : `Factory run failed (exit ${String(code)}); see .factory/runs/intake-${issue}.log on the intake host.`;
  execFile(
    "gh",
    ["issue", "comment", String(issue), "--repo", repo, "--body", body],
    (error) => {
      if (error) {
        log(`issue comment for ${repo}#${issue} failed: ${error.message}`);
      }
    }
  );
};

export const startServer = (options: IntakeOptions = {}): http.Server => {
  const secret = options.secret ?? process.env.FACTORY_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("FACTORY_WEBHOOK_SECRET is required");
  }
  const port =
    options.port ??
    Number.parseInt(process.env.FACTORY_INTAKE_PORT ?? "3210", 10);
  const dryRun = options.dryRun ?? process.env.FACTORY_INTAKE_DRY_RUN === "1";
  const comment = options.comment ?? process.env.FACTORY_INTAKE_COMMENT === "1";
  const inFlight = new Set<string>();

  const spawnRun = (repo: string, issue: number, key: string): void => {
    const logPath = path.join(RUNS_DIR, `intake-${issue}.log`);
    if (dryRun) {
      // The key stays in `inFlight` — a dry-run "run" never finishes, so
      // repeat deliveries no-op until the daemon restarts.
      log(`dry-run: would spawn run --issue ${issue} --repo ${repo}`);
      return;
    }
    let fd: number | null = null;
    try {
      fs.mkdirSync(RUNS_DIR, { recursive: true });
      fd = fs.openSync(logPath, "a");
      const child = spawn(
        process.execPath,
        [CLI_PATH, "run", "--issue", String(issue), "--repo", repo],
        { cwd: FACTORY_ROOT, detached: true, stdio: ["ignore", fd, fd] }
      );
      child.unref();
      fs.closeSync(fd);
      fd = null;
      child.on("error", (error: Error) => {
        inFlight.delete(key);
        log(`spawn ${key} failed: ${error.message}`);
      });
      child.on("close", (code) => {
        inFlight.delete(key);
        log(`run ${key} exited ${String(code)}`);
        if (comment) {
          postComment(repo, issue, code, logPath);
        }
      });
      log(`spawned ${key} (pid ${String(child.pid)}) -> ${logPath}`);
    } catch (error) {
      if (fd !== null) {
        fs.closeSync(fd);
      }
      inFlight.delete(key);
      log(
        `spawn ${key} failed: ${error instanceof Error ? error.message : error}`
      );
    }
  };

  const handleWebhook = async (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> => {
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      send(res, 413, { error: "payload too large" });
      return;
    }
    const signatureHeader = req.headers["x-hub-signature-256"];
    const signature = Array.isArray(signatureHeader)
      ? signatureHeader[0]
      : signatureHeader;
    if (!validSignature(body, signature, secret)) {
      send(res, 401, { error: "bad signature" });
      return;
    }
    let payload: IssuesPayload;
    try {
      payload = JSON.parse(body.toString("utf8")) as IssuesPayload;
    } catch {
      send(res, 400, { error: "invalid json" });
      return;
    }
    if (
      req.headers["x-github-event"] !== "issues" ||
      payload.action !== "labeled" ||
      payload.label?.name !== TRIGGER_LABEL
    ) {
      send(res, 200, { status: "ignored" });
      return;
    }
    const issue = payload.issue?.number;
    const repo = payload.repository?.full_name;
    if (typeof issue !== "number" || !repo) {
      send(res, 400, { error: "missing issue.number or repository.full_name" });
      return;
    }
    const key = `${repo}#${issue}`;
    if (inFlight.has(key)) {
      send(res, 200, { status: "already in-flight" });
      return;
    }
    inFlight.add(key);
    spawnRun(repo, issue, key);
    send(res, 200, { status: dryRun ? "dry-run" : "spawned" });
  };

  const server = http.createServer((req, res) => {
    const pathname = req.url?.split("?")[0];
    if (pathname === "/health" && req.method === "GET") {
      send(res, 200, { ok: true });
      return;
    }
    if (pathname === "/webhook") {
      if (req.method !== "POST") {
        send(res, 405, { error: "method not allowed" });
        return;
      }
      handleWebhook(req, res).catch((error: unknown) => {
        log(
          `webhook handler error: ${error instanceof Error ? error.message : error}`
        );
        if (!res.headersSent) {
          send(res, 500, { error: "internal error" });
        }
      });
      return;
    }
    send(res, 404, { error: "not found" });
  });

  server.listen(port, () => {
    log(
      `listening on :${port} (dry-run ${dryRun ? "on" : "off"}, comments ${comment ? "on" : "off"})`
    );
  });
  return server;
};
