import { Suspense } from "react";
import { TodayOverview } from "~/components/overview/today-overview";

export default function Home() {
  return (
    <Suspense fallback={<p role="status">正在读取今日总览…</p>}>
      <TodayOverview />
    </Suspense>
  );
}
