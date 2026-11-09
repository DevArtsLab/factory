import path from "node:path";
import { appendBrain, loadBrain } from "./brain.ts";
import {
  addWorktree,
  defaultBranch,
  ensureClone,
  issueText,
  openDraftPr,
  originRepo,
} from "./git.ts";
import { type PipelineReport, runPipeline } from "./pipeline.ts";

// factory — drive the four-station pipeline with local `devin acp` sessions.
//
//   node src/cli.ts run --text "fix the flaky login test"
//   node src/cli.ts run --issue 42
//   node src/cli.ts run --issue 42 --repo owner/name --workdir /tmp/clone
//
// Logs go to stderr; the final report (JSON) goes to stdout.

interface Args {
  command: string;
  cycles: number;
  forceRevision: boolean;
  issue?: number;
  noPr: boolean;
  repo?: string;
  text?: string;
  verbose: boolean;
  workdir?: string;
}

const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    command: argv[0] ?? "help",
    cycles: 2,
    forceRevision: false,
    noPr: false,
    verbose: false,
  };
  for (let i = 1; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => {
      i += 1;
      return argv[i] ?? "";
    };
    switch (flag) {
      case "--text":
        args.text = next();
        break;
      case "--issue":
        args.issue = Number.parseInt(next(), 10);
        break;
      case "--repo":
        args.repo = next();
        break;
      case "--workdir":
        args.workdir = next();
        break;
      case "--cycles":
        args.cycles = Number.parseInt(next(), 10);
        break;
      case "--force-revision":
        args.forceRevision = true;
        break;
      case "--no-pr":
        args.noPr = true;
        break;
      case "--verbose":
      case "-v":
        args.verbose = true;
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  return args;
};

const usage = `Usage:
  factory run --text "<work item>"      run the pipeline on a description
  factory run --issue <n>               run the pipeline on GitHub issue n
Options:
  --repo owner/name    target repo (default: this checkout's origin)
  --workdir <dir>      run directory override (default: .factory/runs/<ts>)
  --cycles <n>         max implementer revision cycles (default: 2)
  --no-pr              stop before opening the draft PR
  --force-revision     test hook: inject a finding so the revision loop runs once
  --verbose            stream station tool-call logs to stderr
`;

const summarize = (report: PipelineReport): void => {
  const c = report.classification;
  console.error(`\n== pipeline ${report.status} ==`);
  if (c) {
    console.error(
      `classifier: ${c.type} / ${c.priority} / ${c.complexity} — ${c.summary}`
    );
  }
  if (report.branch) {
    console.error(`branch: ${report.branch} (base ${report.base})`);
  }
  if (report.review) {
    console.error(
      `verdict: ${report.review.verdict} — ${report.review.summary}`
    );
  }
  if (report.reason) {
    console.error(`reason: ${report.reason}`);
  }
};

const recordRun = (
  repo: string,
  workItem: string,
  report: PipelineReport
): void => {
  const limitations = Array.isArray(report.implementation?.known_limitations)
    ? report.implementation.known_limitations.join("; ").slice(0, 200)
    : "";
  appendBrain(
    repo,
    [
      `${report.status}: ${String(report.classification?.type ?? "?")} — ${String(
        report.classification?.summary ?? workItem
      ).slice(0, 120)}`,
      report.branch ? `branch ${report.branch}` : null,
      report.review?.verdict ? `verdict ${report.review.verdict}` : null,
      limitations ? `limitations: ${limitations}` : null,
    ]
      .filter(Boolean)
      .join("; ")
  );
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.command !== "run" || (!args.text && args.issue === undefined)) {
    console.error(usage);
    process.exit(args.command === "run" ? 1 : 0);
  }
  const repo = args.repo ?? (await originRepo());
  const workItem = args.text ?? (await issueText(repo, args.issue as number));

  const cloneDir = path.resolve(
    `.factory/repos/${repo.replaceAll(/[^a-zA-Z0-9._-]/gu, "__")}`
  );
  const runId = new Date().toISOString().replaceAll(/[:.]/gu, "-").slice(0, 19);
  const runDir = path.resolve(args.workdir ?? `.factory/runs/${runId}`);
  const artifactsDir = path.join(runDir, "artifacts");

  await ensureClone(repo, cloneDir);
  const base = await defaultBranch(cloneDir);
  const workdir = await addWorktree(cloneDir, runDir, base);
  console.error(`repo: ${repo} -> ${workdir} (base ${base})`);

  const onLog = args.verbose
    ? (line: string) => console.error(line)
    : (line: string) => {
        if (line.startsWith("[station")) {
          console.error(line);
        }
      };

  const brain = loadBrain(repo);
  const report = await runPipeline({
    artifactsDir,
    brain,
    forceRevision: args.forceRevision,
    maxCycles: args.cycles,
    onLog,
    workdir,
    workItem,
  });

  if (report.status === "ready" && !args.noPr && report.branch && report.base) {
    const title = `${report.classification?.type ?? "factory"}: ${String(
      report.classification?.summary ?? "factory work item"
    ).slice(0, 70)}`;
    const body = [
      "## Summary",
      "",
      String(report.analysis?.problem_statement ?? workItem),
      "",
      `Approach: ${String(report.analysis?.approach ?? "")}`,
      "",
      "## Review",
      "",
      `Reviewer verdict: **${String(report.review?.verdict ?? "?")}** — ${String(
        report.review?.summary ?? ""
      )}`,
      "",
      "Generated by the local Devin factory pipeline.",
    ].join("\n");
    const url = await openDraftPr(
      workdir,
      title.slice(0, 100),
      body,
      report.base,
      report.branch
    );
    report.prUrl = url;
    console.error(`draft PR: ${url}`);
  }

  recordRun(repo, workItem, report);
  summarize(report);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.status === "ready" ? 0 : 1);
};

main().catch((error: unknown) => {
  console.error(`factory: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
