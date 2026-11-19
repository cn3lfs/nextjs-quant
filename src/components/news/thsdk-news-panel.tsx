"use client";
import { useState } from "react";
import { Article, Lightning } from "@phosphor-icons/react/ssr";
import { api } from "~/trpc/react";
import { cn } from "~/lib/common/classnames";
import { THSDK_NEWS_FLASH_MAX_PAGE } from "~/lib/market/thsdk-extensions";
import {
  MethodologyPopover,
  PageGrid,
  Panel,
  PanelEmpty,
  Pill,
  toneEdge,
} from "../panels";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useTaskVisible } from "../workbench/use-task-visible";

const pageSize = 20;

const newsMethodology = [
  {
    label: "数据来源",
    detail:
      "同花顺 7×24 快讯与个股研报均由 thsdk-hq 返回；标题、摘要与时间按源原样展示，不做本地改写。",
  },
  {
    label: "刷新方式",
    detail:
      "只在页面可见且窗口聚焦时读取；翻页与切换标签沿用同一查询，不新建定时刷新。",
  },
  {
    label: "外部链接",
    detail:
      "只对 http:// 或 https:// 的原文链接生成跳转；其余协议一律丢弃，不渲染可点击链接。",
  },
] as const;

const timeText = (epoch: number | null) =>
  epoch === null
    ? "—"
    : new Date(epoch).toLocaleString("zh-CN", {
        hour12: false,
        timeZone: "Asia/Shanghai",
      });

const safeUrl = (value: string | null) =>
  value && (value.startsWith("http://") || value.startsWith("https://"))
    ? value
    : null;

function ExternalLink({ url }: { url: string | null }) {
  const href = safeUrl(url);
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-[11px] text-primary underline underline-offset-2 hover:no-underline"
    >
      查看原文
    </a>
  );
}

