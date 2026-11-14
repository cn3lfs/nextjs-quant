// Only isolated worker test bundles use this policy. Production runtime builds
// always resolve the real policy; paused-workers tests exercise that policy.
export * from "../../src/lib/common/capabilities";
export function capabilityAllows() {
  return true;
}
