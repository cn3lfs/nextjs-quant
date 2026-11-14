import { create } from "zustand";

type ResearchSession = {
  question: string;
  method: "general" | "sepa";
  setQuestion: (question: string) => void;
  setMethod: (method: ResearchSession["method"]) => void;
};

// Only the research form subscribes. Keep its draft through panel eviction;
// the selected snapshot and server reports remain outside this session store.
export const useResearchSession = create<ResearchSession>((set) => ({
  question: "分析当前趋势、反向证据和需要注意的风险",
  method: "general",
  setQuestion: (question) => set({ question }),
  setMethod: (method) => set({ method }),
}));
