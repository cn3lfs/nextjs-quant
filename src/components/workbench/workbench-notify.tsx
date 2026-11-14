"use client";
import { createContext, useContext } from "react";

const NotifyContext = createContext<(text: string) => void>(() => {});
export const WorkbenchNotifyProvider = NotifyContext.Provider;
export function useWorkbenchNotify() {
  return useContext(NotifyContext);
}
