import { usePathname, useRouter } from "next/navigation";
import { useCallback, useState, type SetStateAction } from "react";
import { navItemFor, tabHref, type Tab } from "./navigation";

/** Shell-only navigation and toast state; domain pages subscribe themselves. */
export function useWorkbenchState() {
  const pathname = usePathname();
  const router = useRouter();
  const tab = navItemFor(pathname)?.tab ?? "market";
  const setTab = (next: SetStateAction<Tab>) =>
    router.push(tabHref(typeof next === "function" ? next(tab) : next), {
      scroll: false,
    });
  const [toast, setToast] = useState("");
  const notify = useCallback((text: string) => {
    setToast(text);
    setTimeout(() => setToast(""), 7000);
  }, []);
  return { setTab, notify, tab, toast, setToast };
}
export type WorkbenchState = ReturnType<typeof useWorkbenchState>;
