import {
  task,
  prior,
  equity,
  artifact,
  delivery,
  json,
} from "./lib/research-r2a4";
import { captureNativeChanObservations } from "../src/server/strategies/strategy-center-native";
import { closeCzsc } from "../src/server/strategies/chan/czsc";
import type { FrozenValidationInput } from "../src/server/research/validation-capture";
import { writeFile, readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
type Capture = FrozenValidationInput["native"][number] & { elapsedMs: number };
const original = await prior<Capture[]>("native-input");
const command = process.argv[2] ?? "verify";
if (command === "verify") {
  const chosen = original.slice(0, 3);
  const { dataset } = await equity(chosen.map((c) => c.symbol));
  const proof = [];
  try {
    for (const old of chosen) {
      const i = dataset.instruments.find((i) => i.symbol === old.symbol)!;
      const first = i.signalBars.findIndex(
        (b) => b.date === old.capture.originDate,
      );
      const bars = i.signalBars.slice(first);
      const start = performance.now();
      const capture = await captureNativeChanObservations(
        bars,
        140,
        undefined,
        undefined,
        (done, total) => {
          if (done % 1000 === 0)
            console.log(JSON.stringify({ symbol: old.symbol, done, total }));
        },
      );
      const identical = JSON.stringify(capture) === JSON.stringify(old.capture);
      proof.push({
        symbol: old.symbol,
        bars: bars.length,
        observations: capture.observations.length,
        originalMs: old.elapsedMs,
        currentMs: performance.now() - start,
        identical,
      });
      await writeFile(
        join(task, "native-parity.json"),
        JSON.stringify(proof, null, 2),
      );
      if (!identical)
        throw new Error(
          "Compact native projection differs from full-prefix frozen reference",
        );
    }
  } finally {
    await closeCzsc();
  }
  await delivery({
    nativeParity: {
      status: "passed",
      proof,
      implementation:
        "v22 has no append API. Full causal prefix builds retained; only required stroke tables decoded/transferred. Exact observation/audit/pending/prefixHash equality on all bars of3 frozen stocks.",
    },
  });
} else if (command === "capture") {
  const proof = await json<{ identical: boolean }[]>(
    join(task, "native-parity.json"),
  );
  if (proof.length < 3 || proof.some((p) => !p.identical))
    throw new Error("Native parity required");
  const plan = await prior<{ order: string[] }>("native-plan");
  const csi = await json<{ native: { mainOrder: string[] } }>(
    join(task, "csi800.json"),
  );
  const order = [
    ...plan.order,
    ...csi.native.mainOrder.filter((s) => !plan.order.includes(s)),
  ];
  let captures = [...original];
  const started = performance.now();
  const progressFile = join(task, "native-progress.json");
  let previousMs = 0;
  const chunks: { path: string; sha256: string; bytes: number }[] = [];
  try {
    const saved = await json<{ chunks: typeof chunks; elapsedMs: number }>(
      progressFile,
    );
    for (const c of saved.chunks) {
      const raw = await readFile(c.path);
      const { digest } = await import("./lib/research-r2a4");
      if (digest(raw) !== c.sha256)
        throw new Error("Native progress hash mismatch");
      chunks.push(c);
    }
    captures = (
      await Promise.all(
        chunks.map(
          async (c) =>
            JSON.parse(
              gunzipSync(await readFile(c.path), {
                maxOutputLength: 256 * 1024 ** 2,
              }).toString(),
            ) as Capture[],
        ),
      )
    ).flat();
    previousMs = saved.elapsedMs;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const budget = 60 * 60000,
    size = 60;
  const elapsed = () => previousMs + performance.now() - started;
  const persist = async () => {
    const chunk = Math.floor((captures.length - 1) / size);
    chunks[chunk] = await artifact(
      `native-${chunk}`,
      captures.slice(chunk * size),
    );
    await writeFile(
      progressFile,
      JSON.stringify(
        {
          chunks,
          elapsedMs: elapsed(),
          completed: captures.map((c) => c.symbol),
        },
        null,
        2,
      ),
    );
  };
  const captureOne = async (symbol: string) => {
    if (captures.some((c) => c.symbol === symbol)) return;
    const { dataset } = await equity([symbol]);
    const i = dataset.instruments.find((i) => i.symbol === symbol)!;
    const first = i.signalBars.findIndex((b) => b.date >= "2010-01-01");
    if (first < 140) throw new Error("Native fixed origin unavailable");
    const start = performance.now();
    const capture = await captureNativeChanObservations(
      i.signalBars.slice(first - 140),
      140,
      AbortSignal.timeout(3600000),
    );
    captures.push({ symbol, capture, elapsedMs: performance.now() - start });
    await persist();
    await delivery({
      chanSubset: {
        status: "capturing",
        completed: captures.length,
        planned: order.length,
        elapsedMs: elapsed(),
        chunks,
      },
      nextStart: "Resume native fixed-order prefix from durable chunks",
    });
    console.log(
      JSON.stringify({
        symbol,
        completed: captures.length,
        planned: order.length,
        elapsedMs: performance.now() - start,
      }),
    );
  };
  try {
    for (const symbol of order) {
      if (elapsed() > budget) break;
      await captureOne(symbol);
    }
    // Declared before any native strategy outcome: supplement the CSI intersection
    // after the broad time cutoff with sorted pre-2010 eligible constituents.
    for (const symbol of [...csi.native.mainOrder].sort()) {
      if (
        captures.filter((c) => csi.native.mainOrder.includes(c.symbol))
          .length >= 30
      )
        break;
      await captureOne(symbol);
    }
    await artifact("native-manifest", {
      order,
      completed: captures.map((c) => c.symbol),
      chunks,
      elapsedMs: elapsed(),
      cutoff:
        captures.length < order.length
          ? "Fixed60min broad capture plus predeclared CSI minimum30 supplement"
          : "all-fixed-members",
      csiIntersection: captures
        .filter((c) => csi.native.mainOrder.includes(c.symbol))
        .map((c) => c.symbol),
    });
    await delivery({
      chanSubset: {
        status: "capture-complete",
        completed: captures.length,
        planned: order.length,
        chunks,
        elapsedMs: elapsed(),
      },
    });
  } finally {
    await closeCzsc();
  }
} else throw new Error("Expected verify or capture");
process.exit(0);
