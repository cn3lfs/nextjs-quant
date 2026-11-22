import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { PaperBuildReviewRepository } from "../db/paper-build-review-repository";
import { runtimeExecutionIdentity } from "../research/forward-identity";
import { runPaperPortfolio } from "../strategies/drivers/paper";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const paperBuildReviewManifestSchema = z
  .object({
    version: z.literal("paper-build-review-1"),
    accountId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    lastBar: z.string().nullable(),
    oldBuild: z.string().nullable(),
    newBuild: z.string(),
    reviewedAt: z.number().finite(),
    strategyHash: sha,
    engineHash: sha,
    validationHash: sha,
    workerSha256: sha,
    accountHash: sha,
    stateHash: sha,
    requestHash: sha,
    resultHash: sha,
    replayedResultHash: sha,
    exact: z.boolean(),
    firstDifference: z
      .object({ path: z.string(), before: z.string(), after: z.string() })
      .nullable(),
  })
  .strict();
export type PaperBuildReviewManifest = z.infer<
  typeof paperBuildReviewManifestSchema
> & { manifestHash: string };
export type PaperBuildReviewWork =
  | { type: "paper-build-review"; id: string }
  | { type: "paper-build-confirm"; manifestHash: string; confirmed: true };
function persistedJson(value: unknown) {
  return JSON.stringify(value, (_key: string, item: unknown) => {
    if (typeof item === "number" && !Number.isFinite(item))
      throw new Error("版本复核遇到非有限执行结果，不能将其转换成空值");
    return item;
  });
}
const preview = (value: unknown) => String(persistedJson(value)).slice(0, 180);
function firstDifference(
  before: unknown,
  after: unknown,
  path = "result",
): PaperBuildReviewManifest["firstDifference"] {
  if (isDeepStrictEqual(before, after)) return null;
  if (
    before !== null &&
    after !== null &&
    typeof before === "object" &&
    typeof after === "object"
  ) {
    const left = before as Record<string, unknown>,
      right = after as Record<string, unknown>;
    for (const key of [
      ...new Set([...Object.keys(left), ...Object.keys(right)]),
    ].sort()) {
      if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key))
        return {
          path: `${path}.${key}`,
          before: preview(left[key]),
          after: preview(right[key]),
        };
      const found = firstDifference(left[key], right[key], `${path}.${key}`);
      if (found) return found;
    }
  }
  return { path, before: preview(before), after: preview(after) };
}
/** Runs the exact stored request. It records only a review manifest and never
 * edits the checkpoint or reinterprets its original bars/financial history. */
export function reviewPaperBuild(
  id: string,
  repo = new PaperBuildReviewRepository(),
): PaperBuildReviewManifest {
  const identity = runtimeExecutionIdentity();
  const snapshot = repo.atomic(() => repo.snapshot(id));
  const replayed = JSON.parse(
    persistedJson(runPaperPortfolio(snapshot.state.request)),
  ) as unknown;
  const exact = isDeepStrictEqual(snapshot.state.result, replayed);
  const value = paperBuildReviewManifestSchema.parse({
    version: "paper-build-review-1",
    accountId: id,
    revision: snapshot.account.revision,
    lastBar: snapshot.account.lastBar,
    oldBuild: snapshot.state.build ?? null,
    newBuild: `${identity.strategyHash}:${identity.engineHash}`,
    reviewedAt: Date.now(),
    strategyHash: identity.strategyHash,
    engineHash: identity.engineHash,
    validationHash: identity.hash,
    workerSha256: identity.workerSha256,
    accountHash: digest(snapshot.accountRaw),
    stateHash: digest(snapshot.raw),
    requestHash: digest(persistedJson(snapshot.state.request)),
    resultHash: digest(persistedJson(snapshot.state.result)),
    replayedResultHash: digest(persistedJson(replayed)),
    exact,
    firstDifference: exact
      ? null
      : firstDifference(snapshot.state.result, replayed),
  });
  const manifestHash = digest(persistedJson(value));
  repo.immutable(
    "paper-build-review",
    `paper-build-review:${manifestHash}`,
    value,
  );
  return { ...value, manifestHash };
}
export function confirmPaperBuild(
  raw: { manifestHash: string; confirmed: true },
  repo = new PaperBuildReviewRepository(),
) {
  const input = z
    .object({ manifestHash: sha, confirmed: z.literal(true) })
    .strict()
    .parse(raw);
  return repo.atomic(() => {
    const value = paperBuildReviewManifestSchema.parse(
      repo.record<unknown>(`paper-build-review:${input.manifestHash}`),
    );
    if (digest(persistedJson(value)) !== input.manifestHash)
      throw new Error("版本复核manifest哈希不符");
    if (
      !value.exact ||
      value.resultHash !== value.replayedResultHash ||
      value.firstDifference !== null
    )
      throw new Error("执行结果不完全一致，不能确认版本；原历史保留");
    const identity = runtimeExecutionIdentity();
    if (
      value.newBuild !== `${identity.strategyHash}:${identity.engineHash}` ||
      value.validationHash !== identity.hash ||
      value.workerSha256 !== identity.workerSha256
    )
      throw new Error("复核后运行版本已变化，请重新复核");
    const snapshot = repo.snapshot(value.accountId);
    if (
      snapshot.account.revision !== value.revision ||
      snapshot.account.lastBar !== value.lastBar ||
      digest(snapshot.accountRaw) !== value.accountHash ||
      digest(snapshot.raw) !== value.stateHash ||
      digest(persistedJson(snapshot.state.request)) !== value.requestHash ||
      digest(persistedJson(snapshot.state.result)) !== value.resultHash ||
      (snapshot.state.build ?? null) !== value.oldBuild
    )
      throw new Error("复核后账户或冻结输入已变化，请重新复核");
    // saveState writes canonical JSON. Refuse a noncanonical external rewrite
    // instead of reformatting any financial bytes during a metadata-only update.
    if (persistedJson(snapshot.state) !== snapshot.raw)
      throw new Error("冻结记录格式已变化，不能证明只更新执行版本");
    const next = {
      ...snapshot.state,
      build: value.newBuild,
      ...(snapshot.state.events ? { engineVersion: value.newBuild } : {}),
    };
    const nextPayload = persistedJson(next);
    const {
      build: _priorBuild,
      engineVersion: _priorEngine,
      ...priorWithoutBuild
    } = snapshot.state;
    const {
      build: _nextBuild,
      engineVersion: _nextEngine,
      ...nextWithoutBuild
    } = next;
    if (persistedJson(priorWithoutBuild) !== persistedJson(nextWithoutBuild))
      throw new Error("版本确认不能改变其他冻结字段");
    repo.replaceBuild(value.accountId, snapshot.raw, nextPayload);
    repo.immutable(
      "paper-build-confirmation",
      `paper-build-confirmation:${input.manifestHash}`,
      {
        manifestHash: input.manifestHash,
        accountId: value.accountId,
        at: Date.now(),
        oldBuild: value.oldBuild,
        newBuild: value.newBuild,
        stateHashBefore: value.stateHash,
        stateHashAfter: digest(nextPayload),
        requestHash: value.requestHash,
        resultHash: value.resultHash,
      },
    );
    return {
      accountId: value.accountId,
      confirmed: true as const,
      manifestHash: input.manifestHash,
      newBuild: value.newBuild,
      financialHistoryChanged: false as const,
    };
  });
}
export function executePaperBuildReview(work: PaperBuildReviewWork) {
  return work.type === "paper-build-review"
    ? reviewPaperBuild(work.id)
    : confirmPaperBuild(work);
}
