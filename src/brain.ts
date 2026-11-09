import fs from "node:fs";
import path from "node:path";

// The factory brain: durable, per-repo notes every run reads and appends to.
// Backend is flagged: FACTORY_BRAIN=off disables, "file" (default) stores a
// markdown doc per target repo under .factory/brain/, "atlas" is reserved for
// a MongoDB/Voyage backend (unimplemented — same load/append interface).
//
// Reads inject context into stations; writes are orchestrator-owned one-line
// run entries, so a station can never rewrite shared memory.

type BrainBackend = "atlas" | "file" | "off";

const backend = (): BrainBackend => {
  const value = process.env.FACTORY_BRAIN ?? "file";
  if (value === "off" || value === "file" || value === "atlas") {
    return value;
  }
  throw new Error(`FACTORY_BRAIN must be off|file|atlas, got "${value}"`);
};

const brainPath = (repo: string): string =>
  path.resolve(".factory/brain", `${repo.replaceAll(/[^a-zA-Z0-9._-]/gu, "__")}.md`);

export const loadBrain = (repo: string): string => {
  switch (backend()) {
    case "off":
      return "";
    case "atlas":
      throw new Error(
        "FACTORY_BRAIN=atlas is reserved for the MongoDB/Voyage backend; not implemented yet",
      );
    case "file": {
      const file = brainPath(repo);
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
    }
    default:
      return "";
  }
};

export const appendBrain = (repo: string, entry: string): void => {
  if (backend() !== "file") {
    return;
  }
  const file = brainPath(repo);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
      `# Factory brain — ${repo}\n\nDurable notes about this repository, one line per run. Curate freely; runs append, they never rewrite.\n`,
    );
  }
  const stamp = new Date().toISOString().slice(0, 10);
  fs.appendFileSync(file, `\n- ${stamp} — ${entry.replaceAll("\n", " ")}`);
};
