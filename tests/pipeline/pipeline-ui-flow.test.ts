import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "@playwright/test";
import { build } from "esbuild";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { RouterInputs, RouterOutputs } from "~/trpc/react";

const decisionDate = "2026-11-24";
const executeDate = "2026-11-25";
const deploymentId = "deployment-fixture";
const simAccountId = "sim-account-fixture";
const deployment = {
  id: deploymentId,
  name: "双突破监控策略",
  market: "cn-equity",
  status: "active",
  executionMode: "shadow",
  strategySpec: { kind: "double-breakout" },
  venueBinding: { kind: "local_sim", simAccountId },
  latestRun: null,
} satisfies Partial<RouterOutputs["deploymentList"]["items"][number]>;

type PoolEntry = RouterOutputs["deploymentPoolList"]["items"][number];
const screenedEntry = {
  id: "screened-entry",
  symbol: "sh600000",
  enteredDate: "2026-11-23",
  entryReason: "放量突破选股命中",
  source: "screener",
  status: "watching",
  consecutiveMissedDays: 0,
  lastSignalDate: decisionDate,
  lastSignalAction: "BUY",
  evictedDate: null,
  evictReason: null,
} satisfies Pick<
  PoolEntry,
  | "id"
  | "symbol"
  | "enteredDate"
  | "entryReason"
  | "source"
  | "status"
  | "consecutiveMissedDays"
  | "lastSignalDate"
  | "lastSignalAction"
  | "evictedDate"
  | "evictReason"
>;

type MutationName =
  | "pipelineSetGlobalAutoSim"
  | "pipelineSetGlobalAutoLive"
  | "deploymentPoolAdd"
  | "deploymentPoolEvict"
  | "pipelineRunStep"
  | "deploymentCreate";
type MutationCall = {
  [Name in MutationName]: [name: Name, input: RouterInputs[Name]];
}[MutationName];

function createRpcFixture(liveEnabled: boolean) {
  let config: RouterOutputs["pipelineGlobalConfig"] = {
    autoSimEnabled: false,
    autoLiveEnabled: liveEnabled,
    updatedAt: null,
  };
  const pool: Pick<PoolEntry, keyof typeof screenedEntry>[] = [screenedEntry];
  const query = (name: string, input?: RouterInputs["deploymentPoolList"]) => {
    switch (name) {
      case "pipelineGlobalConfig":
        return config;
      case "deploymentList":
        return {
          items: [
            {
              ...deployment,
              activePoolCount: pool.filter(
                ({ status }) => status === "watching",
              ).length,
            },
          ],
          nextCursor: null,
        };
      case "deploymentPoolList":
        return {
          items: pool.filter(({ status }) => status === input?.status),
          nextCursor: null,
        };
      case "simAccountsList":
        return [
          {
            id: simAccountId,
            name: "A股默认模拟账户",
            status: "active",
            market: "cn-equity",
          },
        ];
      default:
        throw new Error(`意外查询 ${name}`);
    }
  };

  const mutate = vi.fn((...call: MutationCall) => {
    const [name, input] = call;
    switch (name) {
      case "pipelineSetGlobalAutoSim":
        config = { ...config, autoSimEnabled: input.enabled };
        return config;
      case "pipelineSetGlobalAutoLive":
        config = { ...config, autoLiveEnabled: input.enabled };
        return config;
      case "deploymentPoolAdd": {
        const entry = {
          ...screenedEntry,
          id: "manual-entry",
          symbol: input.symbol,
          enteredDate: decisionDate,
          entryReason: input.reason ?? "手动加票",
          source: "manual" as const,
          lastSignalDate: null,
          lastSignalAction: null,
        };
        pool.push(entry);
        return entry;
      }
      case "deploymentPoolEvict": {
        const entry = pool.find(({ symbol }) => symbol === input.symbol);
        if (!entry) throw new Error(`池内没有 ${input.symbol}`);
        entry.status = "evicted";
        entry.evictedDate = decisionDate;
        entry.evictReason = "手动移出";
        return entry;
      }
      case "pipelineRunStep":
        return { run: { stage: "completed" }, intents: [] };
      case "deploymentCreate":
        return { id: "created-deployment", name: input.name };
      default:
        throw new Error(`意外写入 ${name}`);
    }
  });
  return { query, mutate };
}

