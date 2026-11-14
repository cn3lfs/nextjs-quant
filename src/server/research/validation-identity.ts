import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

declare const __RESEARCH_VALIDATION_BUILD_HASH__: string;
/** The worker embeds its identity; the Next host reads the same built runtime
 * asset. Source paths are not required in a prepared desktop distribution. */
export function validationBuildHash() {
  if (typeof __RESEARCH_VALIDATION_BUILD_HASH__ !== "undefined")
    return __RESEARCH_VALIDATION_BUILD_HASH__;
  return z
    .object({ hash: z.string().regex(/^[a-f0-9]{64}$/) })
    .parse(
      JSON.parse(
        readFileSync(
          join(
            process.env.QUANT_WORKER_DIR ?? join(process.cwd(), "runtime"),
            "research-validation-identity.json",
          ),
          "utf8",
        ),
      ),
    ).hash;
}
