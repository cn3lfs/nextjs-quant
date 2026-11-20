"use client";
import { useSearchParams } from "next/navigation";
import { NewsPanel } from "./news-panel";
import { ThsdkNewsPanel } from "./thsdk-news-panel";

export function IntelWorkspace() {
  const search = useSearchParams();
  const tab = search.get("tab");
  return tab === "thsdk" ? <ThsdkNewsPanel /> : <NewsPanel />;
}
