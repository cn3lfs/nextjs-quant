import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { ScreeningInput, ScreeningResult } from "./screening";
import { isAStock } from "./tdx";
import { serialize, deserialize } from "node:v8";
import { packScreen, unpackScreen, type PackedScreen } from "./screen-wire";

const MAX_CACHE_BYTES = 128 * 1024 * 1024;
const entries = new Map<
  string,
  { manifest: string; at: number; payload: Buffer }
>();
let bytes = 0;
export function screeningKey(
  input: ScreeningInput,
  now: number,
  allCompleted = false,
) {
  const local = new Date(now + 8 * 3600000).toISOString();
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: "screen-result-3",
        root: resolve(input.root),
        symbols: [...new Set(input.symbols)].sort(),
        names: Object.entries(input.names ?? {}).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
        // Descriptive names stay in the job input, not in deterministic calculations.
        strategy: Object.entries(input.strategy)
          .filter(([field]) => field !== "name")
          .sort(([a], [b]) => a.localeCompare(b)),
        period: input.period,
        asOf: input.asOf ?? null,
        completion:
          input.period === "day"
            ? `${local.slice(0, 10)}:${local.slice(11, 16) >= "15:05"}`
            : allCompleted
              ? `${local.slice(0, 10)}:all-source-bars-completed`
              : Math.floor(now / 60000),
      }),
    )
    .digest("hex");
}
export async function screeningManifest(
  input: ScreeningInput,
): Promise<string | null> {
  const symbols = [...new Set(input.symbols)].sort();
  if (symbols.some((symbol) => !isAStock(symbol))) return null;
  const signatures: string[] = [];
  let cursor = 0,
    failed = false;
  await Promise.all(
    Array.from({ length: Math.min(32, symbols.length) }, async () => {
      while (cursor < symbols.length) {
        const index = cursor++,
          symbol = symbols[index]!;
        try {
          const info = await stat(
            join(
              resolve(input.root),
              "vipdoc",
              symbol.slice(0, 2),
              input.period === "day" ? "lday" : "fzline",
              `${symbol}.${input.period === "day" ? "day" : "lc5"}`,
            ),
          );
          if (!info.isFile() || !info.size || info.size % 32) {
            failed = true;
            continue;
          }
          signatures[index] =
            `${symbol}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.birthtimeMs}`;
        } catch {
          failed = true;
        }
      }
    }),
  );
  return failed
    ? null
    : createHash("sha256").update(signatures.join("\n")).digest("hex");
}
function forget(key: string) {
  const old = entries.get(key);
  if (old) bytes -= old.payload.byteLength;
  entries.delete(key);
}
export function cachedScreen(
  key: string,
  manifest: string | null,
  now: number,
) {
  const packet = cachedPackedScreen(key, manifest, now);
  return packet ? unpackScreen(packet) : null;
}
export function cachedPackedScreen(
  key: string,
  manifest: string | null,
  now: number,
) {
  const entry = entries.get(key);
  if (!entry) return null;
  // Every lookup revalidates the file manifest; the key includes the evaluation
  // cutoff, names and rules. Elapsed wall time alone does not change this result.
  // Memory remains bounded by the byte limit and LRU entry limit below.
  if (!manifest || manifest !== entry.manifest || now < entry.at) {
    forget(key);
    return null;
  }
  entries.delete(key);
  entries.set(key, entry);
  const packet = deserialize(entry.payload) as PackedScreen;
  // Depending on alignment V8 can expose views into the serialized cache buffer.
  // Transfer only owned copies: detaching either view must never detach the cache.
  packet.values = packet.values.slice();
  packet.dateIndexes = packet.dateIndexes.slice();
  return packet;
}
export function cacheScreen(
  key: string,
  manifest: string,
  result: ScreeningResult,
) {
  if (result.errors.length) return;
  cachePackedScreen(key, manifest, packScreen(result));
}
export function cachePackedScreen(
  key: string,
  manifest: string,
  result: PackedScreen,
) {
  if (result.errors.length) return;
  const payload = serialize(result);
  if (payload.byteLength > MAX_CACHE_BYTES) return;
  forget(key);
  entries.set(key, { manifest, at: Date.now(), payload });
  bytes += payload.byteLength;
  while (entries.size > 4 || bytes > MAX_CACHE_BYTES)
    forget(entries.keys().next().value!);
}
