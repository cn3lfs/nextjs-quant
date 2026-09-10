import "~/styles/globals.css";
import { WorkbenchLayout } from "~/components/workbench-layout";
import type { Metadata } from "next";
import { TRPCReactProvider } from "~/trpc/react";
export const metadata: Metadata = {
  title: "观澜 · 量化研究工作台",
  description: "本地行情、策略研究与信号通知",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>
        <TRPCReactProvider>
          <WorkbenchLayout>{children}</WorkbenchLayout>
        </TRPCReactProvider>
      </body>
    </html>
  );
}
