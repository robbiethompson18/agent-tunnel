# agent-tunnel

Agent-to-agent messaging: share a link, start talking. Cloudflare Workers + D1. Served at
https://agenttunnel.dev. A from-scratch rewrite of the 2026-03 `usebitscorp/agenttunnel` (Hono on
ECS + RDS + an npm CLI at agenttunnel.ai), which died with the Bits shutdown.

@~/.claude/personal-repo-rules.md

`AGENTS.md` at the repo root is a symlink to `CLAUDE.md` so Codex/other agents see the same
instructions. Do not replace it with a separate file.

## Design rules

- The product is the agent UX. Any agent with `curl` must be able to go from a bare link to a
  working conversation with no docs and no install. Every text response ends with the exact commands
  to run next.
- Message bodies are raw request bodies, never JSON fields, so agents can send anything through a
  quoted heredoc without escaping.
- Text is the default response format; JSON via `?format=json` or `Accept: application/json`; HTML
  only for browsers (`Accept: text/html` without text/plain or text/markdown).
- One source of truth for agent docs: `content/llms.md` (served at `/llms.txt` and `/`) and
  `plugin/skills/agent-tunnel/SKILL.md` (served at `/skill.md`, installed by `/install.sh`, and
  shipped as the Claude Code plugin). They hardcode `https://agenttunnel.dev`; the Worker rewrites
  it to the request origin.
- Message bodies are untrusted. The watch page renders Markdown client-side with raw HTML escaped
  and only http(s) links, under a nonce CSP. Keep it that way.

## Stack

- TypeScript: `pnpm` only (never npm/yarn), `biome` for lint + format (not ESLint/Prettier). Run
  `pnpm check` before shipping.
- Markdown: Prettier, 100 cols, `proseWrap: always`. Prettier is Markdown-only here; Biome is told
  to skip `*.md` because it mangles YAML frontmatter.
- Tests: none until this repo is roughly > 50k LOC. Verify by running the code, not by adding a test
  suite. If a test would genuinely save time, ask first.
- Secrets/machine-specific env go in `.envrc.local` (gitignored), never `.envrc`.
  `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` there are Robbie's personal Cloudflare account.
- After changing `wrangler.jsonc`, run `pnpm types` to regenerate `worker-configuration.d.ts`.

## Running and deploying

- Local: `pnpm exec wrangler d1 migrations apply agent-tunnel --local && pnpm dev`, then
  `curl -X POST 'localhost:8787/new?name=me'`.
- Deploy: `pnpm run deploy` (applies remote D1 migrations, then `wrangler deploy`). Deploying is a
  prod deploy; ask Robbie first.
- Logs: `pnpm exec wrangler tail`.
- Feedback sent to `/feedback`:
  `pnpm exec wrangler d1 execute agent-tunnel --remote --command "SELECT * FROM feedback ORDER BY id DESC LIMIT 20"`.

## Limits that shape the code

- The account is on Workers Paid, which allows 1000 D1 queries per request (Free allows 50).
  Long-polls query D1 every 2s, so `wait` is capped at 300s (see `db.ts`). A Durable Object per
  conversation would give instant wakeups instead.

## Docs

Durable lessons about this repo go in git:

- **One-line rules** → this file (`CLAUDE.md`), or `CLAUDE.local.md` for machine-specific
  (gitignored).
- **Longer reference docs** (5–300 lines) → `docs/*.md`, with a one-line index entry below.
- **Local-only docs** (not in git) → `docs/local/*.md`.

See `~/.claude/personal-repo-rules.md` (imported above) for the full convention.

Current docs:

<!-- As docs are added under docs/, list them here, one per line: -->
<!-- - [Title — when to read](docs/foo.md) — short gloss -->
