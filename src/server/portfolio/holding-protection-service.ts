import { HoldingProtectionRepository } from "../db/holding-protection-repository";
import { AccountWorkspaceRepository } from "../db/account-workspace-repository";
import { AlertRepository } from "../db/alert-repository";
import { loadAccountBook } from "./account-workspace-service";
import { settings } from "../infra/settings";
import {
  holdingProtectionCurrent,
  observeHoldingProtection,
  protectionReviewTask,
  type HoldingProtectionProjection,
} from "~/lib/portfolio/holding-protection";

/** Read the last completed-close projection. Never change a broker order here. */
export async function stopTasks(
  repo = new AccountWorkspaceRepository(),
  config = settings(),
  now = Date.now(),
) {
  const book = await loadAccountBook(repo, config, now, { bars: {} });
  const alerts = new AlertRepository(repo.db);
  return new HoldingProtectionRepository(repo.db).all().flatMap((binding) => {
    if (
      !book.positions.some(
        (p) =>
          p.kind === binding.kind &&
          p.account === binding.account &&
          p.market === binding.market &&
          p.symbol === binding.symbol &&
          p.quantity > 0,
      )
    )
      return [];
    if (!holdingProtectionCurrent(binding, book.trades))
      return [
        protectionReviewTask(
          binding,
          binding.reason ?? "成交内容或归属已变化，保护已断开；请重新核验关联",
        ),
      ];
    const projection = alerts.state<HoldingProtectionProjection>(
      `holding-protection:${binding.id}`,
    );
    return [
      (projection?.bindingAt === binding.boundAt
        ? projection.task
        : undefined) ??
        observeHoldingProtection(binding, [], book.calendar, now).task,
    ];
  });
}
