import { join } from "node:path";
import { readGbbq, resolveTdxRoot } from "tstdx/local";
import { sourceFingerprint } from "./local-source";

type Entry = {
  statIdentity: string;
  ready: Promise<{
    value: Awaited<ReturnType<typeof readGbbq>>;
    fingerprint: string;
  }>;
};

let current: Entry | undefined;

/** One market-wide parse, shared by concurrent readers; failures are never
 * cached. Stat identity avoids re-hashing an unchanged large file; the
 * recorded fingerprint is content-addressed, so a same-size/same-timestamp
 * rewrite is not silently reused. The in-flight promise is shared so
 * concurrent first readers still parse only once. */
export async function corporateActions(root: string) {
  const path = join(resolveTdxRoot(root), "T0002/hq_cache/gbbq");
  const statIdentity = await sourceFingerprint(path);
  if (current?.statIdentity !== statIdentity) {
    const ready = (async () => {
      const fingerprint = await sourceFingerprint(path, true);
      const value = await readGbbq(root);
      if ((await sourceFingerprint(path)) !== statIdentity)
        throw new Error("复权期间公司行动来源变化");
      return { value, fingerprint };
    })();
    current = { statIdentity, ready };
  }
  const entry = current;
  try {
    const { value, fingerprint } = await entry.ready;
    return { ...value, fingerprint };
  } catch (error) {
    if (current === entry) current = undefined;
    throw error;
  }
}
