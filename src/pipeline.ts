import fs from "node:fs";
import path from "node:path";
import { DevinSession } from "./acp.ts";
import { defaultBranch, fetchBranch, verifyRemoteBranch } from "./git.ts";

const PROMPTS_DIR = path.resolve(import.meta.dirname, "..", "prompts");

const readPrompt = (name: string): string =>
  fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), "utf8");

// Structured-output contracts, condensed from the eve station schemas
// (agent/lib/stations/schemas.ts). Each station ends its reply with one
// fenced ```json block matching the shape below.
const OUTPUT_SHAPES: Record<string, Record<string, unknown>> = {
  analyst: {
    acceptance_criteria: ["string (min 1)"],
    affected_surface: ["string"],
    approach: "string",
    artifact_id: "string|null",
    assumptions: ["string"],
    open_questions: ["string"],
    plan: ["string (min 1)"],
    problem_statement: "string",
    risks: ["string"],
    test_strategy: "string",
  },
  classifier: {
    actionable: "boolean",
    affected_area: "string",
    complexity: "trivial|small|medium|large",
    needs_clarification: "boolean",
    priority: "critical|high|medium|low",
    questions: ["string"],
    summary: "string",
    type: "bug|feature|refactor|question|chore|security",
  },
  implementer: {
    base: "string",
    branch: "string",
    change_summary: [{ change: "string", path: "string" }],
    deviations: ["string"],
    known_limitations: ["string"],
    pushed: "boolean",
    verification: [{ command: "string", result: "string" }],
  },
  researcher: {
    artifact_id: "string|null",
    findings: [
      {
        claim: "string",
        confidence: "high|medium|low",
        notes: "string",
        sources: [{ title: "string", url: "string" }],
      },
    ],
    gaps: ["string"],
    summary: "string",
  },
  reviewer: {
    blocking_findings: [
      { evidence: "string", finding: "string", severity: "string" },
    ],
    criteria_results: [
      { criterion: "string", evidence: "string", pass: "boolean" },
    ],
    suggestions: ["string"],
    summary: "string",
    verdict: "approve|request_changes|reject",
  },
};

const REQUIRED: Record<string, string[]> = {
  analyst: [
    "problem_statement",
    "approach",
    "plan",
    "acceptance_criteria",
    "test_strategy",
  ],
  classifier: ["type", "summary", "needs_clarification", "actionable"],
  implementer: ["branch", "base", "pushed", "verification"],
  researcher: ["summary", "findings", "gaps"],
  reviewer: ["verdict", "criteria_results", "blocking_findings", "summary"],
};

const JSON_BLOCK = /```(?:json)?\s*\n(?<body>[\s\S]*?)```/gu;

/** Pull the last fenced ```json block out of a station reply. */
const extractJson = (text: string): Record<string, unknown> => {
  const fenced = [...text.matchAll(JSON_BLOCK)].map(
    (match) => match.groups?.body ?? ""
  );
  for (const candidate of fenced.reverse()) {
    try {
      return JSON.parse(candidate.trim());
    } catch {
      // keep looking
    }
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // fall through
    }
  }
  throw new Error("station reply carried no parseable JSON block");
};

const validate = (name: string, data: Record<string, unknown>) => {
  const missing = (REQUIRED[name] ?? []).filter(
    (key) => data[key] === undefined
  );
  if (missing.length > 0) {
    throw new Error(`station ${name} output missing: ${missing.join(", ")}`);
  }
};

export interface PipelineOptions {
  artifactsDir: string;
  /** Test hook: force the first review to request changes so the revision loop runs once. */
  forceRevision?: boolean;
  maxCycles?: number;
  onLog?: (line: string) => void;
  workdir: string;
  workItem: string;
}

export interface PipelineReport {
  analysis?: Record<string, unknown>;
  base?: string;
  branch?: string;
  classification?: Record<string, unknown>;
  cycles: number;
  implementation?: Record<string, unknown>;
  prUrl?: string;
  reason?: string;
  review?: Record<string, unknown>;
  status: "clarify" | "failed" | "ready" | "rejected";
}

const OUTPUT_CONTRACT = (name: string): string =>
  `\n\n# Output\n\nDo not ask questions. When you are done, end your reply with exactly one fenced \`\`\`json code block (no JSON after it) matching this shape:\n\n\`\`\`json\n${JSON.stringify(OUTPUT_SHAPES[name] ?? {}, null, 2)}\n\`\`\``;

export const runStation = async (
  name: string,
  input: string,
  opts: PipelineOptions
): Promise<Record<string, unknown>> => {
  const log = opts.onLog ?? (() => undefined);
  const message =
    readPrompt(name) +
    `\n\n# Context\n\nArtifacts directory (absolute): ${opts.artifactsDir}\n\n# Input\n\n` +
    input +
    OUTPUT_CONTRACT(name);
  log(`[station:${name}] starting devin session`);
  const session = await DevinSession.start(opts.workdir, log);
  try {
    const result = await session.prompt(message);
    const data = extractJson(result.text);
    validate(name, data);
    log(
      `[station:${name}] done (${result.tools.length} tools, stop=${result.stopReason ?? "?"})`
    );
    return data;
  } finally {
    session.close();
  }
};

