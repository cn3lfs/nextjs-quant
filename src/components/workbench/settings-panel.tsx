import { api } from "~/trpc/react";
import { Connections } from "./connections";
import { useTaskVisible } from "./use-task-visible";
import { Button } from "../ui/button";

export function SettingsPanel(
  props: Pick<Parameters<typeof Connections>[0], "notify">,
) {
  const visible = useTaskVisible();
  const status = api.status.useQuery(undefined, {
    enabled: visible,
    refetchInterval: visible ? 30000 : false,
    select: ({ settings, coverage }) => ({ settings, coverage }),
  });
  const channels = api.channels.useQuery(undefined, { enabled: visible });
  const utils = api.useUtils();
  const scan = api.scan.useMutation({
    onSuccess: () => {
      props.notify("开始扫描本地行情，进度显示在任务栏");
      void utils.jobs.invalidate();
      void utils.taskOverview.invalidate();
    },
    onError: (error) => props.notify(error.message),
  });
  return (
    <>
      {status.error && (
        <p role="alert">
          设置未刷新：{status.error.message}{" "}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void status.refetch()}
          >
            重试设置
          </Button>
        </p>
      )}
      {status.data ? (
        <Connections
          {...props}
          value={status.data.settings}
          coverage={status.data.coverage}
          channels={channels.data ?? []}
          onScan={() => scan.mutate()}
          scanning={scan.isPending}
        />
      ) : (
        !status.error && <p role="status">正在读取设置…</p>
      )}
    </>
  );
}
