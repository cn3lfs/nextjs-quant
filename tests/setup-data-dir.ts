import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// src/server/db/index.ts falls back to %LOCALAPPDATA%\QuantWorkbench when
// QUANT_DATA_DIR is unset, so any test that touches the database without
// isolating it migrates the user's real data. That happened once: a full
// `pnpm test` advanced the shared database to a version the packaged exe
// could not open. Isolate every test file by default instead of relying on
// each one to remember. Tests that set QUANT_DATA_DIR themselves still win,
// because their module body runs after this setup file.
// An explicitly supplied directory is a safe parent, not a shared test database.
// Otherwise separate files contaminate one another's persistent cache/schedules.
const testDataParent = process.env.QUANT_DATA_DIR ?? tmpdir();
mkdirSync(testDataParent, { recursive: true });
process.env.QUANT_DATA_DIR = mkdtempSync(join(testDataParent, "quant-test-"));
