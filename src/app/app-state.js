import { DEFAULT_PROJECT_INPUT, STAGE_ORDER } from "../config/system-config.js";

function buildStageState(key, index) {
  return {
    key,
    index,
    status: index === 0 ? "ready" : "locked",
    result: null,
    error: null
  };
}

export function createInitialState() {
  return {
    input: structuredClone(DEFAULT_PROJECT_INPUT),
    activeStage: "m1",
    workerStatus: "idle",
    stages: Object.fromEntries(
      STAGE_ORDER.map((key, index) => [key, buildStageState(key, index)])
    )
  };
}

export function cloneState(state) {
  return structuredClone(state);
}
