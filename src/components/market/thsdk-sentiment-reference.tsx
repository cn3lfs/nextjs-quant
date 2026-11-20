"use client";
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Fire } from "@phosphor-icons/react/ssr";
import { api } from "~/trpc/react";
import type { ThsdkLimitUpAttribution } from "~/lib/market/thsdk-sentiment";
import {
  Panel,
  Segmented,
  changeTone,
  signedPercent,
  toneText,
} from "../panels";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useScreenVisible } from "../workbench/use-task-visible";
import { ChartSymbolLink } from "./chart-symbol-link";

type Signal = "limit_up" | "limit_down" | "limit_up_break" | "limit_down_break";
type ReferenceTab = "realtime" | "market" | "auction" | "attribution";

const signalOptions = [
  { value: "limit_up", label: "涨停" },
  { value: "limit_down", label: "跌停" },
  { value: "limit_up_break", label: "炸板" },
  { value: "limit_down_break", label: "跌停开板" },
] as const satisfies readonly { value: Signal; label: string }[];

const tabOptions = [
  { value: "realtime", label: "实时信号" },
  { value: "market", label: "大盘异动" },
  { value: "auction", label: "竞价异动" },
  { value: "attribution", label: "个股涨停归因" },
] as const satisfies readonly { value: ReferenceTab; label: string }[];

const auctionMarketOptions = [
  { value: "USHA", label: "沪市" },
  { value: "USZA", label: "深市" },
] as const;

const dash = (value: string | number | null | undefined) =>
  value === null || value === undefined || value === "" ? "—" : String(value);

function Row({
  cells,
  head = false,
  template,
}: {
  cells: ReactNode[];
  head?: boolean;
  template: string;
}) {
  return (
    <div
      className={`grid gap-2 ${head ? "text-[10.5px] text-nc-text-4" : "text-[11.5px] tabular-nums"}`}
      style={{ gridTemplateColumns: template }}
    >
      {cells.map((cell, index) => (
        <span
          key={index}
          className={index === 0 ? "min-w-0 truncate" : "text-right"}
        >
          {cell}
        </span>
      ))}
    </div>
  );
}

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="m-0 text-[12px] text-nc-bad">
      {children}
    </p>
  );
}

/** THSDK 未启用、未配置或未登录时，错误旁直接给出设置入口。 */
const setupHintPattern =
  /未启用|未配置|尚未配置|请先配置|请先登录|会话已失效|认证|凭据|DLL|组件/;

function SetupHint({ message }: { message: string }) {
  if (!setupHintPattern.test(message)) return null;
  return (
    <Link
      href="/system?section=thsdk"
      className="ml-2 underline text-nc-accent"
    >
      前往启用同花顺行情
    </Link>
  );
}

function StatusLine({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="m-0 text-[12px] text-nc-text-3">
      {children}
    </p>
  );
}

const referenceNote =
  "同花顺参考视角，与东方财富已确认四池及复盘统计完全隔离；未登录或盘后无数据时不写入本地四池缓存。";

/**
 * 同花顺打板与盘中异动参考。默认收起且收起时不挂载查询体，
 * 未展开的页面保持零 tRPC 请求，也不影响东方财富四池的既有流程。
 * `embedded` 用于打板情绪的数据源切换：直接展开为当前视图，不再套一层收起开关。
 */
export function ThsdkSentimentReference({
  date,
  embedded = false,
}: {
  date: string;
  embedded?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (embedded) {
    return (
      <Panel
        span={12}
        icon={Fire}
        title="同花顺打板与盘中异动参考"
        note={referenceNote}
      >
        <div id="thsdk-sentiment-reference">
          <ThsdkSentimentReferenceBody date={date} />
        </div>
      </Panel>
    );
  }
  return (
    <Panel
      span={12}
      icon={Fire}
      title="同花顺打板与盘中异动参考"
      actions={
        <Button
          variant="outline"
          size="sm"
          aria-expanded={open}
          aria-controls="thsdk-sentiment-reference"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "收起" : "展开同花顺参考"}
        </Button>
      }
      note={referenceNote}
    >
      <div id="thsdk-sentiment-reference">
        {open ? (
          <ThsdkSentimentReferenceBody date={date} />
        ) : (
          <p className="m-0 text-sm text-nc-text-3">
            展开后读取同花顺实时信号、大盘异动、竞价异动与涨停归因；不展开不读取，也不会新建定时刷新。
          </p>
        )}
      </div>
    </Panel>
  );
}

