import { z } from "zod";
import { sqlite } from "./index";

const preferences = z
  .object({
    density: z.enum(["comfort", "compact"]),
    sidebarCollapsed: z.boolean(),
    expandedGroups: z.array(z.string().trim().min(1).max(100)).max(100),
    closeToTray: z.boolean(),
    holdingsReconciliation: z.enum([
      "upper-bound",
      "delivery-first",
      "local-first",
    ]),
    singleKeyShortcuts: z.boolean(),
  })
  .strict();
export const workspacePreferencesPatch = preferences.partial();
const flag = z
  .union([z.literal(0), z.literal(1)])
  .transform((value) => value === 1);
const stored = preferences.extend({
  sidebarCollapsed: flag,
  closeToTray: flag,
  singleKeyShortcuts: flag,
  expandedGroups: z
    .string()
    .transform((value) => JSON.parse(value) as unknown)
    .pipe(preferences.shape.expandedGroups),
  updatedAt: z.number().int().nonnegative(),
});
export function workspacePreferences(db = sqlite()) {
  return stored.parse(
    db
      .prepare(
        `SELECT density, sidebar_collapsed AS sidebarCollapsed,
    expanded_groups AS expandedGroups, close_to_tray AS closeToTray, holdings_reconciliation AS holdingsReconciliation,
    single_key_shortcuts AS singleKeyShortcuts, updated_at AS updatedAt FROM workspace_preferences WHERE id=1`,
      )
      .get(),
  );
}
export function saveWorkspacePreferences(
  input: z.input<typeof workspacePreferencesPatch>,
  db = sqlite(),
) {
  const changes = Object.entries(workspacePreferencesPatch.parse(input)).filter(
    ([, value]) => value !== undefined,
  );
  return db
    .transaction(() => {
      const current = workspacePreferences(db);
      if (!changes.length) return current;
      const next = {
        ...current,
        ...Object.fromEntries(changes),
      } as typeof current;
      db.prepare(
        `UPDATE workspace_preferences SET density=?,sidebar_collapsed=?,expanded_groups=?,close_to_tray=?,
      holdings_reconciliation=?,single_key_shortcuts=?,updated_at=? WHERE id=1`,
      ).run(
        next.density,
        Number(next.sidebarCollapsed),
        JSON.stringify(next.expandedGroups),
        Number(next.closeToTray),
        next.holdingsReconciliation,
        Number(next.singleKeyShortcuts),
        Date.now(),
      );
      return workspacePreferences(db);
    })
    .immediate();
}
