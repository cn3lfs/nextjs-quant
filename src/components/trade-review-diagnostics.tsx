"use client";

import { Children, useState, type ReactNode } from "react";
import type { NavDiagnostic } from "~/lib/trade-review-nav";
import { Button } from "./ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";

export function ReviewDisclosure({
  label,
  children,
  preview = 0,
}: {
  label: string;
  children: ReactNode;
  preview?: number;
}) {
  const [open, setOpen] = useState(false);
  const items = Children.toArray(children);
  return (
    <>
      <div>{items.slice(0, preview)}</div>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <Button variant="outline">
            {label} · {open ? "收起" : "展开查看"}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-2 pt-2">
          {items.slice(preview)}
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}

export function groupNavDiagnostics(rows: readonly NavDiagnostic[]) {
  const groups = new Map<
    string,
    { reason: string; count: number; dates: Set<string> }
  >();
  for (const row of rows) {
    // Only the display key is normalized; exported diagnostic evidence stays exact.
    const reason = row.reason
      .replace(/\d{4}-\d{2}-\d{2}\s*/g, "")
      .replace(/期初净值非正（[^）]*）/g, "期初净值非正")
      .replace(/资金流水 \d+/g, "资金流水")
      .replace(/原始行 \d+/g, "原始行");
    const group = groups.get(reason) ?? {
      reason,
      count: 0,
      dates: new Set<string>(),
    };
    group.count++;
    group.dates.add(row.date);
    groups.set(reason, group);
  }
  return [...groups.values()].map((g) => {
    const dates = [...g.dates].sort();
    return `${g.reason}：${dates.length} 天 / ${g.count} 条（${dates[0]} 至 ${dates.at(-1)}）`;
  });
}

export function ReviewDiagnostics({
  rows,
}: {
  rows: readonly NavDiagnostic[];
}) {
  const groups = groupNavDiagnostics(rows);
  if (!rows.length) return null;
  return (
    <div className="space-y-2">
      {groups.slice(0, 3).map((text) => (
        <p key={text}>{text}</p>
      ))}
      <ReviewDisclosure label={`共 ${rows.length} 条，${groups.length} 类原因`}>
        {groups.slice(3).map((text) => (
          <p key={text}>{text}</p>
        ))}
        <ReviewDisclosure label="逐日原始原因">
          {rows.map((row, i) => (
            <p key={i}>
              {row.date} · {row.reason}
            </p>
          ))}
        </ReviewDisclosure>
      </ReviewDisclosure>
    </div>
  );
}
