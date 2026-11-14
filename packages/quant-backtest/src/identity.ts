declare const __MA_BASELINE_BUILD_HASH__: string;
export const engineVersion = "ts-portfolio-event-1" as const;
export const maBaselineBuildHash =
  typeof __MA_BASELINE_BUILD_HASH__ === "string"
    ? __MA_BASELINE_BUILD_HASH__
    : "source-development";
