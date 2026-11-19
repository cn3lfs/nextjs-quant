"use client";
import { formatNumber as displayNumber } from "trading-strategy-core/format-number";

import { useState } from "react";
import {
  ChartLineUp,
  Fire,
  Lightning,
  Rows,
  Tag,
} from "@phosphor-icons/react/ssr";
import { api } from "~/trpc/react";
import { chartPricePrecision } from "~/lib/chart/chart-symbol";
import { thsdkOrderBookToDisplayModel } from "~/lib/market/quote-book-view";
import { compactNumber } from "~/lib/market/tdx-fundamentals";
import { quoteRefreshInterval } from "~/lib/market/tdx-quote-view";
import { useScreenVisible } from "../workbench/use-task-visible";
import { QuoteBook } from "./quote-book";
import { useQuoteSession } from "./use-quote-session";

const fixed = (value: number | null | undefined, digits = 2) =>
  value === null || value === undefined ? "—" : displayNumber(value, digits);
const compact = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : (compactNumber(value) ?? "—");
const net = (buy: number | null, sell: number | null) =>
  buy === null || sell === null ? null : buy - sell;

function Row({
  cells,
  head = false,
}: {
  cells: (string | number)[];
  head?: boolean;
}) {
  return (
    <div
      className={`grid grid-cols-[1.1fr_1fr_1fr_1fr] gap-2 tabular-nums ${head ? "text-[10.5px] text-nc-text-4" : "text-[11.5px]"}`}
    >
      {cells.map((cell, index) => (
        <span
          key={index}
          className={index === 0 ? "text-nc-text-3" : "text-right"}
        >
          {cell}
        </span>
      ))}
    </div>
  );
}

