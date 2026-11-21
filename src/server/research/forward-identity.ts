import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { strategyBuildHash } from "trading-strategies";
import { maBaselineBuildHash } from "quant-backtest";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identitySchema = z
  .object({
    version: z.literal("runtime-execution-1"),
    hash: digest,
    engineHash: digest,
    strategyHash: digest,
    workerSha256: digest,
  })
  .strict();
let cached:
  { key: string; identity: z.infer<typeof identitySchema> } | undefined;
/** Extend the existing validation identity asset and verify the worker from
 * the same build. Missing/retired manifests are unavailable, never invented. */
export function runtimeExecutionIdentity(
  directory = process.env.QUANT_WORKER_DIR ?? join(process.cwd(), "runtime"),
) {
  const identity = identitySchema.parse(
    JSON.parse(
      readFileSync(
        join(directory, "research-validation-identity.json"),
        "utf8",
      ),
    ),
  );
  const path = join(directory, "worker.cjs"),
    stat = statSync(path);
  const key = JSON.stringify([
    directory,
    identity,
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeMs,
    stat.ctimeMs,
    strategyBuildHash,
    maBaselineBuildHash,
  ]);
  if (cached?.key === key) return cached.identity;
  // The manifest is provenance. Only worker byte corruption is fatal here;
  // a strategy/engine build change is reported by the run manifest instead of
  // blocking long research or paper advancement.
  if (
    createHash("sha256").update(readFileSync(path)).digest("hex") !==
    identity.workerSha256
  )
    throw new Error("Runtime worker bytes differ from their build manifest");
  cached = { key, identity: Object.freeze(identity) };
  return cached.identity;
}

/** Bind strategy, execution and method code; the validation worker identity
 * alone does not include every portfolio-engine source file. */
export function forwardExecutionBuildHash() {
  const identity = runtimeExecutionIdentity();
  return createHash("sha256")
    .update(
      JSON.stringify({
        strategy: identity.strategyHash,
        engine: identity.engineHash,
        validation: identity.hash,
      }),
    )
    .digest("hex");
}
