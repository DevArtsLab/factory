import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

const BRANCH_PATTERN = /^factory\/[a-zA-Z0-9._/-]+$/u;
const PROTECTED_BRANCH = /^(?:main|master)$/u;
const ORIGIN_PREFIX = /^origin\//u;
const REMOTE_REPO_PATTERN =
  /github\.com[:/](?<repo>[^/]+\/[^/.]+?)(?:\.git)?$/u;

export const git = async (args: string[], cwd: string): Promise<string> => {
  const { stdout } = await run("git", args, { cwd });
  return stdout.trim();
};

const LOCK_POLL_MS = 250;
const LOCK_TIMEOUT_MS = 15 * 60 * 1000;
const LOCK_ORPHAN_MS = 30 * 1000;

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** A lock whose owner died, or that never got an owner pid written. */
const lockIsStale = (lockDir: string): boolean => {
  try {
    const pid = Number.parseInt(
      fs.readFileSync(path.join(lockDir, "pid"), "utf8"),
      10
    );
    if (Number.isInteger(pid) && pid > 0) {
      return !pidAlive(pid);
    }
  } catch {
    // pid not written yet (or unreadable): fall back to the lock's age
  }
  try {
    return Date.now() - fs.statSync(lockDir).mtimeMs > LOCK_ORPHAN_MS;
  } catch {
    return false;
  }
};

/**
 * Cross-process mutex on a target repo's cache clone. Concurrent runs
 * (e.g. intake deliveries for two issues) would otherwise race `git clone`
 * into the same directory, or fetch/add worktrees on it at the same time.
 */
export const withRepoLock = async <T>(
  cloneDir: string,
  fn: () => Promise<T>
): Promise<T> => {
  const lockDir = `${cloneDir}.lock`;
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const acquire = async (): Promise<void> => {
    try {
      fs.mkdirSync(lockDir);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    if (lockIsStale(lockDir)) {
      fs.rmSync(lockDir, { force: true, recursive: true });
    } else if (Date.now() > deadline) {
      throw new Error(`timed out waiting for repo lock ${lockDir}`);
    } else {
      await sleep(LOCK_POLL_MS);
    }
    return acquire();
  };
  await acquire();
  try {
    fs.writeFileSync(path.join(lockDir, "pid"), String(process.pid));
    return await fn();
  } finally {
    fs.rmSync(lockDir, { force: true, recursive: true });
  }
};

/**
 * Clone the target repo into `dir` on first use, or fetch on later runs.
 * Auth rides on the user's own git setup: the ssh remote and their key.
 */
export const ensureClone = async (repo: string, dir: string): Promise<void> => {
  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await run("git", ["clone", `git@github.com:${repo}.git`, dir]);
    return;
  }
  await git(["fetch", "origin", "--prune"], dir);
  await git(["remote", "set-head", "origin", "-a"], dir).catch(() => "");
};

export const defaultBranch = async (dir: string): Promise<string> => {
  const head = await git(
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    dir
  ).catch(() => "");
  return head.replace(ORIGIN_PREFIX, "") || "main";
};

/** The branch a station claims it pushed, checked against the remote. */
export const verifyRemoteBranch = async (
  dir: string,
  branch: string
): Promise<boolean> => {
  if (!BRANCH_PATTERN.test(branch) || PROTECTED_BRANCH.test(branch)) {
    return false;
  }
  const out = await git(["ls-remote", "--heads", "origin", branch], dir).catch(
    () => ""
  );
  return out.includes(`refs/heads/${branch}`);
};

export const fetchBranch = (dir: string, branch: string) =>
  git(["fetch", "origin", `${branch}:${branch}`], dir);

/**
 * Isolated working tree for one run, detached at the default branch's tip.
 * Per-run instead of the shared clone: station commands can't leave stray
 * files in the tree another run later commits.
 */
export const addWorktree = async (
  cloneDir: string,
  runDir: string,
  base: string
): Promise<string> => {
  fs.mkdirSync(runDir, { recursive: true });
  const worktreeDir = path.join(runDir, "repo");
  await git(
    ["worktree", "add", "--detach", worktreeDir, `origin/${base}`],
    cloneDir
  );
  return worktreeDir;
};

export const removeWorktree = (cloneDir: string, worktreeDir: string) =>
  git(["worktree", "remove", "--force", worktreeDir], cloneDir).catch(() => "");

export const openDraftPr = async (
  dir: string,
  title: string,
  body: string,
  base: string,
  head: string
): Promise<string> => {
  const { stdout } = await run(
    "gh",
    [
      "pr",
      "create",
      "--draft",
      "--title",
      title,
      "--body",
      body,
      "--base",
      base,
      "--head",
      head,
    ],
    { cwd: dir }
  );
  return stdout.trim();
};

export const issueText = async (
  repo: string,
  issue: number
): Promise<string> => {
  const { stdout } = await run(
    "gh",
    [
      "issue",
      "view",
      String(issue),
      "--repo",
      repo,
      "--json",
      "number,title,body,url",
    ],
    { cwd: process.cwd() }
  );
  const data = JSON.parse(stdout) as {
    body: string;
    number: number;
    title: string;
    url: string;
  };
  return `Issue #${data.number}: ${data.title}\n\n${data.body}\n\n(${data.url})`;
};

export const originRepo = async (): Promise<string> => {
  const url = await git(["remote", "get-url", "origin"], process.cwd());
  const repo = url.match(REMOTE_REPO_PATTERN)?.groups?.repo;
  if (!repo) {
    throw new Error(`cannot parse repo from origin: ${url}`);
  }
  return repo;
};
