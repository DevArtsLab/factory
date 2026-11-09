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

## Webhook intake

An always-on daemon can trigger runs straight from GitHub: labeling an issue `factory` on any repo that sends its `issues` webhook here spawns `factory run --issue <n> --repo <owner>/<repo>`.

```bash
export FACTORY_WEBHOOK_SECRET=<shared secret>   # required
export FACTORY_INTAKE_PORT=3210                  # optional, default 3210
pnpm factory intake
```

`POST /webhook` verifies `X-Hub-Signature-256` against the secret, then spawns a detached run for `issues` events with `action: "labeled"` and label `factory`. Each run logs to `.factory/runs/intake-<n>.log`; an issue already in-flight is deduplicated (in-memory — a daemon restart can re-trigger on a redelivery). If the run cannot be launched (log unwritable, spawn error) the webhook answers `500`, so the delivery stays failed in GitHub and can be redelivered. Concurrent runs are safe: each gets its own `.factory/runs/<ts>-<id>/` directory, and clone/fetch/worktree setup on a target repo's cache clone is serialized by a cross-process lock (`.factory/repos/<owner>__<name>.lock`). `GET /health` returns `{"ok": true}`.

Optional env vars: `FACTORY_INTAKE_DRY_RUN=1` logs the spawn intent without running anything; `FACTORY_INTAKE_COMMENT=1` posts a success/failure comment on the issue when the run exits (with the draft PR link when the log has one).

Local test — forward real deliveries with `gh`, or hand-sign a curl:

```bash
gh webhook forward --repo <owner>/<repo> --events issues \
  --secret "$FACTORY_WEBHOOK_SECRET" --url http://localhost:3210/webhook

# or: sign a fixture body and POST it
BODY='{"action":"labeled","label":{"name":"factory"},"issue":{"number":42},"repository":{"full_name":"owner/name"}}'
SIG="sha256=$(printf %s "$BODY" | openssl dgst -sha256 -hmac "$FACTORY_WEBHOOK_SECRET" | sed 's/^.* //')"
curl -X POST http://localhost:3210/webhook \
  -H "X-GitHub-Event: issues" -H "X-Hub-Signature-256: $SIG" \
  -H "Content-Type: application/json" -d "$BODY"
```

Point a GitHub repo/app webhook at the same URL (`application/json`, `issues` events, same secret) for the real loop.

See `AGENTS.md` for the internals.
