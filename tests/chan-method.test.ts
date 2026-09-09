import { expect, it } from "vitest";
import { chanPassages } from "~/server/chan-method";

it("binds quotes to the nearest attributed section and keeps verbatim formatting", () => {
  const text =
    "# 资料\n> 未归属引文\n## 笔（第62课、第65课）\n### 定义\n> 相邻的**顶和底**。\n> 不能跳过。\n### 修订（第71课）\n> 后续修订。\n## 无归属章节\n> 不得继承前章。";
  const entries = chanPassages("fixture.md", text);
  expect(entries).toHaveLength(2);
  expect(entries[0]).toMatchObject({
    lessons: [62, 65],
    quote: "相邻的**顶和底**。\n不能跳过。",
    line: 5,
  });
  expect(entries[1]!.lessons).toEqual([71]);
  expect(chanPassages("fixture.md", text)).toEqual(entries);
  expect(chanPassages("other.md", text)[0]!.id).not.toBe(entries[0]!.id);
  expect(
    chanPassages("fixture.md", text.replace("不能跳过", "必须核对"))[0]!.id,
  ).not.toBe(entries[0]!.id);
});
it("handles lesson ranges and excludes prose that is not a quotation", () => {
  const entries = chanPassages(
    "fixture.md",
    "## 线段（第62-65、67课）\n整理说明不可冒充引文。\n> 原引文。",
  );
  expect(entries).toHaveLength(1);
  expect(entries[0]!.lessons).toEqual([62, 63, 64, 65, 67]);
  expect(entries[0]!.quote).toBe("原引文。");
});
