import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
it("通达信格式由tstdx拥有，应用不保留只做转发的兼容文件", () => {
  for (const name of [
    "tdx-wire.ts",
    "tdx-gbbq.ts",
    "tdx-gbbq-key.ts",
    "tdx-local-blocks.ts",
    "tdx-local-names.ts",
    "tdx-code-changes.ts",
    "tdx-daily-increment.ts",
    "tdx-increment-download.ts",
    "tdx-full-day-import.ts",
    "five-minute-csv.ts",
    "five-minute-native.ts",
    "five-minute-probe.ts",
    "five-minute-volume.ts",
    "wdz-native.ts",
    "tail-cache-codec.ts",
    "five-minute-preview.ts",
    "five-minute-write.ts",
  ]) {
    expect(existsSync(join("src/server/data-sources/tdx", name)), name).toBe(
      false,
    );
  }
  const adapter = readFileSync("src/server/data-sources/tdx/tdx.ts", "utf8");
  expect(adapter).not.toMatch(/\.read(?:U?Int|Float|Double)\w*\(/i);
  expect(adapter).toContain("exchangeNames");
});
it("tstdx不引用宿主路径，财务模型可供浏览器和纯计算层消费", () => {
  for (const file of readdirSync("packages/tstdx/src", { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".ts"))) {
    const source = readFileSync(join("packages/tstdx/src", file), "utf8");
    expect(source, file).not.toMatch(
      /(?:from|import)\s*["'](?:~\/|.*nextjs-quant|\.\.\/\.\.\/\.\.\/src\/)/,
    );
    if (file.replaceAll("\\", "/").startsWith("financial-data/"))
      expect(source, file).not.toMatch(/from\s+["']node:/);
  }
});
