"use client";
import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { cryptoSymbol, isCryptoSymbol } from "~/lib/market/crypto";
import { isFuturesSymbol } from "~/lib/market/futures";

type Market = "crypto" | "futures";
function routeSymbol(search: URLSearchParams, market: Market) {
  if (market === "crypto") {
    const raw = (
      search.get("pair") ??
      search.get("symbol") ??
      ""
    ).toUpperCase();
    const symbol = cryptoSymbol(raw.replace(/^CX/, ""));
    return isCryptoSymbol(symbol) ? symbol : "cxBTCUSDT";
  }
  const symbol = `fu${(search.get("code") ?? "").toUpperCase()}`;
  return isFuturesSymbol(symbol) ? symbol : "fuGC00Y";
}

/** Picker actions own their existing load; URL changes reconcile external navigation. */
export function useForeignChartSymbol(
  market: Market,
  load: (symbol: string) => void,
) {
  const search = useSearchParams();
  const pathname = usePathname();
  const active = pathname === "/scan" && search.get("tab") === market;
  const requested = routeSymbol(new URLSearchParams(search.toString()), market);
  const [symbol, setSymbol] = useState(requested);
  const applied = useRef<string | null>(null);
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    if (!active || applied.current === requested) return;
    // A preceding native-history update may still be committing in Next.
    // Reconcile only the URL that is currently in the address bar.
    if (typeof window !== "undefined") {
      const current = new URLSearchParams(window.location.search);
      if (
        window.location.pathname !== "/scan" ||
        current.get("tab") !== market ||
        routeSymbol(current, market) !== requested
      )
        return;
    }
    applied.current = requested;
    setSymbol(requested);
    loader.current(requested);
  }, [active, requested, market]);

  function selectSymbol(next: string) {
    applied.current = next;
    setSymbol(next);
    // Keep the scan's filters/candidate and hash, and never rewrite another page.
    if (typeof window === "undefined" || window.location.pathname !== "/scan")
      return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("tab") !== market) return;
    url.searchParams.set(market === "crypto" ? "pair" : "code", next.slice(2));
    const href = `${url.pathname}${url.search}${url.hash}`;
    if (
      href !==
      `${window.location.pathname}${window.location.search}${window.location.hash}`
    )
      window.history.replaceState(null, "", href);
  }
  return { symbol, selectSymbol };
}
