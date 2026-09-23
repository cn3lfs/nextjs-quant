import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  sectorIdentity,
  fetchSectorPrices,
} from "~/server/data-sources/tencent/tencent-sector-prices";
it("requires exact industry name, first-level classification and unique identity", () => {
  const row = { code: "pt01801080", name: "电子", 分类: "申万一级行业清单" };
  expect(
    sectorIdentity(
      [{ ...row, code: "pt02GN1234", name: "电子概念", 分类: "概念" }, row],
      "电子",
    ),
  ).toMatchObject({ symbol: row.code });
  expect(() =>
    sectorIdentity([{ ...row, 分类: "申万二级行业清单" }], "电子"),
  ).toThrow("唯一");
  expect(() => sectorIdentity([row, row], "电子")).toThrow("唯一");
  expect(() => sectorIdentity([row], "有色金属")).toThrow("唯一");
});
it("rejects invalid requests and pre-cancelled work before launching a child", async () => {
  await expect(fetchSectorPrices(["电子", "电子"], Date.now())).rejects.toThrow(
    "列表",
  );
  await expect(fetchSectorPrices(["电子"], Date.now() + 60000)).rejects.toThrow(
    "截止",
  );
  const controller = new AbortController();
  controller.abort();
  await expect(
    fetchSectorPrices(["电子"], Date.now(), controller.signal),
  ).rejects.toThrow();
});
it("terminates an active CLI lookup when cancelled", async () => {
  const root = await mkdtemp(join(tmpdir(), "quant-sector-cancel-"));
  const scripts = join(root, "westock-data", "scripts");
  await mkdir(scripts, { recursive: true });
  await writeFile(
    join(scripts, "index.js"),
    'require("fs").writeFileSync(__dirname+"/started",String(process.pid));setInterval(()=>{},1000);',
  );
  vi.stubEnv("QUANT_SKILLS_DIR", root);
  const controller = new AbortController();
  try {
    const pending = fetchSectorPrices(["电子"], Date.now(), controller.signal);
    const rejected = expect(pending).rejects.toThrow();
    let pid = 0;
    await vi.waitFor(async () => {
      pid = Number(await readFile(join(scripts, "started"), "utf8"));
      expect(pid).toBeGreaterThan(0);
    });
    controller.abort();
    await rejected;
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    controller.abort();
    vi.unstubAllEnvs();
  }
});
