# Repository guidance

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
