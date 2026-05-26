import assert from "node:assert/strict";

import { runM1Plan } from "../src/worker/m1-engine.js";
import { runM2ScenarioCompare } from "../src/worker/m2-engine.js";
import { runM3ScenarioOptimization } from "../src/worker/m3-engine.js";
import { simulateEnergyScenario, normalizeProjectInput, buildDemandProfile, buildHardwarePlan, buildIrradianceSeries } from "../src/worker/scenario-core.js";

const gTiltData = Array.from({ length: 8760 }, (_, hour) => {
  const dayHour = hour % 24;
  return dayHour >= 7 && dayHour <= 17 ? 650 : 0;
});

const context = {
  input: {
    m1: {
      climateKey: "guangzhou",
      evCount: 100,
      teacherRatio: 0.8,
      anxietyRatio: 0.2,
      batteryCapMean: 65,
      initSocMean: 0.4,
      targetSocMean: 0.95,
      holidayRatio: 0.1,
      pvEfficiency: 0.72,
      pvPrice: 1.5,
      pvRate: 15,
      storBasePrice: 1,
      storRate: 12,
      cost7kw: 0.3,
      cost30kw: 2.5,
      roofArea: 10000,
      evRatio: 3,
      renewableTarget: 0.5
    },
    m2: {
      gTiltData,
      transformerLimitKw: 500,
      teacherRatio: 0.8,
      anxietyRatio: 0.2
    },
    m3: {
      priceShiftThreshold: 0.55,
      opexRate: 0.015
    }
  },
  previousResults: {}
};

const m1Plan = runM1Plan(context);
assert.equal(m1Plan.contract, "M1Result");
assert.equal(m1Plan.baseConfigType, "s0_offgrid_baseline");
assert.equal(typeof m1Plan.offgridBaselineCheck.unservedKwh, "number");
assert.equal(typeof m1Plan.baselineMatch.serviceRate, "number");
assert.ok(m1Plan.hardwarePlan.pvKw >= 0);

const m2Context = {
  ...context,
  previousResults: {
    m1: m1Plan
  }
};
const m2ScenarioCompare = runM2ScenarioCompare(m2Context);
assert.equal(m2ScenarioCompare.contract, "M2ScenarioCompareResult");
assert.deepEqual(
  Object.keys(m2ScenarioCompare.scenarios).sort(),
  ["grid_dispatch", "grid_rule", "offgrid_dispatch", "offgrid_rule"]
);
assert.equal(m2ScenarioCompare.scenarios.offgrid_rule.summary.gridImportKwh, 0);
assert.equal(m2ScenarioCompare.scenarios.grid_rule.summary.gridConnected, true);
assert.ok(m2ScenarioCompare.comparison);

const m3Context = {
  ...context,
  previousResults: {
    m1: m1Plan,
    m2: m2ScenarioCompare
  }
};
const m3ScenarioOptimization = runM3ScenarioOptimization(m3Context);
assert.equal(m3ScenarioOptimization.contract, "M3ScenarioOptimizationResult");
assert.equal(m3ScenarioOptimization.candidateCount, 540);
assert.deepEqual(
  Object.keys(m3ScenarioOptimization.scenarioOptimums).sort(),
  ["grid_dispatch", "grid_rule", "offgrid_dispatch", "offgrid_rule"]
);
assert.ok(m3ScenarioOptimization.scenarioOptimums.offgrid_rule.recommendedConfig);
assert.ok(m3ScenarioOptimization.scenarioOptimums.grid_dispatch.recommendedConfig);
assert.ok(m3ScenarioOptimization.comparison.recommendedForEngineering);
assert.equal(Object.hasOwn(m3ScenarioOptimization, "route" + "Options"), false);

const params = normalizeProjectInput(context);
const demand = buildDemandProfile(params, { days: 7, seed: 20260512 });
const hardware = buildHardwarePlan({
  pvKw: 300,
  storageKwh: 600,
  pcsKw: 150,
  n7kw: 12,
  n30kw: 4,
  transformerLimitKw: 500
});
const irradiance = buildIrradianceSeries(params, demand.loadCurve.length, { monthIndex: 0, useGTilt: false });
const offgridRun = simulateEnergyScenario({
  hardware,
  loadCurve: demand.loadCurve,
  irradiance,
  params,
  scenarioKey: "offgrid_rule"
});
assert.equal(offgridRun.summary.gridConnected, false);
assert.equal(offgridRun.summary.gridImportKwh, 0);

globalThis.self = { addEventListener() {} };
await import("../src/worker/solver.worker.js");

console.log("smoke-test ok");
