"use client";
import { Input } from "~/components/ui/input";

import { useEffect, useId, useRef, useState } from "react";
import { Search, ChevronDown } from "lucide-react";
import { api } from "~/trpc/react";
import type { Period } from "~/lib/domain";

export function SecuritySelect({
  symbol,
  name,
  period,
  disabled,
  onSelect,
}: {
  symbol: string;
  name?: string;
  period: Period;
  disabled: boolean;
  onSelect: (symbol: string) => void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (
        disabled ||
        event.isComposing ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        target.closest(
          "input, textarea, select, [contenteditable=true], [role=dialog]",
        )
      )
        return;
      if (/^[a-z0-9]$/i.test(event.key)) {
        event.preventDefault();
        input.current?.focus();
        setQuery(event.key);
        setActive(0);
        setOpen(true);
      }
    }
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [disabled]);
  const results = api.securities.useQuery(
    { query, period },
    { enabled: open, staleTime: 0 },
  );
  const items = results.data ?? [];
  const index = Math.min(active, Math.max(0, items.length - 1));
  function select(value: string) {
    setOpen(false);
    setQuery("");
    onSelect(value);
  }
  return (
    <div
      className="security-select"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <div className="symbol-search">
        <Search size={16} />
        <Input
          ref={input}
          onClick={() => {
            if (!open) {
              setQuery("");
              setActive(0);
              setOpen(true);
            }
          }}
          role="combobox"
          aria-label="搜索品种名称或代码"
          aria-expanded={open}
          aria-controls={id}
          aria-autocomplete="list"
          aria-activedescendant={
            open && items.length ? `${id}-${index}` : undefined
          }
          disabled={disabled}
          placeholder="名称 / 代码 / 拼音首字母"
          value={
            open
              ? query
              : `${name && name !== symbol ? name + " · " : ""}${symbol.toUpperCase()}`
          }
          onFocus={() => {
            setQuery("");
            setActive(0);
            setOpen(true);
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape") {
              setOpen(false);
              return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
              const next =
                event.key === "ArrowDown"
                  ? Math.min(index + 1, items.length - 1)
                  : Math.max(index - 1, 0);
              setActive(Math.max(0, next));
              document
                .getElementById(`${id}-${next}`)
                ?.scrollIntoView({ block: "nearest" });
            }
            if (event.key === "Enter" && open && items[index]) {
              event.preventDefault();
              select(items[index].symbol);
            }
          }}
        />
        <ChevronDown size={16} aria-hidden="true" />
      </div>
      {open && (
        <div className="security-dropdown">
          <div className="security-hint">
            键盘选股 · 名称 / 代码 / 拼音 · ↑↓ 选择，Enter 切换
          </div>
          <div
            role="listbox"
            id={id}
            aria-label="品种搜索结果"
            className="security-options"
          >
            {items.map((item, i) => (
              <button
                type="button"
                role="option"
                id={`${id}-${i}`}
                key={item.symbol}
                aria-selected={i === index}
                tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => select(item.symbol)}
              >
                <span>{item.name}</span>
                <small>{item.symbol.toUpperCase()}</small>
              </button>
            ))}
          </div>
          {results.isFetching && (
            <div className="security-hint" role="status">
              正在搜索…
            </div>
          )}
          {results.isError && (
            <div className="security-hint" role="alert">
              搜索失败，请重新打开重试
            </div>
          )}
          {!results.isFetching && !results.isError && !items.length && (
            <div className="security-hint">
              未找到品种，请换个关键词；首次使用请先扫描本地数据。
            </div>
          )}
        </div>
      )}
    </div>
  );
}
