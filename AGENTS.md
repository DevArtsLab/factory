# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project overview

Foreman, the software factory, reimplemented on top of local Devin sessions. A work item (text or a GitHub issue) goes through four stations — **classifier** (triage) → **analyst** (plan + acceptance criteria) → **implementer** (codes, verifies, pushes a `factory/*` branch) → **reviewer** (independent verdict on the pushed branch, max 2 revision cycles) — and an approved branch becomes a draft pull request. Each station runs as a fresh `devin acp` session on the local Devin CLI, so station compute rides on the user's Devin plan instead of a hosted agent framework.

The earlier version of this template ran on the eve framework; that version lives on `main`. This branch (`devin-factory`) has no eve code left.

## Layout

- `src/acp.ts` — ACP client: spawns `devin acp` (stdio JSON-RPC), authenticates with `windsurf_api_key` from `~/.local/share/devin/credentials.toml` (or `DEVIN_API_KEY`), opens a session per station, streams `session/update` text, auto-answers `session/request_permission` with the first `allow*` option.
- `src/pipeline.ts` — station prompts, the fenced-```json output contract, the classifier → analyst → implementer → reviewer loop, remote-branch verification after every implementer run.
- `src/git.ts` — clone (`ssh` remote, user's key), branch validation (`factory/*` only, never `main`/`master`), `gh` issue fetch + draft PR creation.
- `src/intake/server.ts` — webhook intake daemon (`pnpm factory intake`): verifies `X-Hub-Signature-256` on `POST /webhook`, and on an `issues`/`labeled`/`factory` event spawns a detached, deduplicated `cli.ts run --issue <n> --repo <repo>` logging to `.factory/runs/intake-<n>.log`. `GET /health` for liveness. Env: `FACTORY_WEBHOOK_SECRET` (required), `FACTORY_INTAKE_PORT` (default 3210), `FACTORY_INTAKE_DRY_RUN`, `FACTORY_INTAKE_COMMENT`.
- `src/cli.ts` — the `factory` entry point.
- `prompts/*.md` — station procedures, adapted from the eve station `instructions.md` files: artifacts are real files in the run's artifacts dir, git ops are plain git.
- `.factory/` (gitignored) — `repos/<owner>__<name>/` is a per-target cache clone (fetch-only, so client projects never share a checkout); each run gets an isolated worktree at `runs/<ts>-<id>/repo` detached at the default branch's tip, so station commands can't leave stray files in a tree another run commits. `runs/<ts>-<id>/artifacts/` holds station handoff documents.

## Commands

```bash
pnpm install
pnpm factory run --text "work item"        # pipeline on a description
pnpm factory run --issue 42                # pipeline on a GitHub issue (gh CLI)
pnpm factory run --issue 42 --verbose      # stream station tool logs
pnpm typecheck                             # tsc
pnpm check                                 # ultracite (Biome)
pnpm fix                                   # ultracite auto-fix
pnpm validate                              # check + typecheck
```

Requires: Node 24.x (runs `.ts` natively via type stripping — keep to erasable syntax only, `erasableSyntaxOnly` is on), `devin` CLI on PATH (`DEVIN_BIN` overrides), `gh` authenticated, and git ssh access to the target repository.

## Conventions

- Each station gets a fresh `devin acp` process and session: stations inherit nothing; every input travels in the prompt text.
- Station output is one fenced `json` block at the end of the reply, shape-checked in `src/pipeline.ts` (`REQUIRED`). Freeform text before the block is allowed.
- A station that needs to hand off a long document writes it in the run's artifacts directory (absolute path is injected into its prompt) and returns the filename.
- The implementer pushes `factory/<type>-<slug>` branches with plain git; the orchestrator verifies the branch exists on the remote before reviewing, and opens the draft PR itself with `gh pr create --draft`.
- Sessions have full local shell access (no sandbox). Safety is enforced twice: prompts state the rules, and `permissionAllowed` in `src/acp.ts` enforces them at the ACP layer — pushes must name a `factory/*` branch (never force, never `main`/`master`), remote rewrites and `git config user.*` are denied outright. Plus orchestrator checks: validated branch names verified against the remote before review.
- Station timeouts: 30 minutes per `session/prompt` in `src/acp.ts`.
