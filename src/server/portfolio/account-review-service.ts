import {
  batchTradeLinksSchema,
  reviewTradeFingerprint,
  tradeJournalSchema,
} from "~/lib/portfolio/account-review";
import { activeHoldingRound } from "~/lib/portfolio/holding-protection";
import {
  checkExposureCaps,
  effectiveExposureCaps,
  type AccountTrade,
} from "~/lib/portfolio/account-workspace";
import { closeScanDeadline } from "~/lib/market/close-scan-window";
import { cryptoPeriodEnd } from "~/lib/market/crypto-aggregation";
import { AccountWorkspaceRepository } from "../db/account-workspace-repository";
import { AccountReviewRepository } from "../db/account-review-repository";
import { strategyLabDetail } from "../db/strategy-lab";
import {
  accountAttribution,
  persistAccountTradeLink,
  validateAccountTradeLink,
  type AccountBook,
} from "./account-workspace-service";
import { AlertRepository } from "../db/alert-repository";

function beforeExit(book: AccountBook, trade: AccountTrade) {
  const peers = book.trades.filter(
    (t) =>
      t.id !== trade.id &&
      t.kind === trade.kind &&
      t.account === trade.account &&
      t.market === trade.market &&
      t.symbol === trade.symbol &&
      t.time <= trade.time,
  );
  const tied = peers.filter((t) => t.time === trade.time);
  if (
    tied.some(
      (t) =>
        !t.sourceOrder ||
        !trade.sourceOrder ||
        t.sourceOrder.source !== trade.sourceOrder.source ||
        t.sourceOrder.index === trade.sourceOrder.index,
    )
  )
    return { trades: [], ambiguous: true };
  return activeHoldingRound(
    peers.filter(
      (t) =>
        t.time < trade.time || t.sourceOrder!.index < trade.sourceOrder!.index,
    ),
    trade,
  );
}
function matchingReviewPlans(
  book: AccountBook,
  trade: AccountTrade,
  prospective: boolean,
) {
  let choices = book.facts.plans.filter(
    (p) =>
      p.market === trade.market &&
      p.symbol === trade.symbol &&
      p.createdAt !== undefined &&
      p.createdAt <= trade.time,
  );
  if (trade.side === "buy")
    choices = choices.filter(
      (p) => p.expiresAt !== null && Date.parse(p.expiresAt) >= trade.time,
    );
  else {
    const round = beforeExit(book, trade),
      buys = round.trades.filter((t) => t.side === "buy");
    if (round.ambiguous || !buys.length)
      return {
        plans: [],
        reason: "卖出轮次缺少唯一来源行序或开仓证据，须人工核验",
      };
    for (const buy of buys) {
      if (buy.planId)
        choices = choices.filter(
          (p) =>
            p.id === buy.planId &&
            p.strategyId === buy.strategyId &&
            p.strategyVersion === buy.strategyVersion,
        );
      else if (prospective) {
        const ids = new Set(
          matchingReviewPlans(book, buy, false).plans.map((p) => p.id),
        );
        choices = choices.filter((p) => ids.has(p.id));
      } else
        return {
          plans: [],
          reason: "卖出需同批确认全部入场来源，或先有已核验入场关联",
        };
    }
  }
  choices = choices.filter((plan) => {
    try {
      validateAccountTradeLink(
        {
          tradeId: trade.id,
          planId: plan.id,
          alertKey: null,
          strategyId: plan.strategyId,
          strategyVersion: plan.strategyVersion,
          sleeve: plan.sleeve,
        },
        book,
      );
      return true;
    } catch {
      return false;
    }
  });
  return {
    plans: choices,
    reason:
      choices.length === 0
        ? "没有同证券、方向和有效期内的计划"
        : choices.length > 1
          ? "多个匹配计划，须人工选择"
          : null,
  };
}
export function accountLinkSuggestions(book: AccountBook, batchId?: string) {
  const eligible = book.trades.filter(
    (t) =>
      t.kind !== "paper" &&
      !t.planId &&
      (!batchId ||
        book.facts.fills.some(
          (f) => `delivery:${f.id}` === t.id && f.batchId === batchId,
        )),
  );
  const items = eligible.slice(0, 200).map((trade) => {
    const matching = matchingReviewPlans(book, trade, true);
    return {
      trade,
      fingerprint: reviewTradeFingerprint(trade),
      ...matching,
      ambiguous: matching.plans.length > 1,
    };
  });
  return {
    factVersion: book.facts.version,
    total: eligible.length,
    items,
    notice:
      "同证券、方向及有效期匹配；唯一买入及其卖出可在同一批确认。歧义须人工选择，缺行序不猜轮次，每批最多200条。",
  };
}
export function confirmAccountLinks(
  raw: unknown,
  book: AccountBook,
  repo = new AccountWorkspaceRepository(),
) {
  const input = batchTradeLinksSchema.parse(raw);
  if (input.factVersion !== book.facts.version)
    throw new Error("账户事实已更新，请刷新批量关联");
  // Validate explicit ids, not the global first page: a new import may follow
  // hundreds of older unlinked trades. Build the whole tentative book first.
  const prepared = input.links.map((link) => {
    const trade = book.trades.find((t) => t.id === link.tradeId),
      plan = book.facts.plans.find((p) => p.id === link.planId);
    if (
      !trade ||
      trade.planId ||
      reviewTradeFingerprint(trade) !== link.fingerprint ||
      !plan
    )
      throw new Error("成交内容或匹配计划已变化，未保存任何关联");
    return validateAccountTradeLink(
      {
        tradeId: trade.id,
        planId: plan.id,
        alertKey: null,
        strategyId: plan.strategyId,
        strategyVersion: plan.strategyVersion,
        sleeve: plan.sleeve,
      },
      book,
    );
  });
  const patched = {
    ...book,
    trades: book.trades.map((trade) => {
      const update = prepared.find((p) => p.trade.id === trade.id);
      return update ? { ...trade, ...update.input } : trade;
    }),
  };
  for (const value of prepared) {
    if (
      !matchingReviewPlans(
        patched,
        { ...value.trade, ...value.input },
        false,
      ).plans.some((p) => p.id === value.input.planId)
    )
      throw new Error("同批买卖轮次或匹配计划不一致，未保存任何关联");
  }
  return repo.atomic(() => {
    repo.assertVersion(input.factVersion);
    const now = Date.now();
    const saved = prepared.map((value) =>
      persistAccountTradeLink(value, patched, repo, now),
    );
    return { saved: saved.length };
  });
}
export function saveTradeJournal(
  raw: unknown,
  book: AccountBook,
  repo = new AccountWorkspaceRepository(),
) {
  const input = tradeJournalSchema.parse(raw),
    trade = book.trades.find((t) => t.id === input.tradeId);
  if (!trade || reviewTradeFingerprint(trade) !== input.fingerprint)
    throw new Error("成交内容已变化，请重新核验日志");
  if (trade.side !== "sell" && input.exitReason !== "unknown")
    throw new Error("退出原因只记录在卖出成交上");
  return repo.atomic(() => {
    repo.assertVersion(input.factVersion);
    const { factVersion: _version, ...journal } = input;
    return new AccountReviewRepository(repo.db).saveJournal({
      ...journal,
      updatedAt: Date.now(),
    });
  });
}
const between = (date: string, from: string, to: string) =>
  date.slice(0, 10) >= from && date.slice(0, 10) < to;
