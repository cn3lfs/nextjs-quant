"use client";
import { formatNumber as displayNumber } from "trading-strategy-core/format-number";

import { useState } from "react";
import { Fire, Sparkle } from "@phosphor-icons/react/ssr";
import { api, type RouterOutputs } from "~/trpc/react";
import type {
  ThsdkWencaiField,
  ThsdkWencaiRow,
} from "~/lib/market/thsdk-extensions";
import { compactNumber } from "~/lib/market/tdx-fundamentals";
import { securityDisplayName } from "~/lib/market/security-display";
import {
  MethodologyPopover,
  PageGrid,
  Panel,
  PanelEmpty,
  Segmented,
  changeTone,
  signedPercent,
  toneText,
} from "../panels";
import { GridTable, type Column } from "../panels/table-panel";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useScreenVisible } from "../workbench/use-task-visible";
import { ChartSymbolLink } from "./chart-symbol-link";
import { BrowseSource } from "./open-chart";
import { useSecurityNames } from "./use-security-names";

type MarketChoice = "all" | "USHA" | "USZA" | "USTA";
type LimitChoice = "20" | "50" | "100";
type HotBlockKind = "concept" | "industry";

const marketOptions = [
  { value: "all", label: "全A" },
  { value: "USHA", label: "沪A" },
  { value: "USZA", label: "深A" },
  { value: "USTA", label: "北交所" },
] as const satisfies readonly { value: MarketChoice; label: string }[];

const limitOptions = [
  { value: "20", label: "20 条" },
  { value: "50", label: "50 条" },
  { value: "100", label: "100 条" },
] as const satisfies readonly { value: LimitChoice; label: string }[];

const hotKindOptions = [
  { value: "concept", label: "热门概念" },
  { value: "industry", label: "热门行业" },
] as const satisfies readonly { value: HotBlockKind; label: string }[];

const presets = [
  "连续3日上涨",
  "今日涨停且主力资金净流入",
  "换手率大于5%且站上20日线",
] as const;

const wencaiMethodology = [
  {
    label: "数据口径",
    detail:
      "问财字段、单位与排序按源展示。证券名称、最新价和涨跌幅由本地证券字典与实时报价补齐，缺失项留空。",
  },
  {
    label: "触发时机",
    detail:
      "只有提交非空条件后才会请求；首次进入页面不会自动查询，也不做定时刷新。",
  },
  {
    label: "使用边界",
    detail:
      "问财候选只作研究线索，不写入东方财富四池、扫描候选或交易计划；是否可交易需另行核对行情与规则。",
  },
] as const;

const cellText = (value: string | number | boolean | null | undefined) => {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number")
    return Number.isInteger(value) ? String(value) : displayNumber(value, 2);
  return value;
};

type Quote = RouterOutputs["overviewQuotes"]["quotes"][number];

function resultSymbols(rows: readonly { symbol: string | null }[]) {
  return [...new Set(rows.flatMap(({ symbol }) => (symbol ? [symbol] : [])))];
}

function wencaiColumns(
  fields: readonly ThsdkWencaiField[],
  names: Record<string, string>,
  quotes: ReadonlyMap<string, Quote>,
) {
  const quoteFor = (row: ThsdkWencaiRow) =>
    row.symbol ? quotes.get(row.symbol) : undefined;
  const columns: Column<ThsdkWencaiRow>[] = [
    {
      key: "security",
      header: "证券",
      width: "1.4fr",
      cell: (row) => {
        if (!row.symbol)
          return (
            <span className="truncate">
              {row.name ?? row.code} · {row.code}
            </span>
          );
        const quote = quoteFor(row);
        const quoteName =
          quote && "name" in quote && typeof quote.name === "string"
            ? quote.name
            : undefined;
        const name =
          row.name ||
          quoteName ||
          (names[row.symbol]
            ? securityDisplayName(row.symbol, names)
            : undefined);
        return <ChartSymbolLink symbol={row.symbol} name={name} />;
      },
    },
    {
      key: "latestPrice",
      header: "最新价",
      align: "right",
      width: "92px",
      cell: (row) => {
        const price = quoteFor(row)?.price;
        return price !== undefined && Number.isFinite(price) && price > 0
          ? displayNumber(price, 2)
          : "—";
      },
    },
    {
      key: "dailyChangePct",
      header: "涨跌幅",
      align: "right",
      width: "92px",
      cell: (row) => {
        const quote = quoteFor(row);
        const changePct =
          quote && "changePct" in quote && typeof quote.changePct === "number"
            ? quote.changePct
            : quote && quote.preClose > 0 && quote.price > 0
              ? (quote.price / quote.preClose - 1) * 100
              : undefined;
        return changePct !== undefined && Number.isFinite(changePct) ? (
          <span className={`tabular-nums ${toneText[changeTone(changePct)]}`}>
            {signedPercent(changePct)}
          </span>
        ) : (
          "—"
        );
      },
    },
    ...fields.map((field) => ({
      key: field.key,
      header: field.unit ? `${field.label}(${field.unit})` : field.label,
      align: "right" as const,
      cell: (row: ThsdkWencaiRow) => (
        <span className="tabular-nums">{cellText(row.values[field.key])}</span>
      ),
    })),
  ];
  return columns;
}