/** 同花顺快讯与研报：7×24 快讯主面板 + 个股研报速览侧栏。 */
export function ThsdkNewsPanel() {
  const visible = useTaskVisible();
  const [page, setPage] = useState(1);
  const [tag, setTag] = useState<string | undefined>(undefined);
  const [symbolDraft, setSymbolDraft] = useState("");
  const [symbol, setSymbol] = useState("");

  const flash = api.thsdkNewsFlash.useQuery(
    { page, pageSize, tag },
    {
      enabled: visible,
      retry: false,
      refetchOnWindowFocus: false,
    },
  );
  const reports = api.thsdkResearchReports.useQuery(
    { symbol },
    {
      enabled: visible && symbol !== "",
      retry: false,
      refetchOnWindowFocus: false,
    },
  );

  const items = flash.data?.items ?? [];
  const filters = flash.data?.filters ?? [];
  const total = flash.data?.total ?? null;
  const hasNext =
    page < THSDK_NEWS_FLASH_MAX_PAGE &&
    (total !== null ? page * pageSize < total : items.length >= pageSize);

  function selectTag(next: string | undefined) {
    setTag(next);
    setPage(1);
  }

  return (
    <PageGrid>
      <Panel
        span={8}
        icon={Lightning}
        title="同花顺 7×24 快讯"
        meta={
          flash.data
            ? `第 ${page} 页 · ${items.length} 条${total === null ? "" : ` / 共 ${total} 条`}`
            : undefined
        }
        actions={
          <div className="flex flex-wrap items-center gap-1.5">
            <MethodologyPopover items={newsMethodology} />
            <Button
              variant="outline"
              size="sm"
              disabled={flash.isFetching}
              onClick={() => void flash.refetch()}
            >
              刷新
            </Button>
          </div>
        }
        note="数据：同花顺 7×24 快讯（thsdk-hq）。重要标记与标签由源提供，只作阅读参考。"
      >
        {flash.error && (
          <p role="alert" className="m-0 mb-2 text-[13px] text-nc-bad">
            快讯读取失败：{flash.error.message}
            {flash.data ? "；下方保留上次读取的列表。" : ""}
          </p>
        )}
        {filters.length > 0 && (
          <div
            role="group"
            aria-label="快讯标签筛选"
            className="mb-2 flex flex-wrap gap-1"
          >
            <Button
              variant={tag === undefined ? "default" : "outline"}
              size="sm"
              aria-pressed={tag === undefined}
              className="h-6 px-2 text-[11px]!"
              onClick={() => selectTag(undefined)}
            >
              全部
            </Button>
            {filters.map((filter) => (
              <Button
                key={filter.id}
                variant={tag === filter.id ? "default" : "outline"}
                size="sm"
                aria-pressed={tag === filter.id}
                className="h-6 px-2 text-[11px]!"
                onClick={() => selectTag(filter.id)}
              >
                {filter.name}
              </Button>
            ))}
          </div>
        )}
        {!flash.data ? (
          <PanelEmpty>
            {flash.error
              ? "读取失败；可重试，或回到第 1 页重新读取。"
              : "正在读取同花顺快讯…"}
          </PanelEmpty>
        ) : items.length === 0 ? (
          <PanelEmpty>
            {tag === undefined ? "源当前没有返回快讯。" : "该标签下暂无快讯。"}
          </PanelEmpty>
        ) : (
          <ul className="m-0 list-none space-y-2 p-0">
            {items.map((item) => (
              <li
                key={item.id}
                className={cn(
                  "rounded border border-nc-border-soft px-2.5 py-2",
                  item.important && `${toneEdge.warn} bg-nc-inset`,
                )}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[10.5px] text-nc-text-4 tabular-nums">
                    {timeText(item.publishedAt)}
                  </span>
                  {item.important && <Pill tone="warn">重要</Pill>}
                  {item.tags.map((value) => (
                    <span
                      key={value}
                      className="rounded border border-nc-border-soft px-1 text-[10px] text-nc-text-3"
                    >
                      {value}
                    </span>
                  ))}
                </div>
                <p className="m-0 mt-1 text-[13px] font-medium">{item.title}</p>
                {item.digest && (
                  <p className="m-0 mt-0.5 text-[11.5px] leading-relaxed text-nc-text-3">
                    {item.digest}
                  </p>
                )}
                <div className="mt-1">
                  <ExternalLink url={item.url} />
                </div>
              </li>
            ))}
          </ul>
        )}
        <nav
          aria-label="同花顺快讯分页"
          className="mt-3 flex flex-wrap items-center justify-between gap-2"
        >
          <Button
            variant="outline"
            size="sm"
            disabled={page === 1 || flash.isFetching}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
          >
            上一页
          </Button>
          <span className="flex items-center gap-2 text-[11.5px] text-nc-text-3 tabular-nums">
            第 {page} 页
            {page > 1 && (
              <Button
                variant="plain"
                size="sm"
                className="h-6 px-2 text-[11px]!"
                onClick={() => setPage(1)}
              >
                回到第 1 页
              </Button>
            )}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={!hasNext || flash.isFetching}
            onClick={() => setPage((value) => value + 1)}
          >
            下一页
          </Button>
        </nav>
      </Panel>
      <Panel
        span={4}
        icon={Article}
        title="个股研报速览"
        note="数据：同花顺个股研报（thsdk-hq）。摘要按源原样展示，不构成投资建议。"
      >
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const next = symbolDraft.trim();
            if (next === "") return;
            // 同一代码再次提交时 state 不变，显式重发以支持失败重试。
            if (next === symbol) {
              if (visible) void reports.refetch();
              return;
            }
            setSymbol(next);
          }}
        >
          <Input
            value={symbolDraft}
            onChange={(event) => setSymbolDraft(event.target.value)}
            placeholder="如 sh600519"
            aria-label="研报证券代码"
            className="h-8 min-w-[140px] flex-1"
          />
          <Button size="sm" type="submit" disabled={symbolDraft.trim() === ""}>
            查询研报
          </Button>
        </form>
        <div className="mt-2">
          {symbol === "" ? (
            <PanelEmpty>输入证券代码后查询该股研报；未提交不读取。</PanelEmpty>
          ) : reports.error ? (
            <p role="alert" className="m-0 text-[13px] text-nc-bad">
              研报读取失败：{reports.error.message}
            </p>
          ) : !reports.data ? (
            <PanelEmpty>正在读取 {symbol} 的研报…</PanelEmpty>
          ) : reports.data.items.length === 0 ? (
            <PanelEmpty>源未返回 {symbol} 的研报。</PanelEmpty>
          ) : (
            <ul className="m-0 max-h-[32rem] list-none space-y-2 overflow-auto p-0 pr-1">
              {reports.data.items.map((report) => (
                <li
                  key={report.id}
                  className="rounded border border-nc-border-soft px-2.5 py-2"
                >
                  <p className="m-0 text-[12.5px] font-medium">
                    {report.title}
                  </p>
                  <p className="m-0 mt-0.5 flex flex-wrap gap-x-2 text-[10.5px] text-nc-text-4">
                    <span>{report.org ?? "机构未标注"}</span>
                    <span>{report.researcher ?? "作者未标注"}</span>
                    <span className="tabular-nums">
                      {report.publishedAt ?? "—"}
                    </span>
                  </p>
                  {report.abstract && (
                    <p className="m-0 mt-1 line-clamp-4 text-[11.5px] leading-relaxed text-nc-text-3">
                      {report.abstract}
                    </p>
                  )}
                  <div className="mt-1">
                    <ExternalLink url={report.url} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Panel>
    </PageGrid>
  );
}