function ThsdkSentimentReferenceBody({ date }: { date: string }) {
  const visible = useScreenVisible();
  const [tab, setTab] = useState<ReferenceTab>("realtime");
  const [signal, setSignal] = useState<Signal>("limit_up");
  const [auctionMarket, setAuctionMarket] = useState<"USHA" | "USZA">("USHA");
  const [symbolDraft, setSymbolDraft] = useState("");
  const [attributionSymbol, setAttributionSymbol] = useState("");

  const realtime = api.thsdkRealtimeSignal.useQuery(
    { signal, markets: ["USHA", "USZA"] },
    {
      enabled: visible && tab === "realtime",
      retry: false,
      refetchOnWindowFocus: false,
    },
  );
  const market = api.thsdkMarketChangeEvents.useQuery(undefined, {
    enabled: visible && tab === "market",
    retry: false,
    refetchOnWindowFocus: false,
  });
  const auction = api.thsdkCallAuctionUnusual.useQuery(
    { market: auctionMarket, tradeDate: date || undefined },
    {
      enabled: visible && tab === "auction",
      retry: false,
      refetchOnWindowFocus: false,
    },
  );
  const attribution = api.thsdkLimitUpAnalysis.useQuery(
    { symbol: attributionSymbol, date: date || undefined },
    {
      enabled: visible && tab === "attribution" && attributionSymbol !== "",
      retry: false,
      refetchOnWindowFocus: false,
    },
  );

  return (
    <div className="space-y-2">
      <Segmented
        label="同花顺参考视图"
        value={tab}
        onChange={setTab}
        options={tabOptions}
      />
      {tab === "realtime" && (
        <div className="space-y-2">
          <Segmented
            label="同花顺实时信号"
            value={signal}
            onChange={setSignal}
            options={signalOptions}
          />
          {realtime.error ? (
            <ErrorLine>
              同花顺实时信号读取失败：{realtime.error.message}
              <SetupHint message={realtime.error.message} />
            </ErrorLine>
          ) : !realtime.data ? (
            <StatusLine>正在读取同花顺实时信号…</StatusLine>
          ) : !realtime.data.available ? (
            <StatusLine>
              {realtime.data.emptyReason ??
                "当前非交易时段或暂无该实时信号样本。"}
            </StatusLine>
          ) : realtime.data.items.length === 0 ? (
            <StatusLine>该信号当前没有样本。</StatusLine>
          ) : (
            <div className="max-h-72 space-y-0.5 overflow-auto pr-1">
              <Row
                head
                template="1.5fr 0.7fr 0.8fr 1.3fr"
                cells={["证券", "涨跌幅", "信号时间", "原因"]}
              />
              {realtime.data.items.map((item, index) => (
                <Row
                  key={`${item.market}:${item.code}:${index}`}
                  template="1.5fr 0.7fr 0.8fr 1.3fr"
                  cells={[
                    item.symbol ? (
                      <ChartSymbolLink
                        symbol={item.symbol}
                        name={item.name ?? undefined}
                      />
                    ) : (
                      `${dash(item.name)} · ${item.code}`
                    ),
                    <span className={toneText[changeTone(item.changePct)]}>
                      {signedPercent(item.changePct)}
                    </span>,
                    <span className="text-nc-text-3">
                      {dash(item.signalTime)}
                    </span>,
                    <span
                      className="text-nc-text-3"
                      title={item.reason ?? undefined}
                    >
                      {dash(item.reason)}
                    </span>,
                  ]}
                />
              ))}
            </div>
          )}
        </div>
      )}
      {tab === "market" && (
        <div className="space-y-2">
          {market.error ? (
            <ErrorLine>
              同花顺大盘异动读取失败：{market.error.message}
              <SetupHint message={market.error.message} />
            </ErrorLine>
          ) : !market.data ? (
            <StatusLine>正在读取同花顺大盘异动…</StatusLine>
          ) : market.data.items.length === 0 ? (
            <StatusLine>源当前没有返回大盘异动事件。</StatusLine>
          ) : (
            <ul className="m-0 max-h-72 list-none space-y-1.5 overflow-auto p-0 pr-1">
              {market.data.items.map((item) => (
                <li
                  key={item.id}
                  className="rounded border border-nc-border-soft px-2 py-1.5"
                >
                  <div className="flex flex-wrap items-baseline gap-2">
                    <strong className="text-[12.5px] font-medium">
                      {dash(item.mainTitle || item.title)}
                    </strong>
                    <span className="text-[10.5px] text-nc-text-4 tabular-nums">
                      {dash(item.eventType)} · {dash(item.publishedAt)}
                    </span>
                  </div>
                  {item.mainTitle && item.mainTitle !== item.title && (
                    <p className="m-0 mt-0.5 text-[11.5px] text-nc-text-3">
                      {item.title}
                    </p>
                  )}
                  {item.relatedSecurities.length > 0 && (
                    <p className="m-0 mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px]">
                      {item.relatedSecurities.map((security) =>
                        security.symbol ? (
                          <ChartSymbolLink
                            key={`${security.code}:${security.symbol}`}
                            symbol={security.symbol}
                            name={security.name}
                          />
                        ) : (
                          <span key={security.code} className="text-nc-text-3">
                            {security.name} · {security.code}
                          </span>
                        ),
                      )}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {tab === "auction" && (
        <div className="space-y-2">
          <Segmented
            label="竞价异动市场"
            value={auctionMarket}
            onChange={setAuctionMarket}
            options={auctionMarketOptions}
          />
          {auction.error ? (
            <ErrorLine>
              同花顺竞价异动读取失败：{auction.error.message}
              <SetupHint message={auction.error.message} />
            </ErrorLine>
          ) : !auction.data ? (
            <StatusLine>正在读取同花顺竞价异动…</StatusLine>
          ) : !auction.data.available ? (
            <StatusLine>
              {auction.data.emptyReason ??
                "当前非交易时段或该日暂无竞价异动样本。"}
            </StatusLine>
          ) : auction.data.items.length === 0 ? (
            <StatusLine>该市场没有竞价异动样本。</StatusLine>
          ) : (
            <div className="max-h-72 space-y-0.5 overflow-auto pr-1">
              <Row
                head
                template="1.4fr 0.7fr 0.9fr 1.4fr"
                cells={["证券", "涨跌幅", "事件时间", "异动"]}
              />
              {auction.data.items.map((item, index) => (
                <Row
                  key={`${item.code}:${index}`}
                  template="1.4fr 0.7fr 0.9fr 1.4fr"
                  cells={[
                    item.symbol ? (
                      <ChartSymbolLink
                        symbol={item.symbol}
                        name={item.name ?? undefined}
                      />
                    ) : (
                      `${dash(item.name)} · ${item.code}`
                    ),
                    <span className={toneText[changeTone(item.changePct)]}>
                      {signedPercent(item.changePct)}
                    </span>,
                    <span className="text-nc-text-3">
                      {dash(item.eventTime)}
                    </span>,
                    <span
                      className="text-nc-text-3"
                      title={item.detail ?? undefined}
                    >
                      {dash(item.title || item.eventType || "—")}
                    </span>,
                  ]}
                />
              ))}
            </div>
          )}
        </div>
      )}
      {tab === "attribution" && (
        <div className="space-y-2">
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const next = symbolDraft.trim();
              if (next === "") return;
              // 同一代码再次提交时 state 不变，显式重发以支持失败重试。
              if (next === attributionSymbol) {
                if (visible) void attribution.refetch();
                return;
              }
              setAttributionSymbol(next);
            }}
          >
            <Input
              value={symbolDraft}
              onChange={(event) => setSymbolDraft(event.target.value)}
              placeholder="如 sh600519"
              aria-label="涨停归因证券代码"
              className="h-7 w-[160px]"
            />
            <Button
              size="sm"
              type="submit"
              disabled={symbolDraft.trim() === ""}
            >
              查询归因
            </Button>
            {attributionSymbol && (
              <span className="text-[11px] text-nc-text-4">
                当前 {attributionSymbol} · {date || "最新交易日"}
              </span>
            )}
          </form>
          {!attributionSymbol ? (
            <StatusLine>
              输入证券代码后查询该股同花顺涨停归因；未提交不读取。
            </StatusLine>
          ) : attribution.error ? (
            <ErrorLine>
              同花顺涨停归因读取失败：{attribution.error.message}
              <SetupHint message={attribution.error.message} />
            </ErrorLine>
          ) : !attribution.data ? (
            <StatusLine>正在读取同花顺涨停归因…</StatusLine>
          ) : (
            <AttributionBody data={attribution.data} />
          )}
        </div>
      )}
    </div>
  );
}

function AttributionBody({ data }: { data: ThsdkLimitUpAttribution }) {
  const fields: { label: string; value: string }[] = [
    { label: "证券", value: data.symbol },
    { label: "交易日", value: dash(data.date) },
    { label: "涨停类型", value: dash(data.limitUpType) },
    { label: "几天几板", value: dash(data.highDays) },
    { label: "连板天数", value: dash(data.streakDays) },
    { label: "开板次数", value: dash(data.openCount) },
    { label: "首次涨停", value: dash(data.firstLimitUpTime) },
    { label: "最后涨停", value: dash(data.lastLimitUpTime) },
    { label: "涨停原因", value: dash(data.reason) },
    {
      label: "原因标签",
      value: data.reasons.length ? data.reasons.join("、") : "—",
    },
    {
      label: "概念",
      value: data.concepts.length ? data.concepts.join("、") : "—",
    },
  ];
  return (
    <div className="space-y-2">
      {!data.available && (
        <StatusLine>
          {data.statusMessage ??
            data.reason ??
            "同花顺未返回该证券的涨停归因。"}
        </StatusLine>
      )}
      <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-1 text-[11.5px] md:grid-cols-3">
        {fields.map((field) => (
          <div key={field.label} className="min-w-0">
            <dt className="text-nc-text-4">{field.label}</dt>
            <dd className="m-0 truncate tabular-nums" title={field.value}>
              {field.value}
            </dd>
          </div>
        ))}
      </dl>
      <p className="m-0 text-[10.5px] text-nc-text-4">
        读取于{" "}
        {new Date(data.fetchedAt).toLocaleString("zh-CN", {
          hour12: false,
          timeZone: "Asia/Shanghai",
        })}
      </p>
    </div>
  );
}
