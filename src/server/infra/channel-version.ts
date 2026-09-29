import { createHash } from "node:crypto";
import type { Channel } from "~/lib/domain";

/** Opaque identity of a configured destination; credentials themselves stay in the vault. */
export function channelDestinationVersion(value: Channel) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: value.id,
        revision: value.revision ?? null,
        type: value.type,
        target: value.target ?? null,
        thread: value.thread ?? null,
        enabled: value.enabled,
        configured: value.configured,
      }),
    )
    .digest("hex");
}
