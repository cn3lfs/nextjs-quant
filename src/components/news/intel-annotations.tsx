"use client";
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { api } from "~/trpc/react";
import type { IntelEvent } from "~/lib/news/intel-events";
import type { Bar } from "~/lib/domain";
import { usePanelVisible } from "../workbench/keep-alive";
import { Button } from "../ui/button";
import { NewsTime } from "./news-time";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog";

export function IntelAnnotations({
  symbol,
  bars,
  render,
}: {
  symbol: string;
  bars: readonly Bar[];
  render: (events: IntelEvent[], select: (id: string) => void) => ReactNode;
}) {
  const visible = usePanelVisible();
  const [selected, setSelected] = useState("");
  const first = bars[0]?.date ?? "",
    last = bars.at(-1)?.date ?? "";
  const zone = symbol.startsWith("cx") ? "Z" : "+08:00";
  const from = Date.parse(
      first.length === 10 ? `${first}T00:00:00${zone}` : first,
    ),
    to = Math.min(
      Date.now(),
      Date.parse(last.length === 10 ? `${last}T23:59:59.999${zone}` : last),
    );
  const query = api.intelEvents.useQuery(
    {
      symbol,
      from: Number.isFinite(from) ? from : 0,
      to: Number.isFinite(to) ? to : 0,
    },
    { enabled: visible && bars.length > 0, retry: false, staleTime: 60000 },
  );
  const events = query.data ?? [],
    event = events.find((e) => e.id === selected);
  return (
    <>
      {render(events, setSelected)}
      <section
        aria-label="图表新闻事件"
        className="space-y-2 rounded border p-3"
      >
        <h3>图表新闻事件</h3>
        <p className="text-xs text-nc-text-3">
          已有新闻按名称/代码匹配；不在 K
          线图叠加文字标签，点击下方标题展开详情。
        </p>
        {query.error && (
          <p className="text-xs" role="status">
            新闻标注不可用：{query.error.message}
          </p>
        )}
        {query.data?.length === 0 && (
          <p className="text-xs">当前区间没有匹配的已有新闻。</p>
        )}
        <div className="flex flex-wrap gap-2">
          {events.map((e) => (
            <Button
              size="sm"
              variant="outline"
              className="h-auto max-w-full whitespace-normal text-left"
              key={e.id}
              onClick={() => setSelected(e.id)}
            >
              <NewsTime value={e.publishedAt} short /> · {e.title}
            </Button>
          ))}
        </div>
      </section>
      <Dialog
        open={!!event}
        onOpenChange={(open) => {
          if (!open) setSelected("");
        }}
      >
        <DialogContent>
          <DialogTitle>{event?.title}</DialogTitle>
          <DialogDescription>
            {event ? (
              <>
                <NewsTime value={event.publishedAt} /> · 原文节选
              </>
            ) : (
              ""
            )}
          </DialogDescription>
          <p className="whitespace-pre-wrap text-sm">{event?.preview}</p>
          {event && (
            <Link href={event.href} className="underline">
              在情报查看原文
            </Link>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
