import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import {
  marketSourceLabels,
  marketSourceSchema,
  type MarketSource,
} from "~/lib/market-source";

export function MarketSourceSelect({
  value,
  onChange,
  disabled = false,
}: {
  value: MarketSource;
  onChange: (value: MarketSource) => void;
  disabled?: boolean;
}) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => onChange(marketSourceSchema.parse(next))}
    >
      <SelectTrigger aria-label="行情数据源" className="w-auto min-w-48">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {marketSourceSchema.options.map((source) => (
          <SelectItem key={source} value={source}>
            {marketSourceLabels[source]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