const json = (data: unknown): string =>
  `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;

/**
 * classifier -> analyst -> implementer -> reviewer, with at most
 * `maxCycles` implementer revision loops on request_changes.
 */
export const runPipeline = async (
  opts: PipelineOptions
): Promise<PipelineReport> => {
  const log = opts.onLog ?? (() => undefined);
  const maxCycles = opts.maxCycles ?? 2;
  fs.mkdirSync(opts.artifactsDir, { recursive: true });

  const classification = await runStation(
    "classifier",
    `Work item:\n\n${opts.workItem}`,
    opts
  );
  if (
    classification.needs_clarification === true ||
    classification.actionable === false
  ) {
    return {
      classification,
      cycles: 0,
      reason: "needs clarification before work can start",
      status: "clarify",
    };
  }

  const analysis = await runStation(
    "analyst",
    `Work item:\n\n${opts.workItem}\n\nClassification:\n\n${json(classification)}`,
    opts
  );

  const implementerInput = (revision?: {
    branch: string;
    findings: unknown;
  }): string =>
    [
      `Work item:\n\n${opts.workItem}`,
      `Classification:\n\n${json(classification)}`,
      `Analysis:\n\n${json(analysis)}`,
      analysis.artifact_id
        ? `Analysis artifact: ${analysis.artifact_id}`
        : null,
      revision
        ? `Revision run on existing branch \`${revision.branch}\`. Reviewer findings to address:\n\n${json(revision.findings)}`
        : null,
    ]
      .filter(Boolean)
      .join("\n\n");

  let implementation = await runStation(
    "implementer",
    implementerInput(),
    opts
  );
  let cycles = 0;

  const verifyPush = async (): Promise<string | undefined> => {
    const branch = String(implementation.branch ?? "");
    if (
      implementation.pushed !== true ||
      !(await verifyRemoteBranch(opts.workdir, branch))
    ) {
      return undefined;
    }
    await fetchBranch(opts.workdir, branch).catch(() => {
      // local checkout lags the remote; the reviewer fetches anyway
    });
    return branch;
  };

  let branch = await verifyPush();
  if (branch === undefined) {
    return {
      analysis,
      classification,
      cycles,
      implementation,
      reason:
        "implementer reported no successful push, or the named branch is missing or invalid on the remote",
      status: "failed",
    };
  }

  const reviewInput = (): string =>
    [
      `Work item:\n\n${opts.workItem}`,
      `Analysis:\n\n${json(analysis)}`,
      analysis.artifact_id
        ? `Analysis artifact: ${analysis.artifact_id}`
        : null,
      `Branch under review: \`${branch}\` (base: \`${implementation.base}\`)`,
      `Implementer report:\n\n${json(implementation)}`,
    ]
      .filter(Boolean)
      .join("\n\n");

  let review = await runStation("reviewer", reviewInput(), opts);
  if (opts.forceRevision && review.verdict === "approve") {
    log(
      "[pipeline] force-revision: injecting a blocking finding for the loop test"
    );
    review = {
      ...review,
      blocking_findings: [
        {
          evidence:
            "injected by --force-revision to exercise the revision loop",
          finding:
            "Add a one-line note at the end of the changed files that revision cycle 1 ran.",
          severity: "low",
        },
      ],
      verdict: "request_changes",
    };
  }

  // stations are sequential by design: a revision waits on the review,
  // and the re-review waits on the push the revision delivers
  while (review.verdict === "request_changes" && cycles < maxCycles) {
    cycles += 1;
    log(`[pipeline] revision cycle ${cycles}/${maxCycles}`);
    // biome-ignore lint/performance/noAwaitInLoops: pipeline order is load-bearing
    implementation = await runStation(
      "implementer",
      implementerInput({
        branch,
        findings: review.blocking_findings,
      }),
      opts
    );
    const nextBranch = await verifyPush();
    if (nextBranch === undefined) {
      return {
        analysis,
        classification,
        cycles,
        implementation,
        reason: "revision run pushed no verifiable branch",
        review,
        status: "failed",
      };
    }
    branch = nextBranch;
    review = await runStation("reviewer", reviewInput(), opts);
  }

  const base = await defaultBranch(opts.workdir);
  if (review.verdict === "approve") {
    return {
      analysis,
      base,
      branch,
      classification,
      cycles,
      implementation,
      review,
      status: "ready",
    };
  }
  return {
    analysis,
    base,
    branch,
    classification,
    cycles,
    implementation,
    reason:
      review.verdict === "reject"
        ? "reviewer rejected the approach"
        : `still failing review after ${cycles} revision cycle(s)`,
    review,
    status: "rejected",
  };
};
