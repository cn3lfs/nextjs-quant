import { alertKindLabels, type AlertEvent } from "./alerts";

export function alertReference(
  event: AlertEvent,
  strategyName = event.strategyId,
) {
  return {
    key: event.key,
    label: `${strategyName} · ${event.symbol} · ${event.bar} · ${alertKindLabels[event.type]}`,
    href: `/accounts/alerts?event=${encodeURIComponent(event.key)}`,
  };
}
