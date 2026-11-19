"use client";
import { useState } from "react";
import { isAShareStockSymbol } from "~/lib/market/security-classification";
import { api } from "~/trpc/react";
import { useScreenVisible } from "../workbench/use-task-visible";
import { Button } from "../ui/button";
import { PoolMembersLink } from "./pool-members-link";

type AssociationRow = {
  category: "industry" | "concept";
  code: string;
  name: string;
  selectionName: string;
  sourceDate: string | null;
};

/** Enough rows to scan before the list scrolls or expands. */
const previewLimit = 4;

function AssociationGroup({
  title,
  items,
  compareSymbols,
  onAdd,
}: {
  title: string;
  items: AssociationRow[];
  compareSymbols: string[];
  onAdd: (symbol: string, label: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!items.length) return null;
  const shown = expanded ? items : items.slice(0, previewLimit);
  const full = compareSymbols.length >= 3;
  return (
    <div className="mt-2" data-testid={`compare-sectors-${title}`}>
      <p className="font-medium">
        {title}（{items.length}）
      </p>
      <ul
        className={
          expanded ? "max-h-56 overflow-y-auto" : "max-h-none overflow-visible"
        }
      >
        {shown.map((item) => {
          const symbol = `sh${item.code}`;
          const added = compareSymbols.includes(symbol);
          return (
            <li
              key={`${item.category}:${item.code}`}
              className="flex items-start justify-between gap-2 py-1"
            >
              <span className="min-w-0">
                <span className="block">{item.name}</span>
                <span className="block text-muted-foreground">
                  {item.code}
                  {item.sourceDate ? ` · 更新 ${item.sourceDate}` : ""} ·{" "}
                  <PoolMembersLink
                    category={item.category}
                    name={item.selectionName}
                    label="成分"
                  />
                </span>
              </span>
              <Button
                variant="plain"
                className="shrink-0"
                aria-label={
                  added ? `已加入 ${item.name}` : `加入对比 ${item.name}`
                }
                disabled={added || full}
                onClick={() => onAdd(symbol, item.name)}
              >
                {added ? "已加入" : "加入对比"}
              </Button>
            </li>
          );
        })}
      </ul>
      {items.length > previewLimit && (
        <Button
          variant="plain"
          className="text-muted-foreground"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "收起" : `展开其余 ${items.length - previewLimit} 项`}
        </Button>
      )}
    </div>
  );
}

/**
 * A stock's TDX industry/concept memberships inside the chart compare popover.
 * Mounted only while the popover is open, so closing it issues no reads.
 */
export function ChartCompareSectors({
  symbol,
  compareSymbols,
  onAdd,
}: {
  symbol: string;
  compareSymbols: string[];
  onAdd: (symbol: string, label: string) => void;
}) {
  const visible = useScreenVisible();
  const associations = api.marketPoolAssociations.useQuery(
    { symbol },
    {
      enabled: visible && isAShareStockSymbol(symbol),
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 60000,
    },
  );
  if (!isAShareStockSymbol(symbol)) return null;
  if (associations.error)
    return (
      <p role="alert" className="mt-2 text-muted-foreground">
        所属板块读取失败：{associations.error.message}
      </p>
    );
  const data = associations.data;
  if (!data)
    return (
      <p role="status" className="mt-2 text-muted-foreground">
        正在读取所属板块…
      </p>
    );
  if (data.status !== "ready")
    return (
      <p role="status" className="mt-2 text-muted-foreground">
        {data.message ??
          (data.status === "source-unconfigured"
            ? "未配置本机通达信目录，无法读取所属板块。"
            : "通达信板块资料不可用，无法读取所属板块。")}
      </p>
    );
  const total = data.industry.length + data.concept.length;
  if (!total)
    return (
      <p role="status" className="mt-2 text-muted-foreground">
        当前成分快照未找到该股的行业或概念归属。
      </p>
    );
  const full = compareSymbols.length >= 3;
  return (
    <section
      aria-label="所属板块"
      className="mt-2 border-t border-border pt-2 text-xs"
    >
      <p className="text-muted-foreground">
        来源：本机通达信当前成分快照
        {data.observedAt
          ? ` · 读取于 ${new Date(data.observedAt).toLocaleString("zh-CN", {
              hour12: false,
            })}`
          : ""}
        ；不代表图表历史时点的身份
      </p>
      <AssociationGroup
        title="行业"
        items={data.industry}
        compareSymbols={compareSymbols}
        onAdd={onAdd}
      />
      <AssociationGroup
        title="概念"
        items={data.concept}
        compareSymbols={compareSymbols}
        onAdd={onAdd}
      />
      {full && (
        <p role="status" className="mt-1 text-muted-foreground">
          已满 3 个叠加品种，请先移除一个再添加。
        </p>
      )}
    </section>
  );
}
