import { parentPort, workerData } from "node:worker_threads";
import {
  calculateDiscipline,
  type DisciplineSource,
} from "./discipline-source";
void calculateDiscipline(workerData as DisciplineSource, (phase) =>
  parentPort!.postMessage({ type: "progress", phase }),
)
  .then((value) => parentPort!.postMessage({ type: "complete", value }))
  .catch((error) =>
    parentPort!.postMessage({
      type: "failed",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
