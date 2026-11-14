import { capabilities, type CapabilityId } from "~/lib/common/capabilities";

export function CapabilityNotice({ id }: { id: CapabilityId }) {
  const capability = capabilities[id];
  if (capability.state === "active") return null;
  return (
    <p
      role="status"
      className="nc-span-12 m-0 rounded-lg border border-nc-border p-3 text-sm text-nc-text-2"
    >
      {capability.reason}
    </p>
  );
}
