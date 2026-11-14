import { join } from "node:path";
import { readGbbq, resolveTdxRoot } from "tstdx/local";
import { sourceFingerprint } from "./local-source";

let current:
  | {
      fingerprint: string;
      pending: Promise<Awaited<ReturnType<typeof readGbbq>>>;
    }
  | undefined;

/** One market-wide parse, shared by concurrent readers; failures are never
 * cached. The source identity is checked on every request and after loading. */
export async function corporateActions(root: string) {
  const path = join(resolveTdxRoot(root), "T0002/hq_cache/gbbq");
  const fingerprint = await sourceFingerprint(path);
  if (current?.fingerprint !== fingerprint) {
    const pending = readGbbq(root).then(async (value) => {
      if ((await sourceFingerprint(path)) !== fingerprint)
        throw new Error("复权期间公司行动来源变化");
      return value;
    });
    current = { fingerprint, pending };
  }
  const entry = current;
  try {
    return { ...(await entry.pending), fingerprint };
  } catch (error) {
    if (current === entry) current = undefined;
    throw error;
  }
}
