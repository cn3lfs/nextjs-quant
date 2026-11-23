import { it, expect } from "vitest";
import koffi from "koffi";
import { join, resolve } from "node:path";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { readWdzLc5 } from "tstdx/native";
import { encodeFiveMinuteBar } from "tstdx/local";
import { runAuditTdxFiveMinute } from "../../scripts/audit-tdx-five-minute";
import { runRepairTdxZeroVolume } from "../../scripts/repair-tdx-zero-volume";
import { spawnCommand } from "../../scripts/lib/local-check.mjs";

const audit = koffi
  .load(resolve("runtime/tdx-import/audit.dll"))
  .func("void lc5_audit(const void *, uint32, void *, void *, uint32, int)");
const valid = () =>
  encodeFiveMinuteBar({
    time: "2026-11-04 09:35:00",
    open: 10,
    high: 11,
    low: 9,
    close: 10,
    amount: 10000,
    volume: 1000,
  });
function check(data: Buffer) {
  const before = Buffer.from(data),
    stats = Buffer.alloc(28),
    examples = Buffer.alloc(32 * 8);
  audit(data, data.length / 32, stats, examples, 32, 2026);
  expect(data).toEqual(before);
  return Array.from({ length: 7 }, (_, i) => stats.readUInt32LE(i * 4));
}
it("audits dates, ordering, OHLC and finite amounts without changing records", () => {
  expect(check(valid()).slice(0, 6)).toEqual([1, 0, 0, 0, 0, 0]);
  expect(check(Buffer.concat([valid(), valid()])).slice(0, 6)).toEqual([
    2, 0, 1, 0, 0, 0,
  ]);
  const bad = valid();
  bad.writeUInt16LE(0, 0);
  bad.writeFloatLE(12, 16);
  bad.writeFloatLE(NaN, 20);
  expect(check(bad).slice(0, 6)).toEqual([1, 1, 0, 1, 1, 0]);
});
it("flags positive-amount zero-volume as a separate suspicion, not a price error", () => {
  const data = valid();
  data.writeUInt32LE(0, 24);
  data.writeUInt32LE(1234, 28);
  expect(check(data).slice(0, 6)).toEqual([1, 0, 0, 0, 0, 1]);
  data.fill(0, 4, 24);
  expect(check(data).slice(0, 6)).toEqual([1, 0, 0, 1, 0, 0]);
});
it("removes only source-confirmed zero-price placeholders and keeps other bytes", () => {
  const clean = koffi
    .load(resolve("runtime/tdx-import/audit.dll"))
    .func(
      "int lc5_remove_zero_prices(const void *, uint32, void *, const void *, uint32)",
    );
  const empty = valid();
  empty.fill(0, 4);
  const zeroWithAmount = valid();
  zeroWithAmount.fill(0, 4, 20);
  zeroWithAmount.writeUInt16LE(zeroWithAmount.readUInt16LE(2) + 5, 2);
  const unknown = Buffer.from(empty);
  unknown.writeUInt16LE(600, 2);
  const incoming = Buffer.concat([valid(), empty, zeroWithAmount, unknown]);
  const allowed = [empty.readUInt32LE(), zeroWithAmount.readUInt32LE()].sort(
    (a, b) => a - b,
  );
  const keys = Buffer.alloc(8);
  allowed.forEach((k, i) => keys.writeUInt32LE(k, i * 4));
  const out = Buffer.alloc(incoming.length);
  const count = clean(incoming, 4, out, keys, 2) as number;
  expect(count).toBe(2);
  expect(out.subarray(0, count * 32)).toEqual(
    Buffer.concat([valid(), unknown]),
  );
});
it("history repair CLIs recover matched zero volumes, remove only confirmed empty prices and repeat safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "quant-history-cli-"));
  try {
    for (const market of ["sh", "sz"])
      await mkdir(join(root, "vipdoc", market, "fzline"), { recursive: true });
    const fixture = "tests/fixtures/wdz/sh000001-20261104.wdz";
    let expected = Buffer.alloc(0);
    for await (const item of readWdzLc5(fixture)) expected = item.data;
    const original = Buffer.from(expected);
    original.writeUInt32LE(0, 24);
    const target = join(root, "vipdoc/sh/fzline/sh000001.lc5");
    await writeFile(target, original);
    const report = join(root, "audit.json"),
      output = join(root, "result.json");
    await writeFile(
      report,
      JSON.stringify({
        root,
        details: [{ path: target, counts: [48, 0, 0, 0, 0, 1] }],
      }),
    );
    const args = [
      "--source",
      fixture,
      "--tdx-root",
      root,
      "--audit-report",
      report,
      "--out",
      output,
    ];
    expect(await runRepairTdxZeroVolume(args)).toBe(0);
    expect(JSON.parse(await readFile(output, "utf8")).repaired).toBe(1);
    expect(await readFile(target)).toEqual(expected);
    expect(await runRepairTdxZeroVolume(args)).toBe(0);
    expect(JSON.parse(await readFile(output, "utf8")).repaired).toBe(0);
    const empty = valid();
    empty.fill(0, 4);
    empty.writeUInt16LE(empty.readUInt16LE(2) + 5, 2);
    const other = join(root, "vipdoc/sh/fzline/sh999999.lc5");
    await writeFile(other, Buffer.concat([valid(), empty]));
    const issues = join(root, "issues.ndjson");
    await writeFile(
      issues,
      JSON.stringify({
        symbol: "SH999999",
        skipped: "invalid source",
        records: 1,
        times: ["2026-11-04 09:40:00"],
      }) + "\n",
    );
    const cleanArgs = [
      "--tdx-root",
      root,
      "--out",
      output,
      "--remove-zero-prices",
      "--source-issues",
      issues,
    ];
    expect(await runAuditTdxFiveMinute(cleanArgs)).toBe(0);
    const result = JSON.parse(await readFile(output, "utf8"));
    expect(result.removedZeroPrices).toBe(1);
    expect(result.badPrices).toBe(0);
    expect(await readFile(other)).toEqual(valid());
    expect(await runAuditTdxFiveMinute(cleanArgs)).toBe(0);
    expect(JSON.parse(await readFile(output, "utf8")).removedZeroPrices).toBe(
      0,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["repair-tdx-zero-volume", "audit-tdx-five-minute"])(
  "runs the %s CLI entrypoint and updates a one-bar file",
  async (name) => {
    const root = await mkdtemp(join(tmpdir(), "quant-history-smoke-"));
    try {
      for (const market of ["sh", "sz"])
        await mkdir(join(root, "vipdoc", market, "fzline"), {
          recursive: true,
        });
      const target = join(root, "vipdoc/sh/fzline/sh000001.lc5");
      const original = valid();
      const expected = valid();
      const out = join(root, "result.json");
      const args = ["--tdx-root", root, "--out", out];
      const repair = name === "repair-tdx-zero-volume";
      let entrypoint = `scripts/${name}.ts`;
      if (repair) {
        const source = join(root, "one-bar.wdz");
        // Synthetic WDZ archive containing the single SH000001 bar from valid().
        await writeFile(
          source,
          Buffer.from(
            "IAAAAEQAAABLrPnL3shOYABDJKM1h2ypXVxGkirKNTl3R0RQLQAAAD0AAAA8rT/BATk2AjAfcVK+r2TIivkmJFJDIVkRMVJGEGSh96JlpjJG/d8/ZRoAAAAgAAAAS6o6xgdCRXcwZSExVFFCYTM2ANE4o1UAAAA=",
            "base64",
          ),
        );
        const report = join(root, "audit.json");
        await writeFile(
          report,
          JSON.stringify({
            root,
            details: [{ path: target, counts: [1, 0, 0, 0, 0, 1] }],
          }),
        );
        original.writeUInt32LE(0, 24);
        args.push("--source", source, "--audit-report", report);
      } else {
        const issues = join(root, "issues.ndjson");
        await writeFile(
          issues,
          JSON.stringify({
            symbol: "SH000001",
            skipped: "invalid source",
            records: 1,
            times: ["2026-11-04 09:35:00"],
          }) + "\n",
        );
        original.fill(0, 4);
        args.push("--remove-zero-prices", "--source-issues", issues);
        const scriptsLink = join(root, "linked-scripts");
        await symlink(resolve("scripts"), scriptsLink, "junction");
        entrypoint = join(scriptsLink, `${name}.ts`);
      }
      await writeFile(target, original);

      const result = await spawnCommand(
        process.execPath,
        ["--import", "tsx", entrypoint, ...args],
        { env: process.env, captureOutput: true, timeout: 30_000 },
      );

      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const summary = JSON.parse(await readFile(out, "utf8"));
      const updated = await readFile(target);
      if (repair) {
        expect(summary).toMatchObject({ archives: 1, repaired: 1, errors: 0 });
        expect(updated).toEqual(expected);
      } else {
        expect(summary).toMatchObject({
          root,
          removedZeroPrices: 1,
          errors: 0,
        });
        expect(updated).toHaveLength(0);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
