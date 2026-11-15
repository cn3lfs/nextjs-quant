import { PaperRepository } from "../db/paper-repository";
import { get } from "../db";
import { recordRuntimeError } from "../infra/runtime-errors";
import { capabilityAllows } from "~/lib/common/capabilities";
import { registerPaperCandidates } from "./registration";
import { advancePaper, refreshPaperSummary } from "./advance";
import { loadPaperInput } from "./inputs";
import { synchronizePaperMirror } from "./mirror";
import { recordPaperAlerts } from "./alerts";
export type PaperWork = { type: "paper-tick"; now: number };
export async function executePaperTick(work: PaperWork) {
  if (!capabilityAllows("portfolio", "compute"))
    throw new Error("纸面账户计算未开放");
  const repo = new PaperRepository();
  registerPaperCandidates(repo, work.now, get("paper-settings") ?? {});
  for (const id of repo.ids()) {
    try {
      const account = repo.account(id)!;
      const input = await loadPaperInput(account, work.now);
      if (input) {
        advancePaper(repo, id, input, work.now);
        recordPaperAlerts(repo, id, work.now);
      } else refreshPaperSummary(repo, id, work.now);
      await synchronizePaperMirror(repo, id, work.now);
    } catch (error) {
      recordRuntimeError("scheduler-tick", error);
      repo.atomic(() => {
        const account = repo.account(id)!;
        repo.save(
          {
            ...account,
            error:
              "行情、版本或模拟镜像核验未通过；原事实已保留。请检查数据目录、回执和模拟账户配置。",
          },
          account.revision,
        );
      });
    }
  }
  return repo.summaries();
}
