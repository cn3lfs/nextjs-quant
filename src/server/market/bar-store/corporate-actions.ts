import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseGbbqFile, resolveTdxRoot } from "tstdx/local";
import { sourceFingerprint } from "./local-source";

type Events = ReturnType<typeof parseGbbqFile>["events"];
type CorporateActionsSource = {
  events: Events;
  modified: number;
  path: string;
  fingerprint: string;
};

let parsed: { hash: string; events: Events } | undefined;

const sha256 = (body: Buffer) =>
  createHash("sha256").update(body).digest("hex");

/** Every call verifies the complete file content. Joining an in-flight read
 * would let a caller that started after a rewrite receive the pre-rewrite hash. */
export async function corporateActions(
  root: string,
): Promise<CorporateActionsSource> {
  const path = join(resolveTdxRoot(root), "T0002/hq_cache/gbbq");
  const identity = await sourceFingerprint(path);
  const info = await stat(path);
  if (!info.isFile() || info.size > 64 * 1024 * 1024)
    throw new Error("本地公司行动源不是常规文件或容量超限");

  const body = await readFile(path);
  if (body.length !== info.size) throw new Error("读取期间公司行动来源变化");
  const hash = sha256(body);

  // A rewrite can preserve file metadata. Verify the complete content again
  // before returning a cached parse or publishing a new one.
  const verification = await readFile(path);
  if (
    verification.length !== info.size ||
    sha256(verification) !== hash ||
    (await sourceFingerprint(path)) !== identity
  )
    throw new Error("读取期间公司行动来源变化");

  if (parsed?.hash !== hash)
    parsed = { hash, events: parseGbbqFile(body).events };
  return {
    events: parsed.events,
    modified: info.mtimeMs,
    path,
    fingerprint: `${path}:${hash}`,
  };
}
