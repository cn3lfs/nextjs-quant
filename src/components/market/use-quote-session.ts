"use client";
import { useEffect, useState } from "react";
import {
  quoteRefreshInterval,
  quoteSession,
  type QuoteSession,
} from "~/lib/market/tdx-quote-view";

/** 时段只驱动刷新节奏，所以在客户端定时重算即可，不在服务端渲染时判定。 */
export function useQuoteSession() {
  const [session, setSession] = useState<QuoteSession | null>(null);
  useEffect(() => {
    const update = () => setSession(quoteSession(Date.now()));
    update();
    const timer = setInterval(update, 30000);
    return () => clearInterval(timer);
  }, []);
  return session;
}

/** Auto-refresh interval for the current session (false = manual only). */
export function useQuoteRefreshInterval() {
  const session = useQuoteSession();
  return session === null ? false : (quoteRefreshInterval(session) ?? false);
}