// Bundle the real components with local RPC fixtures and the test page's search params.
const offlineTrpc = `
  import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";

  const query = (name) => ({
    useQuery: (input, options) => useQuery({
      ...options,
      queryKey: [name, input],
      queryFn: () => window.pipelineQuery(name, input),
    }),
  });
  const pages = (name) => ({
    useInfiniteQuery: (input, options) => useInfiniteQuery({
      ...options,
      queryKey: [name, input],
      initialPageParam: undefined,
      queryFn: () => window.pipelineQuery(name, input),
    }),
  });
  const mutation = (name) => ({
    useMutation: (options) => useMutation({
      ...options,
      mutationFn: (input) => window.pipelineMutate(name, input),
    }),
  });

  export const api = {
    useQueries: (select) => useQueries({
      queries: select({
        pipelineRunDetail: (input, options) => ({
          ...options,
          queryKey: ["pipelineRunDetail", input],
          queryFn: () => window.pipelineQuery("pipelineRunDetail", input),
        }),
      }),
    }),
    pipelineGlobalConfig: query("pipelineGlobalConfig"),
    deploymentList: pages("deploymentList"),
    deploymentGet: query("deploymentGet"),
    deploymentPoolList: pages("deploymentPoolList"),
    simAccountsList: query("simAccountsList"),
    pipelineSetGlobalAutoSim: mutation("pipelineSetGlobalAutoSim"),
    pipelineSetGlobalAutoLive: mutation("pipelineSetGlobalAutoLive"),
    deploymentUpdateMode: mutation("deploymentUpdateMode"),
    deploymentPoolAdd: mutation("deploymentPoolAdd"),
    deploymentPoolEvict: mutation("deploymentPoolEvict"),
    pipelineRunStep: mutation("pipelineRunStep"),
    deploymentCreate: mutation("deploymentCreate"),
    useUtils() {
      const client = useQueryClient();
      const utils = (name) => ({
        invalidate: () => client.invalidateQueries({ queryKey: [name] }),
        setData: (input, update) => client.setQueryData([name, input], update),
      });
      return {
        pipelineGlobalConfig: utils("pipelineGlobalConfig"),
        deploymentList: utils("deploymentList"),
        deploymentGet: utils("deploymentGet"),
        deploymentPoolList: utils("deploymentPoolList"),
        pipelineRunDetail: utils("pipelineRunDetail"),
      };
    },
  };
`;

let browser: Browser;
let bundle: string;
let page: Page | undefined;
const requests: string[] = [];
const pageErrors: string[] = [];

beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
        import { PipelineConsole } from "~/components/pipeline/pipeline-console";
        import { DeployStrategyDialog } from "~/components/pipeline/deploy-strategy-dialog";

        const client = new QueryClient({ defaultOptions: {
          queries: { retry: false, networkMode: "always" },
          mutations: { retry: false, networkMode: "always" },
        } });
        const frozenPreset = {
          name: "冻结公式部署",
          strategySpec: { kind: "formula", name: "frozen-formula", source: "XG:C>O;", parameters: { N: 5 } },
          universeSpec: { kind: "fixed-symbols", symbols: ["sh600000"] },
          riskPolicy: { maxSymbolWeight: 0.1 },
          provenance: {
            sourceKind: "lab-backtest",
            sourceRefId: "archive-fixture",
            buildHash: "build-fixture",
            note: '{"snapshotId":"snapshot-fixture"}',
          },
        };
        function Wizard({ frozen }) {
          const [open, setOpen] = useState(true);
          return <DeployStrategyDialog open={open} onOpenChange={setOpen} defaultPreset={frozen ? frozenPreset : undefined} />;
        }
        const root = document.getElementById("root");
        createRoot(root).render(
          <QueryClientProvider client={client}>
            {root.dataset.view === "console" ? <PipelineConsole /> : <Wizard frozen={root.dataset.view === "frozen"} />}
          </QueryClientProvider>
        );
      `,
      loader: "tsx",
      resolveDir: process.cwd(),
    },
    alias: { "~": "./src" },
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    plugins: [
      {
        name: "pipeline-offline-trpc",
        setup(builder) {
          builder.onResolve({ filter: /^next\/navigation$/ }, () => ({
            path: "navigation",
            namespace: "pipeline-fixture",
          }));
          builder.onLoad(
            { filter: /^navigation$/, namespace: "pipeline-fixture" },
            () => ({
              contents:
                "export const useSearchParams = () => new URLSearchParams(window.location.search);",
            }),
          );
          builder.onResolve({ filter: /^~\/trpc\/react$/ }, () => ({
            path: "trpc",
            namespace: "pipeline-fixture",
          }));
          builder.onLoad(
            { filter: /^trpc$/, namespace: "pipeline-fixture" },
            () => ({
              contents: offlineTrpc,
              resolveDir: process.cwd(),
            }),
          );
        },
      },
    ],
  });
  bundle = result.outputFiles[0]!.text;
  const executablePath = chromium.executablePath();
  browser = await chromium.launch(
    existsSync(executablePath) ? { executablePath } : { channel: "msedge" },
  );
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

afterEach(async () => {
  await page?.context().close();
  page = undefined;
  expect(requests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

async function renderPipeline(
  view: "console" | "wizard" | "frozen",
  liveEnabled = false,
) {
  const rpc = createRpcFixture(liveEnabled);
  requests.length = 0;
  pageErrors.length = 0;
  const context = await browser.newContext({
    offline: true,
    serviceWorkers: "block",
  });
  page = await context.newPage();
  page.setDefaultTimeout(5_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await context.route("**/*", (route) => {
    requests.push(route.request().url());
    return route.abort();
  });
  await page.exposeFunction("pipelineQuery", rpc.query);
  await page.exposeFunction("pipelineMutate", rpc.mutate);
  await page.setContent(
    `<!doctype html><meta charset="utf-8"><div id="root" data-view="${view}"></div>`,
  );
  await page.addScriptTag({ content: bundle });
  return { page, mutate: rpc.mutate };
}

describe("策略运行台的全局执行开关", () => {
  it("默认关闭模拟盘和实盘，开启模拟盘时实盘仍关闭", async () => {
    const { page, mutate } = await renderPipeline("console");
    const sim = page.getByRole("button", { name: "开启自动模拟", exact: true });
    const live = page.getByRole("button", {
      name: "开启实盘自动",
      exact: true,
    });
    await page.getByText("已关闭", { exact: true }).nth(1).waitFor();
    expect(
      await sim.locator("..").getByText("已关闭", { exact: true }).isVisible(),
    ).toBe(true);
    expect(
      await live.locator("..").getByText("已关闭", { exact: true }).isVisible(),
    ).toBe(true);
    expect(mutate).not.toHaveBeenCalled();

    await sim.click();
    await page.getByText("模拟盘自动下单已开启。", { exact: true }).waitFor();
    expect(mutate).toHaveBeenCalledExactlyOnceWith("pipelineSetGlobalAutoSim", {
      enabled: true,
    });
    expect(
      await live.locator("..").getByText("已关闭", { exact: true }).isVisible(),
    ).toBe(true);
  });

  it("拒绝错误实盘短语，只有输入完整确认短语才发出开启请求", async () => {
    const { page, mutate } = await renderPipeline("console");
    await page
      .getByRole("button", { name: "开启实盘自动", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "开启实盘自动下单" });
    const phrase = dialog.getByLabel("实盘确认短语", { exact: true });
    const confirm = dialog.getByRole("button", {
      name: "确认开启实盘自动",
      exact: true,
    });
    await phrase.fill("ENABLE_LIVE_TRADIN");
    expect(await confirm.isDisabled()).toBe(true);
    await confirm.evaluate((button) => (button as HTMLButtonElement).click());
    expect(mutate).not.toHaveBeenCalled();

    await phrase.fill("ENABLE_LIVE_TRADING");
    await confirm.click();
    await dialog.waitFor({ state: "hidden" });
    await page
      .getByRole("button", { name: "一键急停实盘", exact: true })
      .waitFor();
    expect(mutate).toHaveBeenCalledExactlyOnceWith(
      "pipelineSetGlobalAutoLive",
      {
        enabled: true,
        confirmationPhrase: "ENABLE_LIVE_TRADING",
      },
    );
  });

  it("从已开启状态一键急停实盘，无需确认短语", async () => {
    const { page, mutate } = await renderPipeline("console", true);
    await page
      .getByRole("button", { name: "一键急停实盘", exact: true })
      .click();
    await page.getByText("实盘自动下单已关闭。", { exact: true }).waitFor();
    expect(await page.getByRole("dialog").count()).toBe(0);
    expect(mutate).toHaveBeenCalledExactlyOnceWith(
      "pipelineSetGlobalAutoLive",
      { enabled: false },
    );
  });
});

describe("部署卡片的持续监控池", () => {
  it("展示在监数量、入池原因和最近信号，支持加票与移出", async () => {
    const { page, mutate } = await renderPipeline("console");
    await page.getByText("监控池 1 只", { exact: true }).waitFor();
    await page.getByRole("button", { name: "展开详情", exact: true }).click();
    await page.getByText("在监 1 只", { exact: true }).waitFor();
    const screened = page.getByRole("listitem").filter({ hasText: "sh600000" });
    await screened.getByText("放量突破选股命中", { exact: true }).waitFor();
    await screened
      .getByText("信号 2026-11-24 · 买入", { exact: true })
      .waitFor();

    await page.getByLabel("手动加票代码", { exact: true }).fill(" sz000001 ");
    await page.getByLabel("入池原因", { exact: true }).fill(" 观察回踩支撑 ");
    await page.getByRole("button", { name: "加票入池", exact: true }).click();
    const added = page.getByRole("listitem").filter({ hasText: "sz000001" });
    await added.getByText("观察回踩支撑", { exact: true }).waitFor();
    await page.getByText("在监 2 只", { exact: true }).waitFor();
    expect(mutate).toHaveBeenCalledExactlyOnceWith("deploymentPoolAdd", {
      deploymentId,
      symbol: "sz000001",
      reason: "观察回踩支撑",
    });

    await added
      .getByRole("button", { name: "移出监控池", exact: true })
      .click();
    await added.waitFor({ state: "hidden" });
    await page.getByText("在监 1 只", { exact: true }).waitFor();
    await page.getByRole("radio", { name: "已移出", exact: true }).click();
    await added
      .getByText("移出 2026-11-24 · 手动移出", { exact: true })
      .waitFor();
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(mutate).toHaveBeenLastCalledWith("deploymentPoolEvict", {
      deploymentId,
      symbol: "sz000001",
    });
  });

  it.each([
    ["同步监控池", "universe"],
    ["生成信号", "signals"],
    ["一键跑完", "full"],
  ] as const)("%s 使用指定部署和规划日期发起 %s", async (action, stage) => {
    const { page, mutate } = await renderPipeline("console");
    await page.getByRole("button", { name: "展开详情", exact: true }).click();
    await page.getByText("单步规划日期", { exact: true }).click();
    await page.getByLabel("决策日", { exact: true }).fill(decisionDate);
    await page.getByLabel("计划执行日", { exact: true }).fill(executeDate);
    await page.getByRole("button", { name: action, exact: true }).click();
    await page
      .getByText("运行状态：已完成，订单意图 0 笔。", { exact: true })
      .waitFor();
    expect(mutate).toHaveBeenCalledExactlyOnceWith("pipelineRunStep", {
      deploymentId,
      decisionDate,
      executeDate,
      stage,
    });
  });
});

describe("一键部署向导", () => {
  it.each([false, true])(
    "冻结预设修改后提交清理绑定=%s，恢复原值保留绑定",
    async (modified) => {
      const { page, mutate } = await renderPipeline("frozen");
      const dialog = page.getByRole("dialog", { name: "部署到策略运行台" });
      const warning = dialog.getByText(
        "已修改预设参数，本次部署不再绑定原冻结回测",
      );
      const formula = dialog.getByLabel("公式源码", { exact: true });
      const symbols = dialog.getByLabel("固定标的代码", { exact: true });
      const cap = dialog.getByLabel("单票上限（%）", { exact: true });
      await formula.fill("XG:C<O;");
      await warning.waitFor();
      await formula.fill("XG:C>O;");
      await warning.waitFor({ state: "hidden" });
      await symbols.fill("sh600001");
      await warning.waitFor();
      await symbols.fill("sh600000");
      await warning.waitFor({ state: "hidden" });
      await cap.fill("9");
      await warning.waitFor();
      if (!modified) {
        await cap.fill("10");
        await warning.waitFor({ state: "hidden" });
      }
      await dialog
        .getByRole("button", { name: "创建部署", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      expect(mutate).toHaveBeenCalledExactlyOnceWith(
        "deploymentCreate",
        expect.objectContaining({
          provenance: expect.objectContaining(
            modified
              ? {
                  sourceKind: "manual",
                  sourceRefId: null,
                  buildHash: null,
                  note: JSON.stringify({
                    modifiedFromFrozen: true,
                    derivedFromArchiveId: "archive-fixture",
                  }),
                }
              : {
                  sourceKind: "lab-backtest",
                  sourceRefId: "archive-fixture",
                  buildHash: "build-fixture",
                  note: '{"snapshotId":"snapshot-fixture"}',
                },
          ),
        }),
      );
    },
  );

  it.each(["sim", "live"] as const)(
    "配置持续监控池后以 %s 通道创建影子部署",
    async (channel) => {
      const { page, mutate } = await renderPipeline("wizard");
      const dialog = page.getByRole("dialog", { name: "部署到策略运行台" });
      const poolMode = dialog.getByLabel("监控池模式", { exact: true });
      await poolMode.selectOption("replace");
      await poolMode.selectOption("accumulate");
      await dialog.getByLabel("策略名称", { exact: true }).fill("持续监控策略");
      await dialog.getByLabel("连续未命中宽限天数", { exact: true }).fill("7");
      await dialog
        .getByLabel("跌破均线硬淘汰（日）", { exact: true })
        .fill("30");

      const channelType = dialog.getByLabel("通道类型", { exact: true });
      const simAccount = dialog.getByLabel("本地模拟账户", { exact: true });
      await simAccount
        .getByRole("option", { name: "A股默认模拟账户" })
        .waitFor({ state: "attached" });
      expect(await channelType.inputValue()).toBe("sim");
      expect(await simAccount.inputValue()).toBe(simAccountId);
      await channelType.selectOption("live");
      const liveAccount = dialog.getByLabel("实盘账户 ID", { exact: true });
      await liveAccount.fill("live-account-fixture");
      expect(await simAccount.count()).toBe(0);
      if (channel === "sim") {
        await channelType.selectOption("sim");
        await simAccount.waitFor();
        expect(await liveAccount.count()).toBe(0);
      }

      await dialog
        .getByRole("button", { name: "创建部署", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      const venueBinding =
        channel === "sim"
          ? { kind: "local_sim", simAccountId }
          : {
              kind: "cn_broker_live",
              broker: "qmt",
              accountId: "live-account-fixture",
            };
      expect(mutate).toHaveBeenCalledExactlyOnceWith(
        "deploymentCreate",
        expect.objectContaining({
          name: "持续监控策略",
          market: "cn-equity",
          status: "draft",
          executionMode: "shadow",
          poolPolicy: {
            mode: "accumulate",
            eviction: {
              maxConsecutiveMissedDays: 7,
              hardEvictBelowMaDays: 30,
              hardEvictMaxDrawdownPct: null,
              maxPoolSize: 50,
              maxWatchDays: null,
            },
          },
          venueBinding,
        }),
      );
    },
  );
});
