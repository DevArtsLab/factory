# Env profiles

Secrets live in the vault (1Password), not on disk. `*.env.tpl` files are
`op://vault/item/field` references — safe to commit. `*.env` files hold real
values for local-only use and are gitignored.

- `devartslab` — DevArtsLab MongoDB/Atlas org + shared provider keys
- `personal` — personal dev account equivalents

Usage once `1password-cli` is installed (`brew install 1password-cli`,
`op signin`):

```bash
op run --env-file=config/env/devartslab.env.tpl -- pnpm factory run --repo DevArtsLab/factory --issue 1
```

Profiles may carry non-secret values (org/project ids) inline instead of
op:// refs — ids aren't credentials.
