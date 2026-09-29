"use client";
import { useState } from "react";
import { Button } from "../ui/button";
import { clsTextChunk } from "~/lib/news/cls-review-workspace";

/** All text remains reachable; only the visible segment participates in layout. */
export function ClsReviewText({
  text,
  label,
  locate,
}: {
  text: string;
  label: string;
  locate?: string;
}) {
  const [page, setPage] = useState(() =>
    Math.floor(Math.max(0, locate ? text.indexOf(locate) : 0) / 8000),
  );
  const count = Math.max(1, Math.ceil(text.length / 8000));
  const current = Math.min(page, count - 1);
  return (
    <div className="min-w-0 space-y-2">
      {count > 1 && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span>
            {label}第 {current + 1} / {count} 段 · 全文可逐段阅读或导出
          </span>
          <Button
            size="sm"
            variant="outline"
            aria-label={`${label}上一段`}
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
          >
            上一段
          </Button>
          <Button
            size="sm"
            variant="outline"
            aria-label={`${label}下一段`}
            disabled={current === count - 1}
            onClick={() => setPage(current + 1)}
          >
            下一段
          </Button>
        </div>
      )}
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded bg-nc-inset p-3 text-xs">
        {clsTextChunk(text, current)}
      </pre>
    </div>
  );
}
