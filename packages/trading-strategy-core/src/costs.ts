import { z } from "zod";
// Fixed experiment parameters, not asserted historical fees.
export const executionCostsSchema = z.object({
  version: z.literal("cost-experiment-1").default("cost-experiment-1"),
  commissionBps: z.number().finite().min(0).max(1000).default(3),
  minimumCommission: z.number().finite().min(0).max(10000).default(5),
  sellTaxBps: z.number().finite().min(0).max(1000).default(5),
  transferBps: z.number().finite().min(0).max(1000).optional(),
  dividendTaxBps: z.number().finite().min(0).max(1000).optional(),
  sellTaxSchedule: z
    .object({
      kind: z.literal("cn-equity-historical"),
      multiplier: z.number().finite().positive().default(1),
    })
    .strict()
    .optional(),
  transferSchedule: z
    .object({
      kind: z.literal("cn-equity-transfer"),
      multiplier: z.number().finite().positive().default(1),
    })
    .strict()
    .optional(),
  slippageBps: z.number().finite().min(0).max(1000).default(5),
});
export type ExecutionCosts = z.infer<typeof executionCostsSchema>;
export const defaultExecutionCosts = executionCostsSchema.parse({});

export type ExecutionInstrumentKind =
  | "equity-main"
  | "equity-star"
  | "equity-chinext"
  | "equity-bj"
  | "etf-equity"
  | "etf-t0";
export type ExecutionInstrumentOptions = {
  instrumentKind?: ExecutionInstrumentKind;
  settlementCycle?: "T+0" | "T+1";
  stampDutyExempt?: boolean;
};
export type InstrumentCostOptions = ExecutionInstrumentOptions & {
  historicalTransfer?: "exchange-2015";
  /** Execution price and face value per share in CNY. The pre-August 2015
   * Shanghai fee was based on face value, not trade proceeds. */
  price?: number;
  faceValue?: number;
};

const datedT0Etfs: Readonly<Record<string, string>> = {
  "159001": "2014-10-20",
  "159003": "2014-10-20",
  "159632": "2022-08-03",
  "159649": "2022-10-24",
  "159920": "2015-01-19",
  "159941": "2015-01-19",
  "159509": "2015-01-19",
  "510900": "2015-01-19",
  "520900": "2024-07-10",
};

function instrumentCode(symbol: string) {
  return symbol
    .trim()
    .toLowerCase()
    .replace(/^(sh|sz|bj)[.]?/, "")
    .replace(/[.](sh|sz|bj)$/, "");
}

function instrumentExchange(symbol: string): "sh" | "sz" | "bj" | null {
  const name = symbol.trim().toLowerCase();
  const prefix = /^(sh|sz|bj)[.]?/.exec(name);
  if (prefix) return prefix[1] as "sh" | "sz" | "bj";
  const suffix = /[.](sh|sz|bj)$/.exec(name);
  if (suffix) return suffix[1] as "sh" | "sz" | "bj";
  return null;
}

/** Exchange-aware ETF classifier shared across panel ingestion and execution rules. */
export function isCnEtfSymbol(symbol: string): boolean {
  const exchange = instrumentExchange(symbol);
  const code = instrumentCode(symbol);
  if (exchange === "sh") return /^(?:51|52|53|56|58)\d{4}$/.test(code);
  if (exchange === "sz") return /^15[89]\d{3}$/.test(code);
  if (exchange === "bj") return false;
  return /^(?:(?:51|52|53|56|58)\d{4}|15[89]\d{3})$/.test(code);
}

/** Explicit metadata identifies products which share a code family with other ETFs.
 * Other research symbols without metadata retain the ordinary equity scenario. */
