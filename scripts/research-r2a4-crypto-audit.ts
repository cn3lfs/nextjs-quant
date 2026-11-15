import {
  task,
  json,
  artifact,
  readArtifact,
  delivery,
} from "./lib/research-r2a4";
import { mainCrypto } from "./lib/research-r2a4-main-inputs";
import { join } from "node:path";
import { runPortfolio } from "quant-backtest";
import { marketRules } from "trading-strategy-core/market-rules";
import {
  projectCandidate,
  scoreValidationResult,
} from "../src/server/research/validation-replay";
import { auditPortfolio } from "../tests/helpers/portfolio-execution-audit";
const { dataset, base } = await mainCrypto("15m");
const candidate = base.candidateMenu.find(
  (c) => c.family === "range-15m" && c.variant === "atr",
)!;
const projected = projectCandidate(candidate, dataset, base, new Map())!;
const request = { ...projected.request, start: "2025-06-01" };
const result = runPortfolio(request),
  audit = auditPortfolio(request, result, { period: 14, multiple: 1.5 });
if (audit.differences.length || audit.samples.length < 20)
  throw new Error("BTC/ETH independent fill audit failed");
const entry = new Map<string, { quantity: number; price: number }>();
let gross = 0,
  fees = 0,
  slippage = 0;
const slip = marketRules.crypto.costs!.slippageBps / 10000;
for (const f of result.fills) {
  const reference = f.price / (1 + (f.side === "buy" ? 1 : -1) * slip);
  fees += f.fee;
  slippage += Math.abs(f.price - reference) * f.quantity;
  if (f.side === "buy")
    entry.set(f.symbol, { quantity: f.quantity, price: reference });
  else {
    const previous = entry.get(f.symbol)!;
    gross += (reference - previous.price) * f.quantity;
    entry.delete(f.symbol);
  }
}
let openGross = 0;
for (const [symbol, p] of entry)
  openGross +=
    p.quantity *
    (result.positions.find((x) => x.symbol === symbol)!.mark - p.price);
const net = result.equity.at(-1)!.equity - request.initial;
const row = {
  scope:
    "Official native BTC/ETH 15m,2025-06-01 holdout; fixed fills attribution, not a no-cost counterfactual",
  start: request.start,
  end: request.end,
  score: scoreValidationResult(result, request, dataset),
  grossClosedPnl: gross,
  openGross,
  grossPnl: gross + openGross,
  fees,
  slippage,
  netPnl: net,
  reconciliationResidual: net - (gross + openGross - fees - slippage),
  rejections: audit.rejections,
  fills: result.fills.length,
  audit,
};
if (Math.abs(row.reconciliationResidual) > 1e-5)
  throw new Error("Cost attribution did not reconcile");
const pointer = await artifact("breakout-15m-btc-eth-audit", row);
const prior = await readArtifact<{
  grossPnl: number;
  fees: number;
  slippage: number;
  netPnl: number;
  reconciliationResidual: number;
  rejections: unknown;
}>({
  path: join(task, "artifacts/breakout-15m-audit.json.gz"),
  sha256: (await import("./lib/research-r2a4")).digest(
    await (
      await import("node:fs/promises")
    ).readFile(join(task, "artifacts/breakout-15m-audit.json.gz")),
  ),
});
await delivery({
  breakout15mAttribution: {
    status: "both-audited",
    prior20Pairs: { ...prior, audit: undefined, score: undefined },
    btcEth: {
      pointer,
      grossPnl: row.grossPnl,
      fees,
      slippage,
      netPnl: net,
      rejections: row.rejections,
      residual: row.reconciliationResidual,
      fills: row.fills,
      independentSamples: audit.samples.length,
      differences: 0,
    },
  },
});
console.log(
  JSON.stringify({ complete: true, pointer, fills: row.fills, netPnl: net }),
);
process.exit(0);
