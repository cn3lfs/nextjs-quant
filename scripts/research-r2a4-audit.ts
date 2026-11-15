import {
  task,
  json,
  prior,
  artifact,
  delivery,
  equity,
  crypto,
  digest,
} from "./lib/research-r2a4";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { marketRules } from "trading-strategy-core/market-rules";
import { gunzipSync } from "node:zlib";
import {
  runPortfolio,
  runValidationSuite,
  type ValidationScore,
} from "quant-backtest";
import {
  projectCandidate,
  scoreValidationResult,
  numericNeighbors,
} from "../src/server/research/validation-replay";
import type { FrozenValidationInput } from "../src/server/research/validation-capture";
import { auditPortfolio } from "../tests/helpers/portfolio-execution-audit";

const inputFile =
  ".test-data/r2a/data/research-validation/input-f85762b68f8d6910b4ac3ec40297ebe6a513b692bb188547c0b950616306ef5f.json";
const bytes = await readFile(inputFile);
if (
  digest(bytes) !==
  "f85762b68f8d6910b4ac3ec40297ebe6a513b692bb188547c0b950616306ef5f"
)
  throw new Error("Original R2a input drift");
const original = JSON.parse(bytes.toString()) as FrozenValidationInput;
const old = await json<{
  result: {
    suites: {
      suite: {
        rows: {
          id: string;
          inSample: ValidationScore;
          holdout: unknown;
          windows: unknown;
        }[];
      };
    }[];
  };
}>(
  ".test-data/r2a/data/research-validation/report-4a8f71172cd1e3a98b3f01177ca3ac812367a3a1d82fb1e5c91fa27d2a35cf57.json",
);
const dataset = original.datasets[0]!;
const candidates = original.candidateMenu
  .filter((c) => c.family === "double-breakout")
  .flatMap((c) => [c, ...numericNeighbors(c)]);
