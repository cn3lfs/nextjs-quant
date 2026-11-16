import { createHash } from "node:crypto";
import { z } from "zod";
import { AlertRepository } from "../db/alert-repository";
import { PaperRepository } from "../db/paper-repository";
import { actOnLabStrategy, strategyLabDetail } from "../db/strategy-lab";

export const enablePaperShadowSchema = z
  .object({
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    confirmed: z.literal(true),
  })
  .strict();

/** Only registered paper definitions are proposed, without changing their frozen inputs. */
export function paperShadowScanning(repo = new AlertRepository()) {
  const paper = new PaperRepository(repo.db);
  const identities = new Map<string, { id: string; version: number }>();
  for (const id of paper.ids())
    for (const { strategy } of paper.account(id)!.candidates)
      identities.set(`${strategy.id}:${strategy.version}`, strategy);
  const candidates = [...identities.values()]
    .sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version)
    .map(({ id, version }) => {
      const detail = strategyLabDetail(id, version, repo);
      return {
        id,
        version,
        active: detail.shadow?.active === true,
        live: detail.live,
        revision: detail.revision,
        available: detail.strategy !== null && detail.strategy !== undefined,
      };
    });
  return {
    candidates,
    pending: candidates.filter((c) => c.available && !c.active && !c.live)
      .length,
    revision: createHash("sha256")
      .update(JSON.stringify(candidates))
      .digest("hex"),
  };
}

export function enablePaperShadowScanning(
  raw: z.input<typeof enablePaperShadowSchema>,
  repo = new AlertRepository(),
  now = Date.now(),
) {
  const input = enablePaperShadowSchema.parse(raw);
  return repo.atomic(() => {
    const snapshot = paperShadowScanning(repo);
    if (snapshot.revision !== input.revision)
      throw new Error("纸面候选或扫描状态已变化，请重新核对并确认");
    for (const candidate of snapshot.candidates.filter(
      (c) => c.available && !c.active && !c.live,
    ))
      actOnLabStrategy(
        {
          id: candidate.id,
          version: candidate.version,
          revision: candidate.revision,
          action: "shadow",
          confirmed: true,
        },
        repo,
        now,
      );
    return paperShadowScanning(repo);
  });
}
