import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const BRANCH_PATTERN = /^factory\/[a-zA-Z0-9._/-]+$/u;
const PROTECTED_BRANCH = /^(?:main|master)$/u;
const ORIGIN_PREFIX = /^origin\//u;
const REMOTE_REPO_PATTERN = /github\.com[:/](?<repo>[^/]+\/[^/.]+?)(?:\.git)?$/u;

export const git = async (args: string[], cwd: string): Promise<string> => {
  const { stdout } = await run("git", args, { cwd });
  return stdout.trim();
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
    dir,
  ).catch(() => "");
  return head.replace(ORIGIN_PREFIX, "") || "main";
};

/** The branch a station claims it pushed, checked against the remote. */
export const verifyRemoteBranch = async (
  dir: string,
  branch: string,
): Promise<boolean> => {
  if (!BRANCH_PATTERN.test(branch) || PROTECTED_BRANCH.test(branch)) {
    return false;
  }
  const out = await git(["ls-remote", "--heads", "origin", branch], dir).catch(
    () => "",
  );
  return out.includes(`refs/heads/${branch}`);
};

export const fetchBranch = (dir: string, branch: string) =>
  git(["fetch", "origin", `${branch}:${branch}`], dir);

export const openDraftPr = async (
  dir: string,
  title: string,
  body: string,
  base: string,
  head: string,
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
    { cwd: dir },
  );
  return stdout.trim();
};

export const issueText = async (repo: string, issue: number): Promise<string> => {
  const { stdout } = await run(
    "gh",
    ["issue", "view", String(issue), "--repo", repo, "--json", "number,title,body,url"],
    { cwd: process.cwd() },
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
