import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeDirectory = fileURLToPath(
  new URL("../../runtime", import.meta.url),
);
const workerPath = join(runtimeDirectory, "thsdk-worker.cjs");
const workerEntry = fileURLToPath(
  new URL(
    "../../src/server/data-sources/thsdk/thsdk-worker.ts",
    import.meta.url,
  ),
);
const credentialLiteral =
  /\b(?:username|password|passwd|pwd|secret|(?:api|session)[_-]?key|(?:[a-z]+[_-]?)?token|authorization|cookie)["']?\s*[:=]\s*(["'`])(?:(?!\1)[^\r\n])+\1/i;
const guestAccountOrToken =
  /\b(?:thsguest_[a-z0-9]+|Bearer\s+[a-z0-9._~+/=-]{16,}|eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+)\b/i;
const unloadCall = /(?:\.\s*unload|\[\s*["']unload["']\s*\])\s*(?:\?\.\s*)?\(/;

it("packages a THSDK worker without credential literals, tokens, or native unload calls", async () => {
  const worker = existsSync(workerPath)
    ? readFileSync(workerPath, "utf8")
    : (
        await build({
          entryPoints: [workerEntry],
          bundle: true,
          platform: "node",
          format: "cjs",
          target: "node22",
          external: ["koffi"],
          write: false,
        })
      ).outputFiles[0]!.text;

  expect(worker.length).toBeGreaterThan(0);
  // Assert on matches without exposing the bundle or any matched values.
  expect(
    credentialLiteral.test(worker),
    "literal assigned to a credential field",
  ).toBe(false);
  expect(
    guestAccountOrToken.test(worker),
    "guest account or token literal",
  ).toBe(false);
  expect(unloadCall.test(worker), "native library unload call").toBe(false);
});

it("excludes external THSDK DLL, session, and vault artifacts from runtime", () => {
  const entries = existsSync(runtimeDirectory)
    ? readdirSync(runtimeDirectory, { recursive: true, withFileTypes: true })
    : [];
  const forbidden = entries
    .map(({ name }) => name)
    .filter((name) =>
      /^(?:hq\.dll|thsdk-sessions|account\.session|thsdk-credentials\.bin|credentials)$|\.vault$/i.test(
        name,
      ),
    );

  expect(
    forbidden.length,
    "THSDK DLL, sessions, or vault found in runtime",
  ).toBe(0);
});

it("resolves the koffi dependency used by the external worker import", () => {
  expect(existsSync(createRequire(import.meta.url).resolve("koffi"))).toBe(
    true,
  );
});

describe("THSDK config in an isolated data directory", () => {
  const dataParent = resolve(process.env.QUANT_DATA_DIR!);
  let dataDirectory: string;
  let sqlitePath: string;
  let database: typeof import("~/server/db");
  let auth: typeof import("~/server/data-sources/thsdk/thsdk-auth");

  beforeEach(async () => {
    dataDirectory = mkdtempSync(join(dataParent, "thsdk-package-"));
    sqlitePath = join(dataDirectory, "quant.sqlite");
    vi.stubEnv("QUANT_DATA_DIR", dataDirectory);
    vi.resetModules();
    database = await import("~/server/db");
    auth = await import("~/server/data-sources/thsdk/thsdk-auth");
  });

  afterEach(() => {
    try {
      if (existsSync(sqlitePath)) database.sqlite().close();
    } finally {
      vi.unstubAllEnvs();
      if (dirname(dataDirectory) !== dataParent)
        throw new Error("Invalid THSDK test directory");
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  });

  it("reports disabled status on an empty directory without opening SQLite", () => {
    expect(readdirSync(dataDirectory)).toEqual([]);
    expect(auth.getThsdkStatus()).toMatchObject({
      enabled: false,
      state: "disabled",
    });
    expect(existsSync(sqlitePath)).toBe(false);
  });

  it("persists and reads THSDK config without migrating schema v20", () => {
    const db = database.sqlite();
    expect(db.pragma("user_version", { simple: true })).toBe(20);

    const patch = {
      dllPath: join(dataDirectory, "hq.dll"),
      guestModeEnabled: true,
    };
    const saved = auth.saveThsdkConfig(patch);
    expect(saved).toMatchObject(patch);
    expect(auth.readThsdkConfig()).toEqual(saved);
    expect(db.pragma("user_version", { simple: true })).toBe(20);
  });
});
