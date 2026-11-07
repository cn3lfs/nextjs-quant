import {
  blockEligibilityVersion,
  type BlockEligibility,
  excludedBlock,
} from "~/lib/market/block-eligibility";
import {
  industrySnapshotSchema,
  type IndustrySnapshot,
} from "~/lib/screening/industry-rps";
import { readTdxLocalBlocks } from "tstdx/local";
import { rpsHash } from "../infra/content-hash";
import wdzExclusions from "../data/wdz-block-ranking-exclusions.json";

export async function readBlockEligibility(
  tdxRoot: string,
): Promise<BlockEligibility> {
  const source = await readTdxLocalBlocks(tdxRoot);
  return eligibilityFromTdx(source);
}
export function eligibilityFromTdx(
  source: Awaited<ReturnType<typeof readTdxLocalBlocks>>,
): BlockEligibility {
  // WDZ exports use different labels and include extra style groups in 概念.
  // Keep these reviewed identities explicit; never infer from a substring.
  const excluded = [
    ...source.excludedBlocks,
    ...wdzExclusions.groups.flatMap((group) =>
      group.names.map((name) => ({ name, code: null, kind: "style" as const })),
    ),
  ];
  const sourceHash = rpsHash({ tdx: source.hash, wdz: wdzExclusions });
  return {
    version: blockEligibilityVersion,
    sourceHash,
    excluded,
    hash: rpsHash({
      version: blockEligibilityVersion,
      sourceHash,
      excluded,
    }),
  };
}
export function filterBlockSnapshot(
  snapshot: IndustrySnapshot,
  policy: BlockEligibility,
): IndustrySnapshot {
  const removed = snapshot.files.flatMap((file) => {
    const reason = excludedBlock(file.name, file.file, policy);
    return reason
      ? [{ name: file.name, file: file.file, kind: reason.kind }]
      : [];
  });
  if (!removed.length && snapshot.selectionPolicy?.hash === policy.hash)
    return snapshot;
  const names = new Set(removed.map((file) => file.name));
  const files = snapshot.files.filter((file) => !names.has(file.name));
  if (!files.length) throw new Error("排除地区和风格后没有可用板块");
  const selectionPolicy = {
    version: policy.version,
    hash: policy.hash,
    sourceHash: policy.sourceHash,
    previousHash: snapshot.hash,
    removed,
  };
  return industrySnapshotSchema.parse({
    ...snapshot,
    files,
    selectionPolicy,
    hash: rpsHash({
      version: policy.version,
      classification: policy.hash,
      files,
    }),
  });
}
