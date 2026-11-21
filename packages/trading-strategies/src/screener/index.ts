import {
  astockDragonSpecs,
  createAstockDragonFamilyScreener,
} from "./astock-dragon.js";
import {
  createGrowthOneilFamilyScreener,
  growthOneilSpecs,
} from "./growth-oneil.js";
import {
  createMomentumReversionFamilyScreener,
  momentumReversionSpecs,
} from "./momentum-reversion.js";
import { registerTheoryFamilyScreener } from "./registry.js";
import { createValueMultifactorFamilyScreener } from "./value-multifactor.js";
import {
  createTrendBreakoutFamilyScreener,
  trendBreakoutSpecs,
} from "./trend-breakout.js";
import {
  createWaveHarmonicSmcFamilyScreener,
  waveHarmonicSmcSpecs,
} from "./wave-harmonic-smc.js";
import {
  createWyckoffVolumeFamilyScreener,
  wyckoffVolumeSpecs,
} from "./wyckoff-volume.js";

export * from "./types.js";
export * from "./helpers.js";
export * from "./registry.js";
export * from "./risk-position-plan.js";
export * from "./value-multifactor.js";

export {
  astockDragonSpecs,
  createAstockDragonFamilyScreener,
  createGrowthOneilFamilyScreener,
  createMomentumReversionFamilyScreener,
  createTrendBreakoutFamilyScreener,
  createWaveHarmonicSmcFamilyScreener,
  createWyckoffVolumeFamilyScreener,
  growthOneilSpecs,
  momentumReversionSpecs,
  trendBreakoutSpecs,
  waveHarmonicSmcSpecs,
  wyckoffVolumeSpecs,
};

registerTheoryFamilyScreener(
  "trend-breakout",
  createTrendBreakoutFamilyScreener,
);
registerTheoryFamilyScreener("growth-oneil", createGrowthOneilFamilyScreener);
registerTheoryFamilyScreener(
  "wyckoff-volume",
  createWyckoffVolumeFamilyScreener,
);
registerTheoryFamilyScreener("astock-dragon", createAstockDragonFamilyScreener);
registerTheoryFamilyScreener(
  "wave-harmonic-smc",
  createWaveHarmonicSmcFamilyScreener,
);
registerTheoryFamilyScreener(
  "momentum-reversion",
  createMomentumReversionFamilyScreener,
);
registerTheoryFamilyScreener(
  "value-multifactor",
  createValueMultifactorFamilyScreener,
);
