import {
  runDiagnose as runService,
  type RunDiagnoseOptions,
} from "../../../src/server/research/diagnose/run";
import { prepareDiagnoseRequest } from "./prepare-request";

export * from "../../../src/server/research/diagnose/run";
export const runDiagnose = (options: RunDiagnoseOptions) =>
  runService(options, prepareDiagnoseRequest);
