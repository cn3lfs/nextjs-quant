import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
  rename,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { strategyBuildHash } from "trading-strategies";
import { dataDirectory } from "../db";
import { validationInputSchema } from "./validation-model";
import {
  validationHash,
  type FrozenValidationInput,
} from "./validation-capture";
import { validationBuildHash } from "./validation-identity";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const top = z
  .object({
    version: z.literal("research-validation-input-1"),
    input: validationInputSchema,
    strategyBuildHash: digest,
    validationBuildHash: digest,
    datasets: z
      .array(
        z
          .object({
            instruments: z.array(z.unknown()).max(40),
            dates: z.array(z.string()).max(20000),
          })
          .passthrough(),
      )
      .max(4),
    candidateMenu: z.array(z.unknown()).max(100),
    native: z.array(z.unknown()).max(40),
    financials: z.array(z.unknown()).max(40),
    lowZones: z.array(z.unknown()).max(41),
    evidence: z
      .object({
        universeComplete: z.boolean(),
        executionVerified: z.boolean(),
        firstVintageFinancials: z.boolean(),
      })
      .strict(),
  })
  .passthrough();
const directory = () => join(dataDirectory(), "research-validation");
/** Content-addressed immutable inputs/results. Owner deletes after review using
 * the task cleanup script; crashes may leave .pending. Hard 4-GiB/100-file cap
 * rejects new runs instead of silently evicting research evidence. */
export async function writeValidationArtifact(
  kind: "input" | "report",
  value: unknown,
) {
  const root = directory();
  await mkdir(root, { recursive: true });
  const hash = validationHash(value),
    body = JSON.stringify(value);
  const names = await readdir(root);
  const size = (
    await Promise.all(names.map((n) => stat(join(root, n))))
  ).reduce((n, s) => n + s.size, 0);
  if (
    names.length >= 100 ||
    size + Buffer.byteLength(body) > 4 * 1024 ** 3 ||
    Buffer.byteLength(body) > 256 * 1024 ** 2
  )
    throw new Error(
      "Research artifact budget exceeded; review and clean owned inputs before retrying",
    );
  const path = join(root, `${kind}-${hash}.json`);
  try {
    const existing = await readFile(path, "utf8");
    if (existing !== body)
      throw new Error("Content-addressed research artifact collision");
    return hash;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${process.pid}.pending`;
  await writeFile(temporary, body, { flag: "wx" });
  await rename(temporary, path);
  return hash;
}
export async function readValidationInput(hash: string) {
  digest.parse(hash);
  const path = join(directory(), `input-${hash}.json`);
  if ((await stat(path)).size > 256 * 1024 ** 2)
    throw new Error("Frozen input exceeds resource budget");
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (validationHash(value) !== hash)
    throw new Error("Frozen input hash mismatch");
  top.parse(value);
  const frozen = value as FrozenValidationInput;
  if (frozen.strategyBuildHash !== strategyBuildHash)
    throw new Error(
      "Research engine/rule version changed; frozen input cannot be silently reinterpreted",
    );
  if (frozen.validationBuildHash !== validationBuildHash())
    throw new Error(
      "Research validation/metrics adapter version changed; rebuild and capture a new input",
    );
  return frozen;
}
