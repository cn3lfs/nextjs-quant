import "~/styles/globals.css";
import { WorkbenchLayout } from "~/components/workbench/workbench-layout";
import type { Metadata } from "next";
import { connection } from "next/server";
import { TRPCReactProvider } from "~/trpc/react";
import { TableSortProvider } from "~/components/common/table-sort-provider";
import { acceptanceEnvironment } from "~/lib/common/acceptance-environment";
export const metadata: Metadata = {
  title: "观澜 · 量化研究工作台",
  description: "本地行情、策略研究与信号通知",
};
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Read the server's runtime profile, never freeze it into a normal build.
  await connection();
  const testEnvironment = acceptanceEnvironment(
    process.env.E2E_FIXTURE_PROFILE,
  );
  return (
    <html lang="zh-CN">
      <body>
        {testEnvironment && (
          <p
            role="note"
            className="sticky top-0 z-50 m-0 border-b border-amber-400 bg-amber-50 px-3 py-2 text-center text-xs font-semibold text-amber-900"
          >
            {testEnvironment}
          </p>
        )}
        <TRPCReactProvider>
          <WorkbenchLayout>{children}</WorkbenchLayout>
          <TableSortProvider />
        </TRPCReactProvider>
      </body>
    </html>
  );
}
