import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { Flask } from "@phosphor-icons/react";
import {
  BarsPanel,
  changeTone,
  FormField,
  FormPanel,
  ListPanel,
  PageGrid,
  ReportPanel,
  signedPercent,
  StatsPanel,
  TablePanel,
} from "../src/components/panels";

it("panel shell renders span, title row, tag, meta and note", () => {
  const html = renderToStaticMarkup(
    h(
      PageGrid,
      null,
      h(StatsPanel, {
        span: 8,
        icon: Flask,
        title: "本次运行",
        tag: "双均线",
        meta: "基准日 09-15",
        note: "仅作描述",
        items: [
          { label: "候选", value: "37" },
          { label: "读取异常", value: "3", tone: "bad" },
        ],
      }),
    ),
  );
  expect(html).toContain('class="nc-grid"');
  expect(html).toContain("nc-span-8");
  expect(html).toContain('aria-label="本次运行"');
  expect(html).toContain("双均线");
  expect(html).toContain("基准日 09-15");
  expect(html).toContain("仅作描述");
  // Abnormal cards switch to the semantic edge and value color.
  expect(html).toContain("nc-edge-bad");
  expect(html).toContain("nc-text-bad");
});

it("table, list, form, bars and report panels render their rows", () => {
  const table = renderToStaticMarkup(
    h(TablePanel<{ id: string; v: number }>, {
      title: "候选",
      columns: [
        { key: "id", header: "证券", width: "1.4fr", cell: (r) => r.id },
        { key: "v", header: "涨跌幅", cell: (r) => signedPercent(r.v) },
      ],
      rows: [{ id: "sh600519", v: 1.5 }],
      rowKey: (r) => r.id,
      minWidth: 480,
    }),
  );
  expect(table).toContain('role="columnheader"');
  expect(table).toContain("minmax(0,1.4fr) minmax(0,1fr)");
  expect(table).toContain("+1.50%");
  expect(table).toContain("min-width:480px");
  expect(
    renderToStaticMarkup(
      h(TablePanel<never>, {
        title: "空",
        columns: [],
        rows: [],
        rowKey: () => "",
        empty: "没有候选",
      }),
    ),
  ).toContain("没有候选");

  const list = renderToStaticMarkup(
    h(ListPanel, {
      title: "订阅",
      items: [
        {
          key: "a",
          title: "A500",
          subtitle: "日线",
          tag: "运行中",
          tone: "ok",
        },
      ],
    }),
  );
  expect(list).toContain("nc-edge-ok");
  expect(list).toContain("运行中");

  const form = renderToStaticMarkup(
    h(FormPanel, {
      title: "参数",
      fields: h(FormField, { label: "阈值", children: h("span", null, "87") }),
      buttons: h("span", null, "运行"),
    }),
  );
  expect(form).toContain("nc-form-grid");
  expect(form).toContain("nc-buttons");

  const bars = renderToStaticMarkup(
    h(BarsPanel, {
      title: "RPS",
      items: [{ key: "5", name: "RPS 5", value: "98", pct: 140 }],
    }),
  );
  expect(bars).toContain("width:100%");

  const report = renderToStaticMarkup(
    h(ReportPanel, {
      title: "SEPA",
      headline: "趋势成立",
      stages: [
        { key: "a", title: "趋势", status: "support" },
        { key: "b", title: "VCP", status: "counter" },
        { key: "c", title: "基本面", status: "insufficient" },
      ],
    }),
  );
  for (const text of ["证据支持", "存在反证", "证据不足"])
    expect(report).toContain(text);
});

it("price tones follow the A-share convention", () => {
  expect(changeTone(1)).toBe("bad");
  expect(changeTone(-1)).toBe("ok");
  expect(changeTone(0)).toBe("idle");
  expect(signedPercent(undefined)).toBe("—");
});

it("panel styles take every color from tokens", () => {
  for (const file of ["src/styles/panels.css", "src/styles/globals.css"])
    expect(readFileSync(file, "utf8")).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
});