/** 问财自然语言选股：主面板查询与动态结果表，右侧热门板块与成分联动。 */
export function ThsdkWencaiPanel() {
  const visible = useScreenVisible();
  const [draft, setDraft] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [market, setMarket] = useState<MarketChoice>("all");
  const [limit, setLimit] = useState<LimitChoice>("20");
  const [kind, setKind] = useState<HotBlockKind>("concept");
  const [selected, setSelected] = useState<{
    blockId: number;
    name: string;
  } | null>(null);

  const result = api.thsdkWencaiQuery.useQuery(
    {
      query: submitted,
      markets: market === "all" ? undefined : [market],
      limit: Number(limit),
    },
    {
      enabled: visible && submitted !== "",
      retry: false,
      refetchOnWindowFocus: false,
    },
  );
  const hot = api.thsdkWencaiHotBlocks.useQuery(
    { kind },
    {
      enabled: visible,
      retry: false,
      refetchOnWindowFocus: false,
    },
  );
  const constituents = api.thsdkBlockConstituents.useQuery(
    {
      blockId: selected?.blockId ?? 0,
      blockName: selected?.name,
      limit: 50,
    },
    {
      enabled: visible && selected !== null,
      retry: false,
      refetchOnWindowFocus: false,
    },
  );

  function submit(query: string) {
    const next = query.trim();
    if (next === "") return;
    setDraft(next);
    // 同一条件再次提交时 submitted 不变，不会触发新请求；显式重发以支持失败重试。
    if (next === submitted) {
      if (visible) void result.refetch();
      return;
    }
    setSubmitted(next);
  }

  const rows = result.data?.rows ?? [];
  const wencaiSymbols = resultSymbols(rows);
  const constituentSymbols = resultSymbols(constituents.data?.items ?? []);
  const { data: names = {} } = useSecurityNames();
  const quotes = api.overviewQuotes.useQuery(wencaiSymbols, {
    enabled: visible && wencaiSymbols.length > 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const quotesBySymbol = new Map(
    (quotes.isError ? [] : (quotes.data?.quotes ?? [])).map((quote) => [
      quote.symbol,
      quote,
    ]),
  );
  const columns = wencaiColumns(
    result.data?.fields ?? [],
    names,
    quotesBySymbol,
  );
  const meta =
    submitted === ""
      ? undefined
      : `${result.data ? `${rows.length} 只` : "读取中"} · ${submitted}`;
  const emptyText =
    submitted === ""
      ? "输入自然语言条件并查询后显示结果；首次进入不会自动请求问财。"
      : result.isError
        ? `问财查询失败：${result.error.message}`
        : result.isFetching
          ? "正在查询问财…"
          : "问财没有返回匹配的证券，可换用更宽松的条件。";

  return (
    <PageGrid>
      <Panel
        span={8}
        icon={Sparkle}
        title="问财选股"
        meta={meta}
        actions={<MethodologyPopover items={wencaiMethodology} />}
        note="数据：同花顺问财（thsdk-hq）。条件与字段以源解析为准；候选只作研究线索，不写入四池、扫描候选或交易计划。"
      >
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            submit(draft);
          }}
        >
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="如：今日涨停且主力资金净流入"
            aria-label="问财选股条件"
            className="h-8 min-w-[220px] flex-1"
          />
          <Button size="sm" type="submit" disabled={draft.trim() === ""}>
            查询问财
          </Button>
        </form>
        <div className="mt-2 flex flex-wrap gap-1">
          {presets.map((preset) => (
            <Button
              key={preset}
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px]!"
              onClick={() => submit(preset)}
            >
              {preset}
            </Button>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Segmented
            label="问财市场范围"
            value={market}
            onChange={setMarket}
            options={marketOptions}
          />
          <Segmented
            label="问财返回条数"
            value={limit}
            onChange={setLimit}
            options={limitOptions}
          />
        </div>
        <div className="mt-3">
          {submitted === "" ? (
            <PanelEmpty>{emptyText}</PanelEmpty>
          ) : result.isError && rows.length === 0 ? (
            <p role="alert" className="m-0 text-[12px] text-nc-bad">
              {emptyText}
            </p>
          ) : !result.data ? (
            <PanelEmpty>正在查询问财…</PanelEmpty>
          ) : (
            <>
              {result.isError && (
                <p role="alert" className="m-0 mb-2 text-[12px] text-nc-bad">
                  刷新失败：{result.error.message}
                  ；下方保留上次读取的结果。
                </p>
              )}
              <BrowseSource
                label={submitted ? `问财 · ${submitted}` : "问财选股"}
                symbols={wencaiSymbols}
              >
                <GridTable
                  columns={columns}
                  rows={rows}
                  rowKey={(row) => `${row.market}:${row.code}`}
                  minWidth={720}
                  label="问财选股结果"
                  empty={emptyText}
                />
              </BrowseSource>
            </>
          )}
        </div>
      </Panel>
      <Panel
        span={4}
        icon={Fire}
        title="问财热门板块"
        actions={
          <Segmented
            label="问财热门板块类型"
            value={kind}
            onChange={(value) => {
              setKind(value);
              setSelected(null);
            }}
            options={hotKindOptions}
          />
        }
        note="热度为源 popularity 分值，不是涨跌幅；点击板块展开成分股，成分按源返回顺序，不补造缺失行情。"
      >
        {hot.error ? (
          <p role="alert" className="m-0 text-[12px] text-nc-bad">
            热门板块读取失败：{hot.error.message}
          </p>
        ) : !hot.data ? (
          <PanelEmpty>正在读取问财热门板块…</PanelEmpty>
        ) : hot.data.items.length === 0 ? (
          <PanelEmpty>源当前没有返回该类型的热门板块。</PanelEmpty>
        ) : (
          <div
            role="group"
            aria-label="问财热门板块列表"
            className="max-h-56 space-y-0.5 overflow-auto pr-1"
          >
            {hot.data.items.map((block) => {
              const active = selected?.blockId === block.blockId;
              return (
                <Button
                  key={`${block.blockId}:${block.name}`}
                  variant={active ? "default" : "plain"}
                  aria-pressed={active}
                  className="flex w-full min-w-0 items-center justify-between gap-2 rounded px-1.5 py-1 text-left text-[11.5px]"
                  onClick={() =>
                    setSelected((previous) =>
                      previous?.blockId === block.blockId
                        ? null
                        : { blockId: block.blockId, name: block.name },
                    )
                  }
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="min-w-0 truncate">{block.name}</span>
                    {block.hotTag && (
                      <span className="flex-none rounded border border-nc-border-soft px-1 text-[10px] text-nc-warn">
                        {block.hotTag}
                      </span>
                    )}
                  </span>
                  <span className="flex-none text-nc-text-3 tabular-nums">
                    热度 {compactNumber(block.rate) ?? "—"}
                  </span>
                </Button>
              );
            })}
          </div>
        )}
        <div className="mt-2 border-t border-nc-border-soft pt-2">
          {!selected ? (
            <p className="m-0 text-[11.5px] text-nc-text-3">
              选择上方板块查看成分股。
            </p>
          ) : constituents.error ? (
            <p role="alert" className="m-0 text-[12px] text-nc-bad">
              板块成分读取失败：{constituents.error.message}
            </p>
          ) : !constituents.data ? (
            <p role="status" className="m-0 text-[11.5px] text-nc-text-3">
              正在读取 {selected.name} 成分…
            </p>
          ) : constituents.data.items.length === 0 ? (
            <p className="m-0 text-[11.5px] text-nc-text-3">
              源未返回 {selected.name} 的成分股。
            </p>
          ) : (
            <div className="space-y-1">
              <p className="m-0 text-[11px] text-nc-text-4">
                {constituents.data.blockName ?? selected.name} ·{" "}
                {constituents.data.items.length} 只
              </p>
              <BrowseSource
                label={`${kind === "industry" ? "行业" : "概念"} · ${constituents.data.blockName ?? selected.name}`}
                symbols={constituentSymbols}
              >
                <div className="max-h-48 space-y-0.5 overflow-auto pr-1">
                  {constituents.data.items.map((item, index) => (
                    <div
                      key={`${item.market}:${item.code}:${index}`}
                      className="flex items-center justify-between gap-2 text-[11.5px]"
                    >
                      <span className="min-w-0 truncate">
                        {item.symbol ? (
                          <ChartSymbolLink
                            symbol={item.symbol}
                            name={item.name || names[item.symbol]}
                          />
                        ) : (
                          `${item.name ?? item.code} · ${item.code}`
                        )}
                      </span>
                      <span
                        className={`flex-none tabular-nums ${toneText[changeTone(item.changePct)]}`}
                      >
                        {signedPercent(item.changePct)}
                      </span>
                    </div>
                  ))}
                </div>
              </BrowseSource>
            </div>
          )}
        </div>
      </Panel>
    </PageGrid>
  );
}
