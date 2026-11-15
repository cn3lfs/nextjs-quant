import { z } from "zod";
import { randomUUID } from "node:crypto";
import { createTRPCRouter, capabilityProcedure as p } from "../trpc";
import { PaperRepository } from "../../db/paper-repository";
import { get, put } from "../../db";
import { paperSettingsSchema, mirrorSettingsSchema } from "../../paper/model";
import { registerPaperCandidates } from "../../paper/registration";
import { configurePaperMirror } from "../../paper/mirror";
import { runWorker } from "../../jobs/jobs";
import { beijingClock } from "~/lib/market/market-session";
const id = z.string().min(1).max(240);
const kind = z.enum([
  "order",
  "fill",
  "position",
  "equity",
  "rejection",
  "action",
  "advance",
  "mirror",
]);
export const paperRouter = createTRPCRouter({
  paperAccounts: p("portfolio", "read").query(() =>
    new PaperRepository().summaries(),
  ),
  paperAccount: p("portfolio", "read")
    .input(id)
    .query(({ input }) => {
      const account = new PaperRepository().account(input);
      if (!account) throw new Error("纸面账户不存在");
      return {
        ...account,
        candidates: account.candidates.map((c) => ({
          id: c.strategy.id,
          version: c.strategy.version,
          status: c.row.status,
          reasons: c.row.reasons,
          expectation: c.expectation,
        })),
      };
    }),
  paperFacts: p("portfolio", "read")
    .input(
      z.object({
        id: id.optional(),
        kind,
        page: z.number().int().min(0).max(100000).default(0),
        today: z.boolean().default(false),
      }),
    )
    .query(({ input }) =>
      new PaperRepository().page(
        input.id,
        input.kind,
        input.page,
        input.today ? beijingClock(Date.now()).date : undefined,
      ),
    ),
  paperSettings: p("settings", "read").query(() =>
    paperSettingsSchema.parse(get("paper-settings") ?? {}),
  ),
  savePaperSettings: p("settings", "configure")
    .input(paperSettingsSchema)
    .mutation(({ input }) => {
      const repo = new PaperRepository();
      return repo.atomic(() => {
        const previous = paperSettingsSchema.parse(get("paper-settings") ?? {});
        if (repo.ids().length && previous.grouping !== input.grouping) {
          const startedAt = Math.min(
            ...repo.summaries().map((a) => a.startedAt),
          );
          repo.regroupEmptyAccounts();
          registerPaperCandidates(repo, startedAt, input);
        }
        for (const id of repo.ids()) {
          const a = repo.account(id)!;
          if (!a.lastBar)
            repo.save(
              {
                ...a,
                initial:
                  a.market === "crypto"
                    ? input.cryptoInitial
                    : input.equityInitial,
              },
              a.revision,
            );
        }
        return put("paper-settings", "paper-settings", input);
      });
    }),
  registerPaperCandidates: p("portfolio", "configure").mutation(() =>
    registerPaperCandidates(
      new PaperRepository(),
      Date.now(),
      get("paper-settings") ?? {},
    ),
  ),
  advancePaperAccounts: p("portfolio", "compute").mutation(() =>
    runWorker({ type: "paper-tick", now: Date.now() }),
  ),
  configurePaperMirror: p("portfolio", "configure")
    .input(z.object({ id, mirror: mirrorSettingsSchema }))
    .mutation(({ input }) =>
      configurePaperMirror(
        new PaperRepository(),
        input.id,
        input.mirror,
        Date.now(),
      ),
    ),
  configurePaperInitial: p("portfolio", "configure")
    .input(z.object({ id, initial: z.number().finite().positive().max(1e9) }))
    .mutation(({ input }) => {
      const repo = new PaperRepository();
      return repo.atomic(() => {
        const account = repo.account(input.id);
        if (!account || account.lastBar)
          throw new Error("只能修改尚未推进的纸面账户初始资金");
        return repo.save(
          { ...account, initial: input.initial, mirrorRevision: randomUUID() },
          account.revision,
        );
      });
    }),
});
