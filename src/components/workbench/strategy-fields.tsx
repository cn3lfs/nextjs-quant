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
    <div className="form-grid">
      <Field label="短均线">
        <input
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
        <input
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
        <input
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
        <input
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
        <input
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
