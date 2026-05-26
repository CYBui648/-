import { runM1Plan } from "./m1-engine.js";
import { runM2ScenarioCompare, runM2StressTest } from "./m2-engine.js";
import {
  runM3DispatchDiagnosis,
  runM3ScenarioOptimization
} from "./m3-engine.js";

const handlers = {
  M1_PLAN: runM1Plan,
  M2_SCENARIO_COMPARE: runM2ScenarioCompare,
  M2_STRESS_TEST: runM2StressTest,
  M3_SCENARIO_OPTIMIZATION: runM3ScenarioOptimization,
  M3_CONFIG_OPTIMIZATION: runM3ScenarioOptimization,
  M3_DISPATCH_DIAGNOSIS: runM3DispatchDiagnosis
};

self.addEventListener("message", async (event) => {
  const { requestId, type, payload } = event.data || {};

  try {
    const handler = handlers[type];
    if (!handler) {
      throw new Error(`未知 Worker 任务类型：${type}`);
    }

    const result = await handler(payload);
    self.postMessage({ requestId, ok: true, result });
  } catch (error) {
    self.postMessage({
      requestId,
      ok: false,
      error: error.message || "Worker 执行失败"
    });
  }
});
