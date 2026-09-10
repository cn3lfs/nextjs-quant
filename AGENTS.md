# Repository guidance

## Scope control — read `docs/roadmap.md` first

`docs/roadmap.md` is the single source of truth for what to build. Read it before any change.

- Project is a **minimal personal quant workbench**: chart viewing, two strategies (缠论 / 双突破), signal push. Nothing else.
- Milestones M1–M5 are **strictly serial**. Do not start the next one before the current one passes its binary acceptance criteria.
- The freeze list in `docs/roadmap.md` §2 is binding. Frozen modules keep working but receive **zero** investment — no features, no refactors, no optimisation, no added verification. Record bugs there instead of fixing them, unless they block the current milestone.
- **Do not expand scope.** Anything that looks worth doing but is not in the current milestone goes to the open-questions list in `docs/decisions.md`, unimplemented.
- Hit a decision the roadmap does not cover? Apply the escalation rule in `docs/roadmap.md` §3.5: stop and report only for scope, architecture, irreversible actions, or licensing. Decide local details (edge cases, signatures, naming) yourself, document the choice in code and in `docs/decisions.md`, and keep going. **Never stall the whole deliverable on one undecided edge case.**
- Backtesting is out of scope permanently — strategy validation happens on JoinQuant. Existing backtest code is frozen as a self-check tool.
- Performance work is finished (screening went 40.84s → 165ms). Do not optimise further.

## Verification tiers — do not run the full suite per edit

```
per edit       → vitest run --changed + tsc --noEmit
per subtask    → pnpm test
per milestone  → build + desktop:prepare + desktop:smoke + Playwright + desktop:pack
```

Running desktop smoke or Playwright for a single function change is forbidden. The previous 19-hour run spent most of its budget this way.

- Never create an `output/` directory for scratch verification. It used to hold 545 one-off scripts and dumps and was deleted on 2026-09-10 along with the A–H era docs that cited them. Verification is either a persistent case in `tests/`, or it is not written.
- Do not append to `docs/optimization-progress.md`; it is archived. Write to `docs/decisions.md`, recording only decisions, what was dropped and why, and facts that contradicted expectations. Never record "N tests passed / typecheck passed / build passed".

## Base rules

- Windows-first local quantitative research application, scaffolded with Create T3 App.
- Frontend and backend use TypeScript. Electron only hosts the window and manages the bundled Node service.
- Never modify the source data under the configured 通达信 directory. New parsers require binary fixtures and malformed-input tests.
- Market sources and adjustment modes must remain explicit. Preserve immutable snapshots for research and backtests.
- LLM output is untrusted structured data. Validate it and its evidence IDs; never execute generated code or route model output to trading APIs.
- Notifications require enabled subscriptions. Do not send real test messages without an explicit test request and configured destination.
- Never log API keys, webhook URLs, Bot Tokens or MCP authentication. Secrets use Windows DPAPI outside the repository.
- Run `pnpm typecheck`, `pnpm test`, and `pnpm build` after meaningful changes. Runtime workers must also be rebuilt with `pnpm runtime:build`.
- Desktop verification: `pnpm desktop:prepare`, `pnpm desktop:smoke`; packaged smoke accepts `node scripts/desktop-smoke.mjs --packaged`.
- Build artifacts, databases, screenshots and credentials are ignored. Do not commit or push unless requested.
- Package with `pnpm desktop:pack`: keep only the latest complete desktop release at `release/win-unpacked`. Never create version-specific output folders. If the app is running, stop packaging and preserve the existing release.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Dependencies are provisioned by the manager

Codex runs under the `workspace-write` sandbox, which has **no network access**. `pnpm add` and `pnpm install` will always fail there.

- Never attempt to install a dependency. If one is missing, **stop and report** so the manager can provision it.
- A missing dependency is not a reason to substitute a different library or to reimplement the functionality by hand.

## Electron desktop smoke is verified by the manager, not the executor

`pnpm desktop:smoke` launches Electron, which needs GPU/display access the `workspace-write` sandbox does not provide. It failed for the executor in M2, M3 and M4 while passing every time for the manager (`exitCode 0`).

- Do **not** run `pnpm desktop:smoke` or `pnpm desktop:pack`. A failure there tells you nothing.
- Stop at `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm desktop:prepare`. The manager runs the desktop tier.

## Never migrate the shared production database from a dev run

Browser, desktop and every dev/test run default to the same data directory `%LOCALAPPDATA%\QuantWorkbench`. A dev run that advances `user_version` there **permanently breaks the packaged exe**, which refuses to start with 「数据库版本高于此应用版本」 by design (`src/server/db/migrations.ts`).

- Any run that can apply migrations — `pnpm dev`, `pnpm start`, Playwright reviews, integration tests — must set `QUANT_DATA_DIR` to an isolated path first.
- Whenever `migrations.ts` gains an entry, the packaged exe is stale by definition. Repacking is the manager's job; note it in the milestone report.

## Commit before any major change

Land the previous piece of work before starting the next one. A milestone that is verified but uncommitted is one bad command away from being gone, and a large uncommitted tree makes it impossible to tell which change broke what.

- Manager: verify, then commit, then dispatch the next task. Never dispatch on top of an unreviewed dirty tree.
- Executor: never commit or push. Report and stop; the manager commits.

## The working tree is shared — check ownership before reverting

The user edits this repository directly while tasks run. An uncommitted change that is outside the current task's scope is **not** evidence that the executor made it.

- Before `git checkout --`, `git restore`, `git stash` or any revert of uncommitted work: check the file's modification time against the last dispatch, and check for other running processes. If ownership is unclear, ask.
- A revert of someone else's work in progress is irreversible. Losing it costs far more than leaving an unexplained diff in the tree.
- `src/server/mcp.ts` and its UI copy are currently owned by the user. Do not modify, revert, or include them in commits.