export function executionInstrumentKind(
  symbol: string,
  date: string,
  options?: ExecutionInstrumentOptions,
): ExecutionInstrumentKind {
  const day = feeDay(date);
  const name = symbol.trim().toLowerCase();
  const exchange = instrumentExchange(name);
  const code = instrumentCode(name);
  const etfFamily = isCnEtfSymbol(name);
  if (options?.instrumentKind) {
    const etf = options.instrumentKind.startsWith("etf-");
    const stockFamily =
      /^(00|30|60|68|43|83|87|88|92)/.test(code) || exchange === "bj";
    if (/^\d{6}$/.test(code) && ((stockFamily && etf) || (etfFamily && !etf)))
      throw new Error("Instrument metadata conflicts with the security code");
    return options.instrumentKind;
  }
  if (/^\d{6}$/.test(code)) {
    if (etfFamily) {
      if (
        (exchange !== "sz" && /^(511|518)/.test(code)) ||
        (exchange !== "sh" && ["159934", "159937"].includes(code))
      )
        return "etf-t0";
      // Codes outside the dedicated families require individual evidence of eligibility.
      const t0From = datedT0Etfs[code];
      if (t0From !== undefined && day >= t0From) return "etf-t0";
      if (exchange !== "sz" && day >= "2015-01-19" && /^513/.test(code))
        return "etf-t0";
      return "etf-equity";
    }
    if (/^68[89]/.test(code)) return "equity-star";
    if (/^30/.test(code)) return "equity-chinext";
    if (exchange === "bj" || /^(43|83|87|88|92)/.test(code)) return "equity-bj";
  }
  return "equity-main";
}

export function scaleResearchCosts(
  costs: ExecutionCosts,
  multiplier: number,
): ExecutionCosts {
  if (!Number.isFinite(multiplier) || multiplier <= 0)
    throw new Error("Invalid research cost multiplier");
  return executionCostsSchema.parse({
    ...costs,
    commissionBps: costs.commissionBps * multiplier,
    minimumCommission: costs.minimumCommission * multiplier,
    sellTaxBps: costs.sellTaxBps * multiplier,
    slippageBps: costs.slippageBps * multiplier,
    ...(costs.transferBps !== undefined && {
      transferBps: costs.transferBps * multiplier,
    }),
    ...(costs.dividendTaxBps !== undefined && {
      dividendTaxBps: costs.dividendTaxBps * multiplier,
    }),
    ...(costs.sellTaxSchedule && {
      sellTaxSchedule: {
        ...costs.sellTaxSchedule,
        multiplier: costs.sellTaxSchedule.multiplier * multiplier,
      },
    }),
    ...(costs.transferSchedule && {
      transferSchedule: {
        ...costs.transferSchedule,
        multiplier: costs.transferSchedule.multiplier * multiplier,
      },
    }),
  });
}

/** Lab and research CLIs share these three explicit scenarios. `fixed` keeps
 * the legacy lab default (no historical stamp-duty switch); `base` and
 * `double-cost` use the declared historical schedule. */
export const researchCostScenarios = ["fixed", "base", "double-cost"] as const;
export type ResearchCostScenario = (typeof researchCostScenarios)[number];

/** Pure cost construction, never broker-history certification. */
export function researchExecutionCosts(
  market: "cn-equity" | "crypto",
  scenario: ResearchCostScenario,
): ExecutionCosts {
  if (scenario === "double-cost")
    return scaleResearchCosts(researchExecutionCosts(market, "base"), 2);
  if (scenario === "fixed")
    return executionCostsSchema.parse(
      market === "crypto"
        ? {
            commissionBps: 10,
            minimumCommission: 0,
            sellTaxBps: 0,
            slippageBps: 5,
          }
        : {
            commissionBps: 3,
            minimumCommission: 5,
            sellTaxBps: 5,
            slippageBps: 5,
          },
    );
  return executionCostsSchema.parse({
    commissionBps: market === "crypto" ? 10 : 3,
    minimumCommission: market === "crypto" ? 0 : 5,
    sellTaxBps: market === "crypto" ? 0 : 5,
    ...(market === "cn-equity"
      ? {
          transferBps: 0.1,
          sellTaxSchedule: {
            kind: "cn-equity-historical",
            multiplier: 1,
          },
          transferSchedule: {
            kind: "cn-equity-transfer",
            multiplier: 1,
          },
        }
      : {}),
    slippageBps: 5,
  });
}

