import { createHash } from "node:crypto";
import type { Evidence } from "~/lib/domain";
import { symbolSchema } from "~/lib/domain";
import { annualAmounts } from "./annual-cash-flow";
import {
  annualFinanceMetrics,
  queryFinance,
} from "../../data-sources/hithink/hithink-finance";
import { sharedRead } from "../../infra/shared-read";
import { get, put, sqlite } from "../../db";
import { background, updateJob } from "../../jobs/jobs";
import { isAStock } from "../../data-sources/tdx/tdx";

const fields = {
  revenue: "营业收入",
  operatingCost: "营业成本",
  netProfit: "净利润",
  parentProfit: ["归属于母公司所有者的净利润", "归母净利润"],
  minorityProfit: "少数股东损益",
  assets: ["资产总计", "总资产"],
  equity: ["所有者权益合计", "所有者权益"],
  currentAssets: ["流动资产合计", "流动资产"],
  currentLiabilities: ["流动负债合计", "流动负债"],
  operatingCashFlow: "经营活动产生的现金流量净额",
} as const;
type Key = keyof typeof fields;
type Annual = ReturnType<typeof annualAmounts<Key>>["annual"][number];
type NumberFact = {
  value: number | null;
  currencyBasis: "CNY" | "source-yuan-unspecified" | null;
  citations: string[];
  formula: string;
  missing: string[];
};
function missing(formula: string, reason: string): NumberFact {
  return {
    value: null,
    currencyBasis: null,
    citations: [],
    formula,
    missing: [reason],
  };
}
function read(row: Annual | undefined, key: Key): NumberFact {
  const field = fields[key];
  const label = typeof field === "string" ? field : field[0];
  if (!row) return missing(label, "缺少相邻完整年度，不能用更早年份替代");
  const amount = row.amounts[key];
  return {
    value: amount.value,
    currencyBasis:
      amount.value === null
        ? null
        : amount.currency === "CNY"
          ? "CNY"
          : "source-yuan-unspecified",
    citations: [...new Set(amount.points.map((point) => point.evidenceId))],
    formula: `${label}[${row.period}]`,
    missing: amount.reasons,
  };
}
function derive(
  formula: string,
  inputs: NumberFact[],
  calculate: (...values: number[]) => number,
): NumberFact {
  const citations = [...new Set(inputs.flatMap((input) => input.citations))];
  if (inputs.some((input) => input.value === null))
    return {
      ...missing(formula, "计算所需字段缺失或冲突"),
      citations,
      missing: [...new Set(inputs.flatMap((input) => input.missing))],
    };
  if (new Set(inputs.map((input) => input.currencyBasis)).size !== 1)
    return {
      ...missing(formula, "字段币种标记不一致，不能合并计算"),
      citations,
    };
  const value = calculate(...inputs.map((input) => input.value!));
  return {
    value: Number.isFinite(value) ? value : null,
    currencyBasis: inputs[0]!.currencyBasis,
    citations,
    formula,
    missing: Number.isFinite(value)
      ? []
      : ["分母非正、资产权益口径无效或计算溢出"],
  };
}
const divide = (a: number, b: number) => (b > 0 ? a / b : NaN);
function profit(row: Annual): NumberFact {
  const direct = read(row, "netProfit");
  const combined = derive(
    "归母净利润+少数股东损益",
    [read(row, "parentProfit"), read(row, "minorityProfit")],
    (a, b) => a + b,
  );
  if (direct.value === null) {
    // A supplied but conflicting consolidated figure must not disappear behind a fallback.
    if (row.amounts.netProfit.points.length) return direct;
    return combined;
  }
  if (
    combined.value !== null &&
    (combined.currencyBasis !== direct.currencyBasis ||
      Math.abs(combined.value - direct.value) >
        Math.max(0.01, Math.abs(direct.value) * Number.EPSILON * 8))
  )
    return {
      ...missing(
        "合并净利润与归母+少数股东核对",
        "同年度合并净利润与分项不一致",
      ),
      citations: [...new Set([...direct.citations, ...combined.citations])],
    };
  return direct;
}

