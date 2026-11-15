"use client";
import { useSearchParams } from "next/navigation";
import { NewsPanel } from "./news-panel";
import { TodayIntel } from "./today-intel";

export function IntelWorkspace() {
  const search = useSearchParams();
  return search.get("tab") === "related" ? <TodayIntel all /> : <NewsPanel />;
}
