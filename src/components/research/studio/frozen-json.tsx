import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";

export function FrozenJson({ value }: { value: unknown }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          查看冻结 JSON
        </Button>
      </DialogTrigger>
      <DialogContent className="top-0 right-0 left-auto h-dvh w-full max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-none sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>冻结 JSON</DialogTitle>
          <DialogDescription>
            当前表单的回测输入预览。提交时由服务端校验并冻结。
          </DialogDescription>
        </DialogHeader>
        <pre
          tabIndex={0}
          aria-label="只读冻结 JSON"
          className="min-w-0 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-nc-border-soft bg-nc-inset p-3 font-mono text-xs"
        >
          {JSON.stringify(value, null, 2)}
        </pre>
      </DialogContent>
    </Dialog>
  );
}