/** Dimensionless observations on provider-declared yuan units, not certified valuation inputs. */
export function financialQuality(
  symbol: string,
  evidence: Evidence[],
  now = Date.now(),
) {
  const parsed = annualAmounts(symbol, evidence, fields, now);
  const byPeriod = new Map(parsed.annual.map((row) => [row.period, row]));
  const annual = parsed.annual.map((row) => {
    const previous = byPeriod.get(`${Number(row.period.slice(0, 4)) - 1}1231`);
    const netProfit = profit(row);
    const revenue = read(row, "revenue"),
      assets = read(row, "assets"),
      equity = read(row, "equity");
    const averageAssets = derive(
      "(期初资产+期末资产)/2",
      [read(previous, "assets"), assets],
      (a, b) => (a > 0 && b > 0 ? a / 2 + b / 2 : NaN),
    );
    const averageEquity = derive(
      "(期初权益+期末权益)/2",
      [read(previous, "equity"), equity],
      (a, b) => (a > 0 && b > 0 ? a / 2 + b / 2 : NaN),
    );
    const netMargin = derive(
      "合并净利润/营业收入",
      [netProfit, revenue],
      divide,
    );
    const assetTurnover = derive(
      "营业收入/平均资产",
      [revenue, averageAssets],
      (a, b) => (a >= 0 ? divide(a, b) : NaN),
    );
    const equityMultiplier = derive(
      "平均资产/平均权益",
      [averageAssets, averageEquity],
      divide,
    );
    const roe = derive(
      "净利润率×资产周转率×权益乘数",
      [netMargin, assetTurnover, equityMultiplier],
      (a, b, c) => a * b * c,
    );
    const ocf = read(row, "operatingCashFlow");
    return {
      period: row.period,
      amounts: row.amounts,
      netProfit,
      averageAssets,
      averageEquity,
      ratios: {
        netMargin,
        assetTurnover,
        equityMultiplier,
        roe,
        reportedProfitRoa: derive(
          "合并净利润/期初资产（非原论文非常项目前利润口径）",
          [netProfit, read(previous, "assets")],
          divide,
        ),
        grossMargin: derive(
          "(营业收入-营业成本)/营业收入",
          [revenue, read(row, "operatingCost")],
          (a, b) => (b >= 0 ? divide(a - b, a) : NaN),
        ),
        currentRatio: derive(
          "流动资产/流动负债",
          [read(row, "currentAssets"), read(row, "currentLiabilities")],
          (a, b) => (a >= 0 ? divide(a, b) : NaN),
        ),
        cashToProfit: derive("经营现金流/合并净利润", [ocf, netProfit], divide),
        cashReturnOnOpeningAssets: derive(
          "经营现金流/期初资产",
          [ocf, read(previous, "assets")],
          divide,
        ),
      },
    };
  });
  const latest = annual.at(-1);
  const previous = latest
    ? annual.find(
        (row) =>
          Number(row.period.slice(0, 4)) ===
          Number(latest.period.slice(0, 4)) - 1,
      )
    : undefined;
  type Item = {
    id: string;
    point: 0 | 1 | null;
    citations: string[];
    reason: string;
  };
  function compare(
    id: string,
    a: NumberFact | undefined,
    b: NumberFact | undefined,
  ): Item {
    if (
      !a ||
      !b ||
      a.value === null ||
      b.value === null ||
      a.currencyBasis !== b.currencyBasis
    )
      return {
        id,
        point: null,
        citations: [
          ...new Set([...(a?.citations ?? []), ...(b?.citations ?? [])]),
        ],
        reason: "相邻年度同口径指标缺失，不能判定",
      };
    return {
      id,
      point: a.value > b.value ? 1 : 0,
      citations: [...new Set([...a.citations, ...b.citations])],
      reason: "仅按提供的相邻年度指标严格大于比较",
    };
  }
  const ocf = latest?.ratios.cashReturnOnOpeningAssets;
  const items: Item[] = [
    {
      id: "roa-positive",
      point: null,
      citations: [],
      reason: "合并净利润不自动等同原论文非常项目前利润，尚未核验该口径",
    },
    {
      id: "cfo-positive",
      point: ocf?.value == null ? null : ocf.value > 0 ? 1 : 0,
      citations: ocf?.citations ?? [],
      reason: "经营现金流正值；来源币种及合并范围仍需独立核验",
    },
    {
      id: "roa-improved",
      point: null,
      citations: [],
      reason: "缺少相邻年度原论文利润口径",
    },
    {
      id: "accrual-quality",
      point: null,
      citations: [],
      reason: "缺少与经营现金流可比的非常项目前利润口径",
    },
    {
      id: "leverage-decreased",
      point: null,
      citations: [],
      reason: "尚未取得含一年内到期部分的完整长期债务，不能用资产负债率替代",
    },
    compare(
      "liquidity-improved",
      latest?.ratios.currentRatio,
      previous?.ratios.currentRatio,
    ),
    {
      id: "no-equity-offering",
      point: null,
      citations: [],
      reason: "全年发行事件尚未核验；期末股本不变不等于未发行新股",
    },
    compare(
      "margin-improved",
      latest?.ratios.grossMargin,
      previous?.ratios.grossMargin,
    ),
    compare(
      "turnover-improved",
      latest?.ratios.assetTurnover,
      previous?.ratios.assetTurnover,
    ),
  ];
  return {
    version: "financial-quality-1",
    symbol,
    annual,
    rejected: parsed.rejected,
    fScore: {
      period: latest?.period ?? null,
      total: null,
      knownPoints: items.reduce((sum, item) => sum + (item.point ?? 0), 0),
      knownCount: items.filter((item) => item.point !== null).length,
      items,
    },
    warnings: [
      "比率为来源元单位归一后的观察值；未独立核验报表币种、合并范围、重述及审计意见，不作为已核验人民币估值输入",
      "杜邦分解使用相邻年末平均资产与平均权益，合并净利润与归母ROE不得混用",
      "F-Score缺项不计作0分，不按已知项目归一化，不输出完整总分或强弱评级",
      "原论文资产周转率正文与表格分母表述不同，本实现明确采用平均资产口径；原论文样本收益不外推当前市场",
      "当前财务数据不代表当时已经公告，不能倒填历史回测",
    ],
  };
}
const shared = sharedRead<Awaited<ReturnType<typeof load>>>();
async function load(
  symbol: string,
  signal: AbortSignal,
  progress?: (done: number, total: number) => void,
) {
  const profiles = [
    "annual-cash-flow",
    ...Object.keys(annualFinanceMetrics),
  ] as ("annual-cash-flow" | keyof typeof annualFinanceMetrics)[];
  const evidence: Evidence[] = [],
    missingProfiles: string[] = [];
  // Two concurrent requests at most, with deterministic source ordering.
  for (let i = 0; i < profiles.length; i += 2) {
    signal.throwIfAborted();
    const batch = profiles.slice(i, i + 2);
    const outcomes = await Promise.allSettled(
      batch.map((profile) => queryFinance(symbol, signal, profile)),
    );
    signal.throwIfAborted();
    outcomes.forEach((outcome, index) =>
      outcome.status === "fulfilled"
        ? evidence.push(outcome.value)
        : missingProfiles.push(batch[index]!),
    );
    progress?.(Math.min(i + batch.length, profiles.length), profiles.length);
  }
  const facts = financialQuality(symbol, evidence);
  const hash = createHash("sha256")
    .update(JSON.stringify({ facts, evidence, missingProfiles }))
    .digest("hex");
  return {
    id: `financial-quality-${hash}`,
    hash,
    createdAt: Date.now(),
    facts,
    evidence,
    missingProfiles,
  };
}
export function gatherFinancialQuality(
  symbol: string,
  signal?: AbortSignal,
  progress?: (done: number, total: number) => void,
) {
  symbolSchema.parse(symbol);
  if (!isAStock(symbol))
    throw new Error(
      "财务质量档案当前仅支持A股公司，不适用于指数、ETF或其他品种",
    );
  if (!process.env.IWENCAI_API_KEY) throw new Error("未配置问财凭证");
  return shared(symbol, (abort) => load(symbol, abort, progress), signal);
}
export type FinancialQualityArchive = Awaited<ReturnType<typeof load>>;
export function financialQualityJob(symbol: string) {
  symbolSchema.parse(symbol);
  if (!isAStock(symbol)) throw new Error("财务质量档案当前仅支持A股公司");
  if (!process.env.IWENCAI_API_KEY) throw new Error("未配置问财凭证");
  return background(
    "research",
    { method: "financial-quality", symbol },
    async (job, signal) => {
      const archive = await gatherFinancialQuality(
        symbol,
        signal,
        (done, total) =>
          updateJob(job.id, {
            phase: `财务资料 ${done}/${total}`,
            progress: Math.round((done / total) * 90),
          }),
      );
      signal.throwIfAborted();
      if (!get(archive.id)) put("financial-quality", archive.id, archive);
      return { reportId: archive.id };
    },
    { method: "financial-quality", symbol },
  );
}
export function financialQualityHistory() {
  return sqlite()
    .prepare(
      `SELECT id, json_extract(payload,'$.createdAt') AS createdAt,
    json_extract(payload,'$.facts.symbol') AS symbol FROM records
    WHERE kind='financial-quality' ORDER BY updated_at DESC,id LIMIT 100`,
    )
    .all() as { id: string; createdAt: number; symbol: string }[];
}
