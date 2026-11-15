import { Suspense } from "react";
import { AccountWorkspace } from "~/components/portfolio/account-workspace";
export default function TradeLedgerPage() {
  return (
    <Suspense fallback={<p role="status">正在读取账户工作区…</p>}>
      <AccountWorkspace />
    </Suspense>
  );
}
