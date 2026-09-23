"use client";
import { Circle, MagnifyingGlass } from "@phosphor-icons/react/ssr";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { marketSession } from "~/lib/market/market-session";
import { cn } from "~/lib/common/classnames";
import { Input } from "../ui/input";
import { searchNav } from "./navigation";
import { useNow } from "./use-now";

export function Topbar({
  crumb,
  title,
  subtitle,
  children,
}: {
  crumb: string;
  title: string;
  subtitle?: string;
  children?: ReactNode;
}) {
  return (
    <header className="topbar">
      <span className="breadcrumb">{crumb}</span>
      <div className="topbar-title">
        <h1>{title}</h1>
        {subtitle && <p title={subtitle}>{subtitle}</p>}
      </div>
      <div className="top-status">
        {children}
        <NavSearch />
        <SessionPill />
      </div>
    </header>
  );
}

/** Current A-share session; weekends count as closed without a calendar. */
export function SessionPill() {
  const now = useNow();
  if (now === null) return <span className="session-pill idle">—</span>;
  const session = marketSession(now);
  const live = ["auction", "morning", "afternoon"].includes(session.kind);
  return (
    <span className={cn("session-pill", !live && "idle")}>
      <Circle size={7} weight="fill" />
      {session.label} · {session.hhmm}
    </span>
  );
}

/** Page search: Ctrl K focuses, arrows choose, Enter opens. */
export function NavSearch() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const results = searchNav(query);
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
  const open = (href: string) => {
    setQuery("");
    input.current?.blur();
    router.push(href, { scroll: false });
  };
  return (
    <div className="nav-search">
      <MagnifyingGlass size={13} />
      <Input
        ref={input}
        className="h-7 w-[200px] pr-12 pl-7 text-xs md:text-xs"
        aria-label="搜索页面"
        placeholder="搜索页面"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setCursor(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown")
            setCursor((c) => Math.min(c + 1, results.length - 1));
          else if (event.key === "ArrowUp")
            setCursor((c) => Math.max(c - 1, 0));
          else if (event.key === "Enter" && results[cursor])
            open(results[cursor].href);
          else if (event.key === "Escape") setQuery("");
          else return;
          event.preventDefault();
        }}
      />
      <kbd>Ctrl K</kbd>
      {results.length > 0 && (
        <ul role="listbox" aria-label="页面">
          {results.map((item, index) => (
            <li key={item.href}>
              <Link
                href={item.href}
                scroll={false}
                role="option"
                aria-selected={index === cursor}
                onClick={() => setQuery("")}
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