const cache = new Map();
const projected = candidates.map((c) =>
  projectCandidate(c, dataset, original, cache)!,
);
const suite = runValidationSuite(
  projected,
  dataset.dates,
  {
    ...original.input.policy,
    trainBars: Math.max(20, Math.floor(dataset.dates.length * 0.4)),
    testBars: Math.max(5, Math.floor(dataset.dates.length * 0.1)),
  },
  (r, q) => scoreValidationResult(r, q, dataset),
);
function numericDiff(a: unknown, b: unknown, path = ""): unknown[] {
  if (typeof a === "number" && typeof b === "number")
    return Math.abs(a - b) > 1e-10 * Math.max(1, Math.abs(a))
      ? [{ path, old: a, current: b }]
      : [];
  if (a === null || b === null)
    return a === b ? [] : [{ path, old: a, current: b }];
  if (Array.isArray(a) && Array.isArray(b))
    return a.length !== b.length
      ? [{ path, lengths: [a.length, b.length] }]
      : a.flatMap((v, i) => numericDiff(v, b[i], `${path}[${i}]`));
  if (typeof a === "object" && a && typeof b === "object" && b)
    return Object.keys(a)
      .filter((k) => k in b)
      .flatMap((k) =>
        numericDiff(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
          `${path}.${k}`,
        ),
      );
  return [];
}
const reconciliation = suite.rows.map((row) => {
  const expected = old.result.suites[0]!.suite.rows.find(
    (r) => r.id === row.id,
  )!;
  return {
    id: row.id,
    oldHoldout: expected.holdout,
    currentHoldout: row.holdout,
    numericDifferences: [
      ...numericDiff(expected.inSample, row.inSample, "inSample"),
      ...numericDiff(expected.windows, row.windows, "windows"),
      ...numericDiff(expected.holdout, row.holdout, "holdout"),
    ],
  };
});
await writeFile(
  join(task, "reconciliation8.json"),
  JSON.stringify(
    {
      sourceCommit: "cc934c7",
      inputHash: digest(bytes),
      symbols: dataset.instruments.map((i) => i.symbol),
      start: dataset.dates[0],
      end: dataset.dates.at(-1),
      rows: reconciliation,
    },
    null,
    2,
  ),
);
await delivery({
  reconciliation8: {
    status: reconciliation.every((r) => !r.numericDifferences.length)
      ? "exact-numeric-parity"
      : "differences-investigating",
    file: ".test-data/r2a4/reconciliation8.json",
    candidates: reconciliation.length,
    differences: reconciliation.reduce(
      (n, r) => n + r.numericDifferences.length,
      0,
    ),
  },
});
console.log(
  JSON.stringify({
    phase: "reconciliation8",
    differences: reconciliation.map((r) => [r.id, r.numericDifferences.length]),
  }),
);
const audits = [];
for (const variant of ["atr", "time"]) {
  const p = projected.find(
    (c) => c.id === `r2a-cn-equity-double-breakout-${variant}`,
  )!;
  const q = {
    ...p.request,
    start: suite.rows[0]!.holdout.start,
    end: suite.rows[0]!.holdout.end,
  };
  const result = runPortfolio(q);
  const checked = auditPortfolio(
    q,
    result,
    variant === "atr" ? { period: 14, multiple: 3 } : undefined,
  );
  audits.push({ id: p.id, scope: "Original 8, original holdout", ...checked });
}
await writeFile(
  join(task, "engine-audit-equity8.json"),
  JSON.stringify(audits, null, 2),
);
console.log(
  JSON.stringify({
    phase: "equity8-audit",
    checks: audits.map((a) => ({
      id: a.id,
      fills: a.fills,
      differences: a.differences.length,
      samples: a.samples.length,
    })),
  }),
);
const mode = process.argv[2];
if (mode !== "equity8" && !mode?.startsWith("crypto15")) {
  const full = await equity();
  const menu = full.base.candidateMenu;
  const cache = new Map();
  for (const variant of mode === "equity-time" ? ["time"] : ["atr", "time"]) {
    const c = menu.find(
      (c) => c.family === "double-breakout" && c.variant === variant,
    )!;
    const p = projectCandidate(c, full.dataset, full.base, cache)!;
    const oldGroup = await prior<{
      checkpoints: {
        row: {
          id: string;
          holdout: { start: string; end: string; base: ValidationScore };
        };
      }[];
    }>("candidate-cnswing-double-breakout");
    const oldRow = oldGroup.checkpoints.find((c) => c.row.id === p.id)!.row;
    const request = {
      ...p.request,
      start: oldRow.holdout.start,
      end: oldRow.holdout.end,
    };
    const result = runPortfolio(request);
    const checked = auditPortfolio(
      request,
      result,
      variant === "atr" ? { period: 14, multiple: 3 } : undefined,
    );
    const score = scoreValidationResult(result, request, full.dataset);
    audits.push({
      id: p.id,
      scope: "All 1638, original R2a3 holdout",
      ...checked,
    });
    await writeFile(
      join(task, `engine-audit-${variant}.json`),
      JSON.stringify(
        {
          score,
          differencesFromPrior: numericDiff(oldRow.holdout.base, score),
          ...checked,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({
        phase: "full-equity-audit",
        id: p.id,
        differences: checked.differences.length,
        fills: checked.fills,
      }),
    );
  }
}
if (mode?.startsWith("crypto15")) {
  const oldGroup = await prior<{
    checkpoints: {
      row: { id: string; holdout: { start: string; end: string } };
    }[];
  }>("candidate-crypto-range-15m");
  const originalWindow = oldGroup.checkpoints.find(
    (c) => c.row.id === "r2a-crypto-range-15m-atr",
  )!.row.holdout;
  const c = await crypto("15m", undefined, originalWindow.start);
  const candidate = c.base.candidateMenu.find(
    (x) => x.family === "range-15m" && x.variant === "atr",
  )!;
  const p = projectCandidate(candidate, c.dataset, c.base, new Map())!;
  const start = originalWindow.start;
  const request = { ...p.request, start };
  console.log(
    JSON.stringify({
      phase: "crypto15-engine-start",
      start,
      clock: request.calendar.length,
      instruments: request.instruments.length,
    }),
  );
  const result =
    mode === "crypto15-recheck"
      ? (JSON.parse(
          gunzipSync(
            await readFile(
              join(task, "artifacts", "audit-crypto15-fills.json.gz"),
            ),
            { maxOutputLength: 256 * 1024 ** 2 },
          ).toString(),
        ) as ReturnType<typeof runPortfolio>)
      : runPortfolio(request, (done, total) =>
          console.log(
            JSON.stringify({ phase: "crypto15-engine", done, total }),
          ),
        );
  if (mode !== "crypto15-recheck")
    await artifact("audit-crypto15-fills", {
      orders: result.orders,
      fills: result.fills,
      rejections: result.rejections,
      positions: result.positions,
      equity: result.equity,
    });
  const checked = auditPortfolio(request, result, {
    period: 14,
    multiple: 1.5,
  });
  const entry = new Map<string, { quantity: number; price: number }>();
  let gross = 0,
    fees = 0,
    slippage = 0;
  const slip = marketRules.crypto.costs!.slippageBps / 10000;
  for (const f of result.fills) {
    const key = f.symbol;
    const reference = f.price / (1 + (f.side === "buy" ? 1 : -1) * slip);
    fees += f.fee;
    slippage += Math.abs(f.price - reference) * f.quantity;
    if (f.side === "buy")
      entry.set(key, { quantity: f.quantity, price: reference });
    else {
      const prior = entry.get(key)!;
      gross += (reference - prior.price) * f.quantity;
      entry.delete(key);
    }
  }
  let openGross = 0;
  for (const [symbol, p] of entry) {
    const mark = result.positions.find((x) => x.symbol === symbol)!.mark;
    openGross += p.quantity * (mark - p.price);
  }
  const net = result.equity.at(-1)!.equity - request.initial;
  const attribution = {
    scope:
      "20-pair prior holdout, fixed fills cash attribution; not a zero-cost rerun",
    start,
    end: request.end,
    score:
      mode === "crypto15-recheck"
        ? (
            JSON.parse(
              gunzipSync(
                await readFile(
                  join(task, "artifacts", "breakout-15m-audit.json.gz"),
                ),
              ).toString(),
            ) as { score: ValidationScore }
          ).score
        : scoreValidationResult(result, request, c.dataset),
    grossClosedPnl: gross,
    openGross,
    grossPnl: gross + openGross,
    fees,
    slippage,
    netPnl: net,
    reconciliationResidual: net - (gross + openGross - fees - slippage),
    rejections: checked.rejections,
    fills: result.fills.length,
    audit: checked,
  };
  await artifact("breakout-15m-audit", attribution);
  audits.push({ id: p.id, scope: "20-pair prior holdout", ...checked });
  await delivery({
    breakout15mAttribution: {
      status: "20-pair-audited-btc-eth-pending",
      artifact: "breakout-15m-audit",
      grossClosedPnl: gross,
      fees,
      slippage,
      rejections: checked.rejections,
    },
  });
}
const passed =
  audits.every((a) => !a.differences.length && a.samples.length >= 20) &&
  reconciliation.every((r) => !r.numericDifferences.length);
await delivery({
  engineAudit: {
    status: passed
      ? "audited-awaiting-low-and-edge-controls"
      : "differences-investigating",
    audits: audits.map((a) => ({
      id: a.id,
      scope: a.scope,
      fills: a.fills,
      samples: a.samples.length,
      differences: a.differences.length,
    })),
    next: "Add explicit refusal/T+1/gap controls and low-zone tranche audit before accepting engine",
  },
  nextStart:
    "Resolve independent execution differences, then complete CSI800/crypto source capture",
});
process.exit(passed ? 0 : 1);
