export type ResearchPositionLot = {
  date: string;
  quantity: number;
  price: number;
  cost: number;
  remainingQuantity: number;
  remainingCost: number;
};

export type ResearchPositionBook = {
  lots: ResearchPositionLot[];
  totalQuantity: number;
  totalCost: number;
  remainingQuantity: number;
  remainingCost: number;
  realizedProceeds: number;
  realizedProfit: number;
  lastDate: string | null;
};
