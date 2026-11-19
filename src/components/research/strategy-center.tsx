"use client";
import { useState } from "react";
import { Segmented } from "../panels";
import { StrategyScoreboard } from "./strategy-scoreboard";
import { api } from "~/trpc/react";
import { usePanelVisible } from "../workbench/keep-alive";
import { MethodRegistryWorkspace } from "./strategy-center/method-registry";
import { RunHistoryWorkspace } from "./strategy-center/run-history";
import { StrategyCatalogWorkspace } from "./strategy-center/strategy-catalog";

export { comparisonExportDocument } from "./strategy-center/comparison-export";

export function StrategyCenter() {
  const panelVisible = usePanelVisible();
  const catalog = api.strategyCenterCatalog.useQuery();
  const [workspace, setWorkspace] = useState<
    "catalog" | "methods" | "history" | "scoreboard"
  >("catalog");
  const [message, setMessage] = useState("");
  const history = api.strategyCenterHistory.useQuery(undefined, {
    enabled: panelVisible && workspace === "history",
    refetchInterval: panelVisible && workspace === "history" ? 3000 : false,
  });
  const entries = catalog.data ?? [];
  const strategyNames = new Map(entries.map((item) => [item.id, item.name]));
  const onRunCreated = (nextMessage: string) => {
    setMessage(nextMessage);
    setWorkspace("history");
    void history.refetch();
  };
  return (
    <div className="min-w-0 space-y-5">
      <Segmented
        label="策略中心工作区"
        value={workspace}
        onChange={setWorkspace}
        options={[
          { value: "catalog", label: "策略目录" },
          { value: "methods", label: "方法登记" },
          { value: "history", label: "运行与比较" },
          { value: "scoreboard", label: "研究成绩单" },
        ]}
      />
      {message && <p role="status">{message}</p>}
      {workspace === "scoreboard" && (
        <StrategyScoreboard enabled={panelVisible} />
      )}
      <div hidden={workspace !== "catalog"} className="space-y-5">
        <StrategyCatalogWorkspace
          panelVisible={panelVisible}
          catalog={catalog}
          onMessage={setMessage}
          onRunCreated={onRunCreated}
        />
      </div>
      <div hidden={workspace !== "methods"}>
        <MethodRegistryWorkspace
          panelVisible={panelVisible}
          active={workspace === "methods"}
        />
      </div>
      <div hidden={workspace !== "history"} className="space-y-5">
        <RunHistoryWorkspace
          panelVisible={panelVisible}
          active={workspace === "history"}
          history={history}
          strategyNames={strategyNames}
          onMessage={setMessage}
        />
      </div>
    </div>
  );
}
