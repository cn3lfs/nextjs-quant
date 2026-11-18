import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  renderTheoryCoverage,
  validateTheoryCoverage,
  type TheoryCoverage,
} from "../../scripts/theory-coverage";

const load = async () =>
  JSON.parse(
    await readFile("docs/research/theory-implementation/coverage.json", "utf8"),
  ) as TheoryCoverage;
describe("逐卡理论工程覆盖", () => {
  it("binds every theory exactly once and every executable proxy to actual code", async () => {
    await validateTheoryCoverage(await load());
  });
  it("rejects duplicate cards and an unimplemented strategy instead of inflating coverage", async () => {
    const duplicate = await load();
    duplicate.cards[1] = duplicate.cards[0]!;
    await expect(validateTheoryCoverage(duplicate)).rejects.toThrow(
      "重复或未知",
    );
    const unknown = await load();
    unknown.cards[0]!.strategyIds = ["non-existent-profitable-strategy"];
    await expect(validateTheoryCoverage(unknown)).rejects.toThrow("未实现");
  });
  it("rejects an existing but unrelated source and a newly implemented proxy omitted from the mapping", async () => {
    const swapped = await load();
    swapped.cards[0]!.source = swapped.cards[1]!.source;
    await expect(validateTheoryCoverage(swapped)).rejects.toThrow(
      "来源或名称错配",
    );
    const omitted = await load();
    const card = omitted.cards.find((c) => c.theoryId === "F05.04")!;
    card.strategyIds = [];
    card.status = "engineering";
    await expect(validateTheoryCoverage(omitted)).rejects.toThrow(
      "新增规则缺理论映射",
    );
  });
  it("keeps the human table reproducible and does not call engineering gaps implemented", async () => {
    const data = await load();
    expect(
      await readFile("docs/research/theory-implementation/README.md", "utf8"),
    ).toBe(renderTheoryCoverage(data));
    expect(
      data.cards
        .filter((c) => c.status === "engineering")
        .every((c) => c.strategyIds.length === 0),
    ).toBe(true);
  });
});
