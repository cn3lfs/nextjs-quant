"use client";
import { useEffect, useState } from "react";

/**
 * Wall clock for session labels. Null until mounted so server and client
 * markup agree; ticks every `interval` milliseconds afterwards.
 */
export function useNow(interval = 30000) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}
