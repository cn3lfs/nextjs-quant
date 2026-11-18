import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { resolve } from "node:path";
import { theoryStudyWindows } from "./theory-study";
import { researchDigest } from "../src/server/research/research-run";

const manifests = process.argv.slice(2);
if (manifests.length === 0)
  throw new Error("Supply one or more frozen lifecycle index manifests");

const output = [];
for (const manifest of manifests) {
  const metadata = JSON.parse(await readFile(manifest, "utf8")) as {
    path: string;
    sha256: string;
    bytes: number;
  };
  const compressed = await readFile(metadata.path);
  if (
    compressed.byteLength !== metadata.bytes ||
    researchDigest(compressed) !== metadata.sha256
  )
    throw new Error("Frozen benchmark byte or hash mismatch");
  const { symbol, bars } = JSON.parse(
    gunzipSync(compressed).toString("utf8"),
  ) as {
    symbol: string;
    bars: { date: string; close: number }[];
  };
  if (!["sh000001", "sh000300"].includes(symbol))
    throw new Error("Expected a registered A-share broad index");
  if (
    bars.some(
      (bar, index) =>
        !Number.isFinite(bar.close) ||
        bar.close <= 0 ||
        (index > 0 && bar.date <= bars[index - 1]!.date),
    )
  )
    throw new Error("Invalid ordered index closes");

  for (const window of theoryStudyWindows) {
    const firstIndex = bars.findIndex((bar) => bar.date >= window.start);
    const preStart = firstIndex > 0 ? bars[firstIndex - 1] : undefined;
    const inWindow = bars.filter(
      (bar) => bar.date >= window.start && bar.date <= window.end,
    );
    if (!preStart || !inWindow.length)
      throw new Error("Frozen benchmark lacks the requested reference dates");
    let peak = preStart.close;
    let maxDrawdown = 0;
    for (const { close } of inWindow) {
      peak = Math.max(peak, close);
      maxDrawdown = Math.max(maxDrawdown, 1 - close / peak);
    }
    output.push({
      symbol,
      market: "cn-equity",
      kind: "index-close-price-reference",
      methodology:
        "Frozen pre-window close to final requested close. Price only, no assumed order or dividend.",
      manifest: resolve(manifest),
      sha256: metadata.sha256,
      window,
      observations: inWindow.length,
      firstReferenceDate: preStart.date,
      endDate: inWindow.at(-1)!.date,
      priceReturn: inWindow.at(-1)!.close / preStart.close - 1,
      maxDrawdown,
    });
  }
}
console.log(JSON.stringify(output, null, 2));
