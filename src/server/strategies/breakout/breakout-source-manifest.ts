import { resolveTdxRoot } from "tstdx/local";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { isAStock } from "tstdx/local";

export async function breakoutSourceManifest(
  root: string,
  symbols: string[],
): Promise<string | null> {
  const universe = [...new Set(symbols)].sort();
  if (universe.some((symbol) => !isAStock(symbol))) return null;
  const signatures: string[] = [];
  let cursor = 0,
    failed = false;
  await Promise.all(
    Array.from({ length: Math.min(32, universe.length) }, async () => {
      while (cursor < universe.length) {
        const index = cursor++,
          symbol = universe[index]!;
        try {
          const info = await stat(
            join(
              resolveTdxRoot(root),
              "vipdoc",
              symbol.slice(0, 2),
              "lday",
              `${symbol}.day`,
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
