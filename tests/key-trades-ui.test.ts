import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { KeyTradesResults } from "../src/components/portfolio/key-trades-results";
import { keyTrades } from "../src/lib/key-trades";
it("U9 空状态、笔数配置和排除原因明确可见", () => {
  const html = renderToStaticMarkup(
    createElement(KeyTradesResults, {
      data: {
        ...keyTrades([]),
        openCount: 2,
        missingCount: 1,
        missingReasons: [{ reason: "净收益金额：费用缺失", count: 1 }],
      },
      onNChange: () => {},
      loading: false,
    }),
  );
  expect(html).toContain("关键交易");
  expect(html).toContain('id="key-trades-n"');
  expect(html).toContain('value="3"');
  expect(html).toContain("未平仓排除 2 笔");
  expect(html).toContain("净收益金额：费用缺失");
  expect(html).toContain("暂无可入榜的已平仓回合");
});
