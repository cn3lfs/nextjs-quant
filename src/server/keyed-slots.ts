import { PrioritySlots } from "./priority-slots";

export function keyedSlots() {
  const entries = new Map<string, { slots: PrioritySlots; users: number }>();
  return async (keys: string[], signal?: AbortSignal) => {
    const releases: (() => void)[] = [];
    const release = () => {
      for (const done of releases.splice(0).reverse()) done();
    };
    try {
      // A stable acquisition order prevents cycles between overlapping sets.
      for (const key of [...new Set(keys)].sort()) {
        const entry = entries.get(key) ?? {
          slots: new PrioritySlots(1),
          users: 0,
        };
        entries.set(key, entry);
        entry.users++;
        const forget = () => {
          if (--entry.users === 0) entries.delete(key);
        };
        try {
          const unlock = await entry.slots.acquire(1, signal);
          releases.push(() => {
            unlock();
            forget();
          });
        } catch (error) {
          forget();
          throw error;
        }
      }
      signal?.throwIfAborted();
      return release;
    } catch (error) {
      release();
      throw error;
    }
  };
}
