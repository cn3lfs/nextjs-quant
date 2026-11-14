import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("~/components/intraday/intraday-history-panel", () => ({
  IntradayHistoryPanel: () => null,
}));
vi.mock("~/trpc/react", () => ({
  api: new Proxy(
    {},
    {
      get: (_, name: string) => {
        if (name === "useUtils") return () => ({});
        return {
          useMutation: () => ({}),
          useQuery: () =>
            name === "intradaySummary"
              ? {
                  data: {
                    config: {
                      enabled: true,
                      noon: "11:20",
                      late: "14:40",
                      rpsPeriod: 120,
                      minimumRps: 80,
                      pool: null,
                      source: "tdx-local",
                      czscConfig: 0,
                    },
                    worker: { running: false, error: null },
                    lastCheck: null,
                  },
                }
              : {},
        };
      },
    },
  ),
}));
import { capabilities } from "~/lib/common/capabilities";
import { CapabilityNotice } from "~/components/common/capability-notice";
import { IntradayControls } from "~/components/intraday/intraday-controls";
import { MonitorEditor } from "~/components/signals/monitor-editor";
import { newMonitorDraft } from "~/lib/strategy-facts/monitor-workspace-draft";
import { navItemFor } from "~/components/workbench/navigation";

it("paused navigation and notices expose the same policy while active capabilities have no pause notice", () => {
  for (const [route, id] of [
    ["/intraday", "intraday"],
    ["/signals", "signalMonitor"],
    ["/signal-ledger", "signalLedger"],
  ] as const) {
    expect(navItemFor(route)?.label).toContain("暂停");
    expect(navItemFor(route)?.subtitle).toBe(capabilities[id].reason);
    expect(
      renderToStaticMarkup(createElement(CapabilityNotice, { id })),
    ).toContain(capabilities[id].reason);
  }
  expect(
    renderToStaticMarkup(
      createElement(CapabilityNotice, { id: "formulaScreen" }),
    ),
  ).toBe("");
  expect(navItemFor("/screen")?.label).not.toContain("暂停");
});
it("intraday saved enabled=true still renders a disabled execution button and pause reason", () => {
  const html = renderToStaticMarkup(createElement(IntradayControls));
  expect(html).toContain(capabilities.intraday.reason);
  expect(html).toMatch(
    /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*检查并执行当前时段<\/button>/,
  );
  expect(html).toContain("已保存参数与批次");
  expect(html).not.toContain("已生效参数");
});
it("monitor editor saves a subscription without promising to start a paused scheduler", () => {
  const html = renderToStaticMarkup(
    createElement(MonitorEditor, {
      draft: { ...newMonitorDraft(), enabled: true },
      channels: [],
      watchlist: [],
      busy: false,
      onChange: () => {},
      onSave: () => {},
      onClose: () => {},
    }),
  );
  expect(html).toContain(capabilities.signalMonitor.reason);
  expect(html).toContain("保存订阅设置");
  expect(html).not.toContain("保存并启用");
  expect(html).toMatch(/<button[^>]*role="checkbox"[^>]*disabled=""/);
});
