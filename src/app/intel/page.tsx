import { IntelWorkspace } from "~/components/news/intel-workspace";
import { Suspense } from "react";

export default function Page() {
  return (
    <Suspense fallback={<p role="status">正在读取情报…</p>}>
      <IntelWorkspace />
    </Suspense>
  );
}
