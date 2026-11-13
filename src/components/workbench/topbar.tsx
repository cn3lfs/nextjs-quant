"use client";
import { MagnifyingGlass } from "@phosphor-icons/react/ssr";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { Input } from "../ui/input";
import { searchNav } from "./navigation";

export function Topbar({
  title,
}: {
  crumb: string;
  title: string;
  subtitle?: string;
}) {
  return (
    <header className="topbar">
      <div className="topbar-title">
        <h1>{title}</h1>
      </div>
      <div className="top-status">
        <NavSearch />
      </div>
    </header>
  );
}

/** Page navigation only; business searches stay in their own workspaces. */
export function NavSearch() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [opened, setOpened] = useState(false);
  const results = searchNav(query);
  const visible = opened && query.trim().length > 0;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const close = () => {
    setQuery("");
    setCursor(0);
    setOpened(false);
  };
  const open = (href: string) => {
    close();
    input.current?.blur();
    router.push(href, { scroll: false });
  };

  return (
    <div
      className="nav-search"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setOpened(false);
      }}
    >
      <MagnifyingGlass size={16} aria-hidden="true" />
      <Input
        ref={input}
        className="h-9 w-[280px] pr-14 pl-8 text-[13px]"
        role="combobox"
        aria-label="搜索页面"
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={visible}
        aria-activedescendant={
          visible && results[cursor] ? listId + "-" + cursor : undefined
        }
        placeholder="搜索页面"
        autoComplete="off"
        value={query}
        onFocus={() => setOpened(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setCursor(0);
          setOpened(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            setOpened(true);
            setCursor((value) =>
              Math.max(0, Math.min(value + 1, results.length - 1)),
            );
          } else if (event.key === "ArrowUp") {
            setCursor((value) => Math.max(value - 1, 0));
          } else if (event.key === "Enter" && results[cursor]) {
            open(results[cursor].href);
          } else if (event.key === "Escape") {
            close();
          } else return;
          event.preventDefault();
        }}
      />
      <kbd>Ctrl K</kbd>
      {visible && (
        <ul id={listId} role="listbox" aria-label="页面">
          {results.length === 0 && (
            <li role="presentation">
              <p role="status" className="nav-search-empty">
                没有匹配的页面
              </p>
            </li>
          )}
          {results.map((item, index) => (
            <li key={item.href} role="presentation">
              <Link
                id={listId + "-" + index}
                href={item.href}
                scroll={false}
                role="option"
                aria-selected={index === cursor}
                onMouseEnter={() => setCursor(index)}
                onClick={close}
              >
                {item.label}
                <small>{item.group}</small>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
