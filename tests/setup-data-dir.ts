import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// src/server/db/index.ts falls back to %LOCALAPPDATA%\QuantWorkbench when
// QUANT_DATA_DIR is unset, so any test that touches the database without
// isolating it migrates the user's real data. That happened once: a full
// `pnpm test` advanced the shared database to a version the packaged exe
// could not open. Isolate every test file by default instead of relying on
// each one to remember. Tests that set QUANT_DATA_DIR themselves still win,
// because their module body runs after this setup file.
process.env.QUANT_DATA_DIR ??= mkdtempSync(join(tmpdir(), "quant-test-"));
