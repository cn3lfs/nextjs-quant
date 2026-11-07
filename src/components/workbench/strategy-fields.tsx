import { Input } from "~/components/ui/input";
import { type Strategy } from "~/lib/domain";

import { Field } from "./shared";

export function StrategyFields({
  strategy,
  setStrategy,
}: {
  strategy: Strategy;
  setStrategy: (value: Strategy) => void;
}) {
  return (
    <div className="form-grid" aria-label="已弃用的历史策略参数">
      <p className="text-sm text-muted-foreground">
        历史策略已弃用，仅供核对旧配置；新研究请使用回测页的双均线基线。
      </p>
      <Field label="短均线">
        <Input
          type="number"
          value={strategy.fast}
          onChange={(e) =>
            setStrategy({
              ...strategy,
              type: undefined,
              fast: Number(e.target.value),
            })
          }
        />
      </Field>
      <Field label="长均线">
        <Input
          type="number"
          value={strategy.slow}
          onChange={(e) =>
            setStrategy({
              ...strategy,
              type: undefined,
              slow: Number(e.target.value),
            })
          }
        />
      </Field>
      <Field label="最低涨幅 %">
        <Input
          type="number"
          value={strategy.minChange}
          onChange={(e) =>
            setStrategy({
              ...strategy,
              type: undefined,
              minChange: Number(e.target.value),
            })
          }
        />
      </Field>
      <Field label="最高涨幅 %">
        <Input
          type="number"
          value={strategy.maxChange}
          onChange={(e) =>
            setStrategy({
              ...strategy,
              type: undefined,
              maxChange: Number(e.target.value),
            })
          }
        />
      </Field>
      <Field label="最低量比">
        <Input
          type="number"
          step="0.1"
          value={strategy.minVolumeRatio}
          onChange={(e) =>
            setStrategy({
              ...strategy,
              type: undefined,
              minVolumeRatio: Number(e.target.value),
            })
          }
        />
      </Field>
    </div>
  );
}
