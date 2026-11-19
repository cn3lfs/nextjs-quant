"use client";
import { useSearchParams } from "next/navigation";
import { NewsPanel } from "./news-panel";
import { ThsdkNewsPanel } from "./thsdk-news-panel";
import { TodayIntel } from "./today-intel";

export function IntelWorkspace() {
  const search = useSearchParams();
  const tab = search.get("tab");
  if (tab === "thsdk") return <ThsdkNewsPanel />;
  return tab === "related" ? <TodayIntel all /> : <NewsPanel />;
}
