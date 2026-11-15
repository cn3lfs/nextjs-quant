"use client";
import { createContext, useContext } from "react";
export type PlanLevels = {
  symbol: string;
  entry: number | null;
  stop: number | null;
  target: number | null;
};
const Levels = createContext<PlanLevels | null>(null);
export const PlanLevelsProvider = Levels.Provider;
export const usePlanLevels = () => useContext(Levels);
