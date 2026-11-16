import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { strategyBuildHash } from "trading-strategies";
import { maBaselineBuildHash } from "quant-backtest";
import {
  runtimeExecutionIdentity,
  forwardExecutionBuildHash,
} from "~/server/research/forward-identity";
const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  directories
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true }));
});
function fixture() {
  mkdirSync(process.env.QUANT_DATA_DIR!, { recursive: true });
  const directory = mkdtempSync(
    join(process.env.QUANT_DATA_DIR!, "runtime-identity-"),
  );
  directories.push(directory);
  const body = "// isolated worker identity fixture\n";
  const manifest = {
    version: "runtime-execution-1",
    hash: "c".repeat(64),
    engineHash: /^[a-f0-9]{64}$/.test(maBaselineBuildHash)
      ? maBaselineBuildHash
      : "b".repeat(64),
    strategyHash: strategyBuildHash,
    workerSha256: createHash("sha256").update(body).digest("hex"),
  };
  writeFileSync(join(directory, "worker.cjs"), body);
  writeFileSync(
    join(directory, "research-validation-identity.json"),
    JSON.stringify(manifest),
  );
  vi.stubEnv("QUANT_WORKER_DIR", directory);
  return { directory, manifest };
}
it("host and worker evidence use one versioned identity asset with the three build hashes", () => {
  const { manifest } = fixture();
  expect(runtimeExecutionIdentity()).toEqual(manifest);
  expect(forwardExecutionBuildHash()).toBe(
    createHash("sha256")
      .update(
        JSON.stringify({
          strategy: manifest.strategyHash,
          engine: manifest.engineHash,
          validation: manifest.hash,
        }),
      )
      .digest("hex"),
  );
});
it("detects worker replacement even after a successful cached verification", () => {
  const { directory } = fixture();
  runtimeExecutionIdentity();
  writeFileSync(
    join(directory, "worker.cjs"),
    "// changed worker bytes and length\n",
  );
  expect(() => runtimeExecutionIdentity()).toThrow("worker bytes");
});
it("does not invent a production identity for missing, retired or mismatched assets", () => {
  const { directory, manifest } = fixture();
  writeFileSync(
    join(directory, "research-validation-identity.json"),
    JSON.stringify({ hash: manifest.hash }),
  );
  expect(() => runtimeExecutionIdentity()).toThrow();
  writeFileSync(
    join(directory, "research-validation-identity.json"),
    JSON.stringify({ ...manifest, strategyHash: "0".repeat(64) }),
  );
  expect(() => runtimeExecutionIdentity()).toThrow("loaded strategy/engine");
  rmSync(join(directory, "research-validation-identity.json"));
  expect(() => runtimeExecutionIdentity()).toThrow();
});
