"use client";

import { Children, useState, type ReactNode } from "react";
import type { NavDiagnostic } from "~/lib/portfolio/trade-review-nav";
import { groupNavDiagnostics } from "~/lib/portfolio/nav-diagnostics";

export { groupNavDiagnostics };
import { Button } from "../ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible";

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