export function accountExecutionQuality(
  book: AccountBook,
  from: string,
  to: string,
  repo = new AccountReviewRepository(),
  now = Date.now(),
) {
  const journals = repo.journals();
  const rows = book.trades
    .filter((t) => t.kind !== "paper" && between(t.date, from, to))
    .map((trade) => {
      const plan = book.facts.plans.find((p) => p.id === trade.planId),
        alert = book.facts.events.find(
          (e) => e.key === (trade.alertKey ?? plan?.triggerKey),
        );
      const journal = journals.find(
        (j) =>
          j.tradeId === trade.id &&
          j.fingerprint === reviewTradeFingerprint(trade),
      );
      const entry =
        plan?.stages && plan.stages.length > 1 ? null : (plan?.entry ?? null);
      const snapshot = plan
        ? repo.protectionSnapshots(
            plan.id,
            trade.account,
            trade.time,
            trade.kind,
            trade.market,
            trade.symbol,
          )[0]
        : undefined;
      const dynamicUnavailable = snapshot?.task.status === "needs-review";
      const stop =
        trade.side === "sell"
          ? dynamicUnavailable
            ? null
            : (snapshot?.task.newStop ?? plan?.stop ?? null)
          : null;
      const stopBasis = dynamicUnavailable
        ? "退出前动态保护需重核，不用初始价替代"
        : snapshot
          ? "退出前已观察的动态保护快照"
          : "仅初始计划止损，未认证动态保护";
      const exact = trade.timePrecision === "instant";
      const bps = (base: number | null | undefined) =>
        base != null && base > 0 && Number.isFinite(trade.price)
          ? (trade.price / base - 1) * 10000
          : null;
      return {
        tradeId: trade.id,
        account: trade.account,
        kind: trade.kind,
        market: trade.market,
        symbol: trade.symbol,
        side: trade.side,
        date: trade.date,
        quantity: trade.quantity,
        fillPrice: trade.price,
        planId: plan?.id ?? null,
        alertKey: alert?.key ?? null,
        alertPrice: trade.side === "buy" ? (alert?.price ?? null) : null,
        planEntry: trade.side === "buy" ? entry : null,
        stop,
        stopBasis,
        initialStop: plan?.stop ?? null,
        alertToFillBps: trade.side === "buy" ? bps(alert?.price) : null,
        planToFillBps: trade.side === "buy" ? bps(entry) : null,
        stopToExitBps: trade.side === "sell" ? bps(stop) : null,
        alertToPlanMs:
          plan?.createdAt !== undefined &&
          alert &&
          plan.createdAt >= alert.observedAt
            ? plan.createdAt - alert.observedAt
            : null,
        planToFillMs:
          exact && plan?.createdAt !== undefined && trade.time >= plan.createdAt
            ? trade.time - plan.createdAt
            : null,
        exitReason: journal?.exitReason ?? "unknown",
        note: journal?.note ?? "",
        tags: journal?.tags ?? [],
        fingerprint: reviewTradeFingerprint(trade),
        reason: !plan
          ? "成交尚未关联计划，执行差额留空"
          : entry === null && trade.side === "buy"
            ? "多档入场未核定具体档位，计划价差留空"
            : trade.side === "sell" && !snapshot
              ? "仅对比初始计划止损；缺少退出前的移动保护快照，不能认定止损触发"
              : "价差仅比较已记录参考价，不认证触发原因或可成交性",
      };
    });
  const alerts = book.facts.events
    .filter((e) => e.type === "entry" && between(e.bar, from, to))
    .flatMap((event) => {
      const plan = book.facts.plans.find((p) => p.triggerKey === event.key),
        definition = book.facts.definitions.find(
          (s) => s.id === event.strategyId && s.version === event.version,
        );
      if (
        book.trades.some(
          (t) =>
            t.kind !== "paper" &&
            (t.alertKey === event.key || (plan && t.planId === plan.id)),
        )
      )
        return [];
      let deadline: number | null = null;
      if (definition) {
        const period = definition.period,
          completed =
            event.market === "crypto"
              ? cryptoPeriodEnd(event.bar, period)
              : period === "day" || period === "week"
                ? Date.parse(`${event.bar.slice(0, 10)}T15:00:00+08:00`)
                : Date.parse(event.bar);
        deadline =
          event.market === "cn-equity" &&
          (period === "day" || period === "week")
            ? closeScanDeadline(event.bar.slice(0, 10), book.calendar)
            : completed +
              (period === "day" || period === "week"
                ? 12 * 3600000
                : 5 * 60000);
      }
      if (plan?.expiresAt)
        deadline = Math.max(deadline ?? 0, Date.parse(plan.expiresAt));
      if (
        event.status !== "missed" &&
        !(deadline !== null && deadline < now) &&
        plan?.closeReason !== "cancelled"
      )
        return [];
      return [
        {
          alertKey: event.key,
          symbol: event.symbol,
          market: event.market,
          strategyId: event.strategyId,
          version: event.version,
          mode: event.mode,
          wouldSend: event.wouldSend,
          observationOnly: event.mode !== "live",
          status:
            plan?.closeReason === "cancelled"
              ? ("skipped" as const)
              : event.status === "missed"
                ? ("late" as const)
                : ("unexecuted" as const),
          reason:
            plan?.closeReason === "cancelled"
              ? "用户已明确取消计划；未见关联成交"
              : event.status === "missed"
                ? "提醒已错过有效窗口"
                : "窗口/计划结束尚无已关联成交；不等同于用户主动放弃",
        },
      ];
    });
  return {
    rows,
    alerts,
    notice:
      "买入价差为(成交/参考−1)×10000；卖出保护差额同式，负数表示低于参考。无精确时间/来源不补造延迟，模拟与真实分开，不据此认定券商已执行。",
  };
}
export function accountWeeklyReview(
  book: AccountBook,
  from: string,
  repo = new AccountWorkspaceRepository(),
  now = Date.now(),
) {
  const to = new Date(Date.parse(from) + 7 * 86400000)
    .toISOString()
    .slice(0, 10);
  const execution = accountExecutionQuality(
    book,
    from,
    to,
    new AccountReviewRepository(repo.db),
    now,
  );
  const attribution = accountAttribution(book);
  const suggestions: {
    id: string;
    action: "pause-live" | "reduce";
    strategyId: string | null;
    version: number | null;
    revision: string | null;
    market: string;
    reason: string;
    href: string | null;
  }[] = [];
  const alerts = new AlertRepository(repo.db);
  for (const strategy of book.facts.definitions) {
    const detail = strategyLabDetail(strategy.id, strategy.version, alerts);
    const degraded =
      attribution.some(
        (a) =>
          a.strategyId === strategy.id &&
          a.version === strategy.version &&
          a.flagged,
      ) || detail.forwardAssessment?.verdict === "degraded";
    if (degraded && detail.live)
      suggestions.push({
        id: `pause:${strategy.id}:${strategy.version}`,
        action: "pause-live",
        strategyId: strategy.id,
        version: strategy.version,
        revision: detail.revision,
        market: strategy.market,
        reason:
          "同参数衰减或前推符合度降级，建议人工暂停live提醒；保留研究与观察证据",
        href: null,
      });
  }
  const riskUnknown: string[] = [];
  for (const market of ["cn-equity", "crypto"] as const) {
    const caps = checkExposureCaps({
      positions: book.positions,
      proposed: {
        market,
        symbol: "",
        sleeve: "",
        industry: "",
        value: 0,
        openRisk: 0,
      },
      reserved: book.facts.plans
        .filter((p) => p.market === market && p.status === "open")
        .map((p) => ({
          market,
          symbol: p.symbol,
          sleeve: p.sleeve,
          industry:
            book.industryBySymbol.get(p.symbol)?.length === 1
              ? book.industryBySymbol.get(p.symbol)![0]!
              : (book.positions.find(
                  (r) => r.market === market && r.symbol === p.symbol,
                )?.industry ?? "未知"),
          value:
            p.stages?.reduce((n, s) => n + s.entry * s.quantity, 0) ??
            p.entry * (p.quantity ?? 0),
          openRisk:
            p.stop === null
              ? null
              : (p.stages?.reduce(
                  (n, s) => n + Math.max(s.entry - p.stop!, 0) * s.quantity,
                  0,
                ) ?? Math.max(p.entry - p.stop, 0) * (p.quantity ?? 0)),
        })),
      capital: book.config.alerts.capital,
      caps: effectiveExposureCaps(book.config.accountReview, market),
    });
    const over = caps.filter(
      (c) =>
        c.used !== null && c.used > c.limit && !c.reason.includes("依据不足"),
    );
    for (const cap of caps.filter(
      (c) => c.used === null || c.reason.includes("依据不足"),
    ))
      riskUnknown.push(`${market}/${cap.key}：${cap.reason}`);
    if (over.length)
      suggestions.push({
        id: `reduce:${market}`,
        action: "reduce",
        strategyId: null,
        version: null,
        revision: null,
        market,
        reason: over
          .map(
            (c) =>
              `${c.dimension}/${c.key} ${c.used} > ${c.limit}；建议人工降低风险或调整分仓`,
          )
          .join("；"),
        href: "/system/notifications",
      });
  }
  return {
    from,
    to,
    execution,
    suggestions,
    riskUnknown,
    notice:
      "周复盘只提出建议；暂停live需要逐项点击确认，降低风险仅跳转核对，不自动交易或修改分仓。",
  };
}
