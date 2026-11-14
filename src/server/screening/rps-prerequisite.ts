import type { RpsPrerequisite } from "~/lib/screening/rps-prerequisite";

/** Expected missing inputs end this attempt; they do not hold the worker lease. */
export class RpsPrerequisiteError extends Error {
  readonly reason: RpsPrerequisite;

  constructor(code: RpsPrerequisite["code"], message: string) {
    super(message);
    this.name = "RpsPrerequisiteError";
    this.reason = { code, message };
  }
}
