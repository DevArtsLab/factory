# factory threat model (DevArtsLab/factory, branch `devin-factory`)

Status: draft 1, 2026-11-09. Extends the DevArtsLab org baseline (`DevArtsLab/foundation` `md/security/LAB-THREAT-MODEL.md`, revision 3); where the two differ, this file wins for factory. Facts marked **[owner]** come from the lab owner (via the baseline); everything else is **[inferred]** from the code at commit `83ff12d` and has not been confirmed yet. Per lab convention it lives at `md/security/threat-model.md`; security scans of factory start from it.

## System overview

Foreman, the software factory, on local Devin CLI sessions. A work item (`--text`, or a GitHub issue fetched with `gh issue view`) runs through four stations: classifier -> analyst -> implementer -> reviewer (max 2 revision cycles). Each station is a fresh `devin acp` child process with full local shell access and auto-approved tool permissions. An approved `factory/*` branch becomes a draft PR via `gh pr create --draft`. An optional always-on webhook daemon (`pnpm factory intake`) starts runs when an issue is labeled `factory`. Everything runs on the owner's machine with the owner's credentials [inferred: the owner's Mac]. No infrastructure-as-code exists in the repository; there is no hosted deployment.

## Components

| Name | Covers | Notes |
| --- | --- | --- |
| **Intake daemon** | `src/intake/server.ts` | HTTP server on `FACTORY_INTAKE_PORT` (3210). `POST /webhook`: HMAC-SHA256 over the body with `FACTORY_WEBHOOK_SECRET` (timing-safe compare), 1 MiB body cap, `issues`/`labeled`/`factory` filter, in-memory dedupe, spawns detached `cli.ts run --issue <n> --repo <payload.repository.full_name>`; optional `gh issue comment` on exit. `GET /health`. |
| **Orchestrator** | `src/cli.ts`, `src/pipeline.ts`, `src/brain.ts` | Arg parsing, per-target cache clone + per-run worktree under `.factory/`, station prompt assembly (prompt + artifacts dir + brain + work item + output contract), fenced-JSON extraction and shape checks, review loop, draft PR title/body built from station output, brain append (`.factory/brain/<repo>.md`). |
| **ACP client & guard** | `src/acp.ts` | Spawns `DEVIN_BIN acp` with the full parent env, authenticates with `windsurf_api_key` from `~/.local/share/devin/credentials.toml` or `DEVIN_API_KEY`, auto-answers every `session/request_permission` with an allow option unless `permissionAllowed` (regex over `rawInput`) rejects: remote rewrites, `git config user.*`, and pushes that don't name `factory/` or that force/delete/touch main/master. 30-minute prompt timeout. |
| **Git & GitHub delivery** | `src/git.ts` | `git clone git@github.com:<repo>.git` with the owner's ssh key, fetch, worktree add/remove, cross-process mkdir lock with stale-pid cleanup, `verifyRemoteBranch` (`^factory/[a-zA-Z0-9._/-]+$`, not main/master), `gh issue view`, `gh pr create --draft`. |
| **Station prompts** | `prompts/*.md` | Procedures and safety rules given to the stations (never push main/master, never force, never rewrite remotes). Prompt rules are advisory; only the ACP guard and orchestrator checks are enforced. |
| **Dev tooling & supply chain** | `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `biome.jsonc`, `tsconfig.json` | Dev-only deps (Biome, ultracite, TypeScript, @types/node); the `devin` and `gh` binaries are external supply-chain items. |

## Trust boundaries

1. **GitHub webhook -> intake daemon**: anyone who can reach the port; only holders of `FACTORY_WEBHOOK_SECRET` pass the HMAC. Exposure of the port (localhost only, `gh webhook forward`, or a public tunnel) is an open question.
2. **Issue / work-item text -> station sessions** (baseline boundary 4): issue title and body are pasted verbatim into every station prompt, and later into the draft PR body and the brain. Station sessions run with full shell, the owner's env, credentials and ssh key, and auto-approved permissions. This is the dominant boundary.
3. **Target repository content -> station sessions**: the cloned repo (READMEs, AGENTS.md, code, scripts the implementer runs as "the repo's own checks") is untrusted input that executes on the host.
4. **Station output -> orchestrator**: JSON from stations (branch names, summaries, verdicts) is untrusted; it drives `git fetch`, `gh pr create`, brain writes and issue comments.
5. **Factory brain across runs**: one run's derived text (classifier summary, limitations) is appended to `.factory/brain/<repo>.md` and injected into every later run's station prompts (baseline: memory/context poisoning; facts from untrusted input should be quarantined).
6. **Host credentials**: Devin API key (`credentials.toml` / `DEVIN_API_KEY`), `gh` token, ssh key, `FACTORY_WEBHOOK_SECRET`, and whatever else is in the parent env, all inherited by `devin acp` children.
7. **Local filesystem**: `.factory/` (clones, worktrees, artifacts, logs `intake-<n>.log`, brain, lock dirs) inside the factory checkout.

## Assets

Per baseline, weighted equally [owner]:
- **Secrets and tokens**: Devin API key, `gh` token (scope = every repo the owner can write), ssh key, webhook secret, other env secrets on the host.
- **Repository integrity**: every repository the owner's credentials can push to (protected only for `main`/`master` by the guard), PRs/issues opened under the owner's identity.
- **Owner machine**: arbitrary command execution as the owner (lab-wide reach: `~/.agents/`, `config/` PII store, MCP tokens).
- **Integrity of the factory brain and run artifacts** (they steer later agents).
- **Cost**: Devin plan usage (each run = 4+ sessions up to 30 minutes each; webhook-triggered runs are unattended).

## Attacker profiles (from the baseline, applied)

- **A1 Anonymous internet user**: reaches the intake port if exposed; without the secret only `/health` and rejected requests (DoS / log noise).
- **A2 Malicious content / prompt injection**: issue text, comments, repository files, or brain entries that steer a station into running commands, exfiltrating credentials, pushing to non-`factory/*` refs, or abusing `gh`. Primary attacker for this system.
- **A3 Lower-role GitHub user**: someone who can open/edit issues but should not be able to trigger code execution; or who can label issues `factory` on a repo that sends webhooks here.
- **A4 Supply chain**: compromised `devin`/`gh` binaries, npm dev deps, or a target repo's install/test scripts run by the implementer.
- **A5 Local user on a shared machine**: reads `.factory/` logs/artifacts, races the lock dir, or swaps `DEVIN_BIN`/`DEVIN_CREDENTIALS`; in scope per baseline [owner], pending confirmation for factory.
- **A6 Compromised owner credential**: a stolen webhook secret or GitHub token drives runs at will.

## Existing controls

- HMAC-SHA256 webhook signature with timing-safe compare; 1 MiB body cap; event/action/label filter; in-memory dedupe of in-flight issues; 500 on failed spawn.
- ACP-layer guard `permissionAllowed` (regex) on pushes, remote rewrites and git identity; client advertises no fs/terminal capabilities and starts sessions with `mcpServers: []`.
- Orchestrator verifies the claimed branch matches `^factory/[a-zA-Z0-9._/-]+$`, isn't main/master, and exists on the remote before review; PRs are draft only; no merge path.
- Per-run worktrees, per-target cache clones, cross-process repo lock.
- `execFile` (no shell) for git/gh with argv arrays; `.factory/` and `.env*` gitignored.
- Fresh session per station; brain writes are orchestrator-owned one-line entries.
- Baseline intended controls (per-agent tool allow-lists, human approval for side effects, bounded spend, no secrets in agent context, 7-day release age) apply; a finding that factory doesn't implement one is a real finding [owner].

## Out of scope / accepted risk

- None [owner, baseline]: every attacker profile matters, so scanner severities generally stand. The lab owner acting with intent and physical access are not modeled.

## Open questions (asked 2026-11-09, unanswered)

1. Where does the intake daemon run and is its port reachable from the internet (localhost + `gh webhook forward`, public tunnel, server)?
2. Whose issue text can reach the stations: only the owner's (private repos), or outsiders' on public repos, or any collaborator via an org-wide webhook? Can an issue be edited after it is labeled?
3. Does the baseline apply unchanged, or is A5 ruled out for factory (single-user Mac)?
4. Is there an infrastructure repository (e.g. `DevArtsLab/env`, `DevArtsLab/config`) to include? Assumed none.
