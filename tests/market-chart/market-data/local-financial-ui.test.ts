import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { localFinancialView } from "../../../src/server/financial/local-financial-service";
import {
  FinancialOverview,
  FinancialFieldTable,
  FinancialMetricView,
  FinancialSourceView,
} from "../../../src/components/financial/financial-view";
it("真实财报的概览、字段、诊断和错误状态均可阅读，未知值不冒充计算值", async () => {
  const root = await mkdtemp(join(tmpdir(), "financial-ui-"));
  try {
    await mkdir(join(root, "vipdoc/cw"), { recursive: true });
    await writeFile(
      join(root, "vipdoc/cw/gpcw20260930.dat"),
      await readFile(
        new URL(
          "../../../packages/tstdx/tests/fixtures/local/gpcw20260930.dat",
          import.meta.url,
        ),
      ),
    );
    const data = await localFinancialView(root, {
      symbol: "sh600519",
      pageSize: 5,
      sort: "slot",
      descending: true,
    });
    const overview = renderToStaticMarkup(
      createElement(FinancialOverview, { data }),
    );
    expect(overview).toContain("2026-09-30");
    expect(overview).toContain("2026-10-31");
    expect(overview).toContain("未认证首次披露版本");
    expect(overview).toContain("11.90%");
    expect(overview).not.toContain("0.119 比例");
    const table = renderToStaticMarkup(
      createElement(FinancialFieldTable, {
        data,
        loading: false,
        retry: () => {},
        pagination: { pageIndex: 0, pageSize: 5 },
        sorting: [],
        onPaginationChange: () => {},
        onSortingChange: () => {},
      }),
    );
    expect(table).toContain("RAW658");
    expect(table).toContain("未核验槽位");
    expect(table).toContain("缺少权威物理映射");
    const metrics = renderToStaticMarkup(
      createElement(FinancialMetricView, { data }),
    );
    expect(metrics).toContain("上年年报+本期累计-上年同期累计");
    expect(metrics).toContain("11.90%");
    const source = renderToStaticMarkup(
      createElement(FinancialSourceView, {
        data,
        onAudit: () => {},
        auditing: false,
      }),
    );
    expect(source).toContain(data.selected!.sourceSha256);
    expect(source).toContain("FN5651");
    expect(source).toContain("GO1");
    const error = renderToStaticMarkup(
      createElement(FinancialFieldTable, {
        data: undefined,
        loading: false,
        error: "财务文件截断",
        retry: () => {},
        pagination: { pageIndex: 0, pageSize: 5 },
        sorting: [],
        onPaginationChange: () => {},
        onSortingChange: () => {},
      }),
    );
    expect(error).toContain("财务文件截断");
    expect(error).toContain("重试");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
