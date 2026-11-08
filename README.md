# Devin Factory

A software factory powered by your own Devin plan. Work items go through four stations — **classifier → analyst → implementer → reviewer** — and an approved result lands as a reviewed draft pull request on the target repository.

Each station runs as a fresh `devin acp` session on this machine, so compute rides on the Devin account instead of a hosted agent framework. (The original eve-framework version of this template lives on `main`.)

## Run it

```bash
pnpm install
pnpm factory run --text "add a Reporting bugs section to the README"
pnpm factory run --issue 42        # fetch the issue with gh
pnpm factory run --issue 42 -v     # stream station tool logs
```

Prereqs: Node 24, `devin` CLI on PATH (authenticated via `~/.local/share/devin/credentials.toml` or `DEVIN_API_KEY`), `gh` CLI logged in, and git ssh access to the target repo (`--repo`, defaults to this checkout's origin).

## How it works

- **Classifier** triages the item. Ambiguous items stop with questions instead of building the wrong thing.
- **Analyst** plans against a real clone at `.factory/repo`, with acceptance criteria.
- **Implementer** executes the plan, verifies with the repo's own checks, and pushes a `factory/*` branch (never `main`).
- **Reviewer** independently judges the real diff — approve, request changes (up to 2 revision cycles), or reject.

Approved branches become draft PRs via `gh pr create --draft`. Station outputs are structured JSON; long handoff documents live in `.factory/artifacts/`.

See `AGENTS.md` for the internals.