function Section({
  label,
  icon,
  open,
  onOpenChange,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <details
      open={open}
      className="rounded-md border border-nc-border-soft"
      onToggle={(event) => onOpenChange(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer items-center gap-1.5 px-2 py-1.5 text-[12px] font-medium">
        {icon}
        {label}
      </summary>
      <div className="space-y-1.5 border-t border-nc-border-soft px-2 py-1.5">
        {children}
      </div>
    </details>
  );
}

function OrderBookPanel({ symbol, auto }: { symbol: string; auto: boolean }) {
  const visible = useScreenVisible();
  const session = useQuoteSession();
  const interval = session === null ? null : quoteRefreshInterval(session);
  const precision = chartPricePrecision(symbol);
  const books = api.thsdkOrderBooks.useQuery([symbol], {
    enabled: visible,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: visible && auto && interval !== null ? interval : false,
  });
  const item = books.data?.items.find((entry) => entry.symbol === symbol);
  return (
    <div className="space-y-1.5">
      {books.error ? (
        <div role="alert" className="text-[12px] text-nc-bad">
          同花顺盘口读取失败：{books.error.message}
        </div>
      ) : books.isFetching && !books.data ? (
        <p role="status" className="text-[12px] text-nc-text-3">
          正在读取同花顺五档盘口…
        </p>
      ) : !item ? (
        <p role="status" className="text-[12px] text-nc-text-3">
          同花顺未返回该证券的盘口。
        </p>
      ) : (
        <QuoteBook
          model={thsdkOrderBookToDisplayModel(item, precision)}
          testId="thsdk-quote-book"
        />
      )}
    </div>
  );
}

export function ThsdkMarketPanels({
  symbol,
  auto = false,
}: {
  symbol: string;
  auto?: boolean;
}) {
  return (
    <div className="space-y-2">
      <OrderBookPanel symbol={symbol} auto={auto} />
      <PriceVolumeSection symbol={symbol} />
      <CallAuctionSection symbol={symbol} />
      <IntradaySection symbol={symbol} />
      <CapitalFlowSection symbol={symbol} />
      <BlocksAndConceptsSection symbol={symbol} />
    </div>
  );
}

function PriceVolumeSection({ symbol }: { symbol: string }) {
  const visible = useScreenVisible();
  const [open, setOpen] = useState(false);
  const precision = chartPricePrecision(symbol);
  const data = api.thsdkPriceVolume.useQuery(symbol, {
    enabled: visible && open,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const levels = data.data?.levels ?? [];
  return (
    <Section
      label="分价表"
      icon={<Rows size={13} aria-hidden />}
      open={open}
      onOpenChange={setOpen}
    >
      {data.error ? (
        <p role="alert" className="text-[12px] text-nc-bad">
          分价表读取失败：{data.error.message}
        </p>
      ) : !data.data ? (
        <p role="status" className="text-[12px] text-nc-text-3">
          正在读取分价表…
        </p>
      ) : levels.length === 0 ? (
        <p className="text-[12px] text-nc-text-3">源返回空分价表。</p>
      ) : (
        <div className="max-h-48 space-y-0.5 overflow-auto pr-1">
          <Row head cells={["价格", "成交量", "买量", "卖量"]} />
          {levels.map((level, index) => (
            <Row
              key={`${level.price}-${index}`}
              cells={[
                fixed(level.price, precision),
                compact(level.volume),
                compact(level.inVolume),
                compact(level.outVolume),
              ]}
            />
          ))}
        </div>
      )}
      {data.data && (
        <p className="text-[10.5px] text-nc-text-4">
          单位：{data.data.volumeUnit || "源单位未标注"} · 时点{" "}
          {data.data.dataAsOf ?? "未提供"}
        </p>
      )}
    </Section>
  );
}

function CallAuctionSection({ symbol }: { symbol: string }) {
  const visible = useScreenVisible();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<"opening" | "closing">("opening");
  const precision = chartPricePrecision(symbol);
  const data = api.thsdkCallAuction.useQuery(
    { symbol, phase },
    {
      enabled: visible && open,
      retry: false,
      refetchOnWindowFocus: false,
    },
  );
  const points = data.data?.points ?? [];
  return (
    <Section
      label="集合竞价"
      icon={<Lightning size={13} aria-hidden />}
      open={open}
      onOpenChange={setOpen}
    >
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className={`rounded px-1.5 py-0.5 text-[11px] ${phase === "opening" ? "bg-nc-accent-900 text-nc-accent-light" : "text-nc-text-3"}`}
          onClick={() => setPhase("opening")}
        >
          开盘
        </button>
        <button
          type="button"
          className={`rounded px-1.5 py-0.5 text-[11px] ${phase === "closing" ? "bg-nc-accent-900 text-nc-accent-light" : "text-nc-text-3"}`}
          onClick={() => setPhase("closing")}
        >
          收盘
        </button>
      </div>
      {data.error ? (
        <p role="alert" className="text-[12px] text-nc-bad">
          集合竞价读取失败：{data.error.message}
        </p>
      ) : !data.data ? (
        <p role="status" className="text-[12px] text-nc-text-3">
          正在读取集合竞价…
        </p>
      ) : points.length === 0 ? (
        <p className="text-[12px] text-nc-text-3">该日没有集合竞价记录。</p>
      ) : (
        <div className="max-h-48 space-y-0.5 overflow-auto pr-1">
          <Row head cells={["时间", "价格", "成交量", "买二量"]} />
          {points.map((point) => (
            <Row
              key={`${point.time}-${point.timestamp}`}
              cells={[
                point.time,
                fixed(point.price, precision),
                compact(point.curVolume),
                compact(point.bid2Vol),
              ]}
            />
          ))}
        </div>
      )}
      {data.data && (
        <p className="text-[10.5px] text-nc-text-4">
          {data.data.date} · 合计 {points.length} 点
        </p>
      )}
    </Section>
  );
}

function IntradaySection({ symbol }: { symbol: string }) {
  const visible = useScreenVisible();
  const [open, setOpen] = useState(false);
  const precision = chartPricePrecision(symbol);
  const data = api.thsdkIntraday.useQuery(
    { symbol },
    {
      enabled: visible && open,
      retry: false,
      refetchOnWindowFocus: false,
    },
  );
  const points = data.data?.points ?? [];
  const tail = points.slice(-12);
  return (
    <Section
      label="分时"
      icon={<ChartLineUp size={13} aria-hidden />}
      open={open}
      onOpenChange={setOpen}
    >
      {data.error ? (
        <p role="alert" className="text-[12px] text-nc-bad">
          分时读取失败：{data.error.message}
        </p>
      ) : !data.data ? (
        <p role="status" className="text-[12px] text-nc-text-3">
          正在读取分时…
        </p>
      ) : points.length === 0 ? (
        <p className="text-[12px] text-nc-text-3">源返回空分时序列。</p>
      ) : (
        <div className="space-y-0.5">
          <Row head cells={["时间", "价格", "成交量", "成交额"]} />
          {tail.map((point, index) => (
            <Row
              key={`${point.time}-${index}`}
              cells={[
                point.time,
                fixed(point.price, precision),
                compact(point.volume),
                compact(point.turnover),
              ]}
            />
          ))}
        </div>
      )}
      {data.data && (
        <p className="text-[10.5px] text-nc-text-4">
          {data.data.date ?? "未标注日期"} · {points.length} 点，显示最近{" "}
          {tail.length} 点 · 单位 {data.data.volumeUnit || "源单位未标注"}
        </p>
      )}
    </Section>
  );
}

function CapitalFlowSection({ symbol }: { symbol: string }) {
  const visible = useScreenVisible();
  const [open, setOpen] = useState(false);
  const flows = api.thsdkCapitalFlows.useQuery([symbol], {
    enabled: visible && open,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const popularity = api.thsdkPopularity.useQuery(symbol, {
    enabled: visible && open,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const flow = flows.data?.items.find((item) => item.symbol === symbol);
  return (
    <Section
      label="资金流与热度"
      icon={<Fire size={13} aria-hidden />}
      open={open}
      onOpenChange={setOpen}
    >
      {flows.error ? (
        <p role="alert" className="text-[12px] text-nc-bad">
          资金流读取失败：{flows.error.message}
        </p>
      ) : !flows.data ? (
        <p role="status" className="text-[12px] text-nc-text-3">
          正在读取资金流…
        </p>
      ) : !flow ? (
        <p className="text-[12px] text-nc-text-3">源未返回该证券资金流。</p>
      ) : (
        <div className="space-y-0.5">
          <Row head cells={["项目", "买", "卖", "净额"]} />
          <Row
            cells={[
              "超大单主动",
              compact(flow.activeBuyXLarge),
              compact(flow.activeSellXLarge),
              compact(net(flow.activeBuyXLarge, flow.activeSellXLarge)),
            ]}
          />
          <Row
            cells={[
              "大单主动",
              compact(flow.activeBuyLarge),
              compact(flow.activeSellLarge),
              compact(net(flow.activeBuyLarge, flow.activeSellLarge)),
            ]}
          />
          <Row
            cells={[
              "超大单被动",
              compact(flow.passiveBuyXLarge),
              compact(flow.passiveSellXLarge),
              compact(net(flow.passiveBuyXLarge, flow.passiveSellXLarge)),
            ]}
          />
          <Row
            cells={[
              "大单被动",
              compact(flow.passiveBuyLarge),
              compact(flow.passiveSellLarge),
              compact(net(flow.passiveBuyLarge, flow.passiveSellLarge)),
            ]}
          />
          <Row cells={["主力净流入", "", "", compact(flow.mainNetInflow)]} />
          <p className="text-[11px] text-nc-text-3">
            成交额 {compact(flow.turnover)}
          </p>
        </div>
      )}
      {popularity.error ? (
        <p role="alert" className="text-[12px] text-nc-bad">
          热度读取失败：{popularity.error.message}
        </p>
      ) : popularity.data ? (
        <p className="text-[11px] text-nc-text-3">
          热度排名 {popularity.data.rank ?? "—"} · 排名金额{" "}
          {compact(popularity.data.rankAmount)} · 变化{" "}
          {popularity.data.rankChange ?? "—"}
        </p>
      ) : null}
      <p className="text-[10.5px] text-nc-text-4">
        资金流字段按源单位原样展示，不推算成交均价；热度为源排名口径。
      </p>
    </Section>
  );
}

const tagScore = (score: number | null | undefined) =>
  score === null || score === undefined ? null : displayNumber(score, 1);

function ConceptTagChip({
  tag,
}: {
  tag: { name: string; score: number | null };
}) {
  const score = tagScore(tag.score);
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded border border-nc-border-soft px-1.5 py-0.5 text-[11px]">
      <span className="min-w-0 truncate">{tag.name}</span>
      {score !== null && (
        <span className="flex-none text-nc-text-4 tabular-nums">{score}</span>
      )}
    </span>
  );
}

function BlocksAndConceptsSection({ symbol }: { symbol: string }) {
  const visible = useScreenVisible();
  const [open, setOpen] = useState(false);
  const data = api.thsdkSecurityBlocks.useQuery(symbol, {
    enabled: visible && open,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const profile = data.data;
  const core = profile?.conceptTags.filter((tag) => tag.kind === "bond") ?? [];
  const normal =
    profile?.conceptTags.filter((tag) => tag.kind === "normal") ?? [];
  const other =
    profile?.conceptTags.filter((tag) => tag.kind === "other") ?? [];
  // 成分块按成分家数降序，只展示前 12 个，避免侧栏被长尾淹没。
  const memberships = [...(profile?.memberships ?? [])]
    .sort((a, b) => (b.count ?? -1) - (a.count ?? -1))
    .slice(0, 12);
  return (
    <Section
      label="同花顺行业与概念"
      icon={<Tag size={13} aria-hidden />}
      open={open}
      onOpenChange={setOpen}
    >
      {data.error ? (
        <p role="alert" className="text-[12px] text-nc-bad">
          行业与概念读取失败：{data.error.message}
        </p>
      ) : !profile ? (
        <p role="status" className="text-[12px] text-nc-text-3">
          正在读取同花顺行业与概念…
        </p>
      ) : (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
            <span className="text-nc-text-4">行业</span>
            {profile.industry ? (
              <span className="rounded border border-nc-accent-600 px-1.5 py-0.5 text-nc-accent-light">
                {profile.industry.name}
                {profile.industry.code && (
                  <span className="ml-1 text-nc-text-4 tabular-nums">
                    {profile.industry.code}
                  </span>
                )}
              </span>
            ) : (
              <span className="text-nc-text-3">源未返回行业</span>
            )}
          </div>
          <div className="space-y-1">
            <p className="m-0 text-[11px] text-nc-text-4">
              核心概念 {core.length} 个
            </p>
            {core.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {core.map((tag) => (
                  <ConceptTagChip key={`bond:${tag.name}`} tag={tag} />
                ))}
              </div>
            ) : (
              <p className="m-0 text-[11.5px] text-nc-text-3">
                源未标注核心概念。
              </p>
            )}
          </div>
          <div className="space-y-1">
            <p className="m-0 text-[11px] text-nc-text-4">
              普通概念 {normal.length} 个
            </p>
            {normal.length > 0 ? (
              <div className="max-h-28 overflow-auto pr-1">
                <div className="flex flex-wrap gap-1">
                  {normal.map((tag) => (
                    <ConceptTagChip key={`normal:${tag.name}`} tag={tag} />
                  ))}
                </div>
              </div>
            ) : (
              <p className="m-0 text-[11.5px] text-nc-text-3">
                源未标注普通概念。
              </p>
            )}
          </div>
          {other.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {other.map((tag) => (
                <ConceptTagChip key={`other:${tag.name}`} tag={tag} />
              ))}
            </div>
          )}
          <div className="space-y-0.5">
            <p className="m-0 text-[11px] text-nc-text-4">
              所属板块 {profile.memberships.length} 个
              {profile.memberships.length > memberships.length
                ? ` · 显示前 ${memberships.length} 个`
                : ""}
            </p>
            {memberships.length === 0 ? (
              <p className="m-0 text-[11.5px] text-nc-text-3">
                源未返回板块归属。
              </p>
            ) : (
              memberships.map((block) => (
                <div
                  key={`${block.blockId}:${block.blockName}`}
                  className="flex items-center justify-between gap-2 text-[11.5px]"
                >
                  <span className="min-w-0 truncate">{block.blockName}</span>
                  <span className="flex-none text-nc-text-4 tabular-nums">
                    {block.count === null ? "—" : `${block.count} 只`}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
      <p className="text-[10.5px] text-nc-text-4">
        同花顺行业与概念为参考视角，不改变东方财富四池与本机概念名单。
      </p>
    </Section>
  );
}