function feeDay(date: string) {
  const day = date.slice(0, 10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !Number.isFinite(Date.parse(day)) ||
    new Date(day).toISOString().slice(0, 10) !== day
  )
    throw new Error("Invalid fee date");
  return day;
}
export function equityStampDutyBps(date: string) {
  const day = feeDay(date);
  return historicalFeeScenarios.find((row) => day >= row.from)!.sellTax * 10000;
}
export function equityTransferBps(date: string) {
  const day = feeDay(date);
  return (
    historicalFeeScenarios.find((row) => day >= row.from)!.transfer * 10000
  );
}
/** Only explicitly declared historical scenarios vary by date. Legacy fixed
 * costs retain both their values and object identity. */
export function executionCostsForDate(
  costs: ExecutionCosts,
  date: string,
): ExecutionCosts {
  if (!costs.sellTaxSchedule && !costs.transferSchedule) return costs;
  return {
    ...costs,
    ...(costs.sellTaxSchedule
      ? {
          sellTaxBps:
            equityStampDutyBps(date) * costs.sellTaxSchedule.multiplier,
        }
      : {}),
    ...(costs.transferSchedule
      ? {
          transferBps:
            equityTransferBps(date) * costs.transferSchedule.multiplier,
        }
      : {}),
  };
}

const historicalFeeScenarios = [
  { from: "2023-08-28", transfer: 0.00001, sellTax: 0.0005 },
  { from: "2022-04-29", transfer: 0.00001, sellTax: 0.001 },
  { from: "", transfer: 0.00002, sellTax: 0.001 },
] as const;

/** Preserve the caller's selected stock scenario. ETF secondary-market trades
 * use commission/slippage but have neither equity transfer fees nor stamp duty. */
export function executionCostsForInstrument(
  costs: ExecutionCosts,
  symbol: string,
  date: string,
  options?: InstrumentCostOptions,
): ExecutionCosts {
  const kind = executionInstrumentKind(symbol, date, options);
  const etf = kind === "etf-equity" || kind === "etf-t0";
  const dated = executionCostsForDate(costs, date);
  const exempt = etf || options?.stampDutyExempt === true;
  const exchangeTransfer =
    !exempt &&
    options?.historicalTransfer === "exchange-2015" &&
    !!costs.transferSchedule &&
    date.slice(0, 10) < "2015-08-01";
  if (!exempt && !exchangeTransfer) return dated;
  const result = { ...dated };
  if (exchangeTransfer) {
    // SSE/ChinaClear joint fee notice of 2015-07-01. Express the per-face-
    // value SH fee as bps at this fill price for existing fee calculators.
    const name = symbol.trim().toLowerCase();
    const sh = /^sh|\.sh$/.test(name) || /^6\d{5}$/.test(name);
    const sz = /^sz|\.sz$/.test(name) || /^[03]\d{5}$/.test(name);
    if (!sh && !sz)
      throw new Error("Pre-2015 transfer fee requires SH or SZ exchange");
    const { price, faceValue } = options;
    if (
      sh &&
      !(
        Number.isFinite(price) &&
        price! > 0 &&
        Number.isFinite(faceValue) &&
        faceValue! > 0
      )
    )
      throw new Error(
        "Pre-2015 Shanghai transfer fee requires fill price and face value",
      );
    result.transferBps =
      (sh ? (3 * faceValue!) / price! : 0.255) *
      costs.transferSchedule!.multiplier;
    delete result.transferSchedule;
  }
  if (exempt) {
    result.sellTaxBps = 0;
    delete result.sellTaxSchedule;
    result.transferBps = 0;
    delete result.transferSchedule;
  }
  return result;
}
/** Original allocation-study fee experiment; no broker-history certification. */
export function historicalEquityResearchFee(
  date: string,
  amount: number,
  sell: boolean,
) {
  const rule = historicalFeeScenarios.find((row) => date >= row.from)!;
  return (
    Math.max(5, amount * 0.0003) +
    amount * rule.transfer +
    (sell ? amount * rule.sellTax : 0)
  );
}
