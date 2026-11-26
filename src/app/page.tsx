import { Suspense } from "react";
import { TodayWorkspace } from "~/components/overview/today-workspace";

export default function Home() {
  return (
    <Suspense fallback={<p role="status">正在读取今日交易…</p>}>
      <TodayWorkspace />
    </Suspense>
  );
}
