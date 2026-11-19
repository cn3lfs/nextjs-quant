"use client";
import { Info } from "@phosphor-icons/react/ssr";
import type { JSX } from "react";
import { Button } from "../ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../ui/popover";

export type MethodologyItem = { label: string; detail: string };

/**
 * 口径说明 popover：把「这个数字怎么算、覆盖哪段、缺什么」收在标题旁，
 * 不占用正文。按钮保持单行轻量；内容用 dl 逐条列出，键盘可达。
 */
export function MethodologyPopover({
  title = "口径说明",
  items,
  buttonLabel = "口径说明",
  align = "end",
}: {
  title?: string;
  items: readonly MethodologyItem[];
  buttonLabel?: string;
  align?: "start" | "center" | "end";
}): JSX.Element {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-auto min-h-0 gap-1 px-1.5 py-0 text-sub whitespace-nowrap"
        >
          <Info size={14} aria-hidden="true" />
          {buttonLabel}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        className="w-80 max-w-[90vw] space-y-2.5 text-xs"
      >
        <div className="text-sub font-semibold text-nc-text">{title}</div>
        <dl className="m-0 space-y-2">
          {items.map((item, index) => (
            <div key={`${item.label}-${index}`} className="space-y-0.5">
              <dt className="font-semibold text-nc-text">{item.label}</dt>
              <dd className="m-0 leading-relaxed text-nc-text-3">
                {item.detail}
              </dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
}
