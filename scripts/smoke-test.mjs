import assert from "node:assert/strict";

import { buildBasePayload } from "../src/worker/m4-base-payload.js";
import { diagnoseResidualRisk } from "../src/worker/m4-risk-diagnosis.js";
import { buildRecommendation, scoreScenarios } from "../src/worker/m4-recommendation.js";
import { buildScenarioPlans } from "../src/worker/m4-scenarios.js";

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
      cost30kw: 2.5
    },
    m2: {
      gTiltData,
      transformerLimitKw: 500,
      teacherRatio: 0.8,
      anxietyRatio: 0.2
    },
    m3: {
      selectedRoute: "traditional_pile",
      useV2G: true,
      priceShiftThreshold: 0.55,
      clipThreshold: 0.9,
      minClipSlackHours: 2,
      maxV2gPerEvKwh: 8,
      opexRate: 0.015,
      v2gWearCostYuanPerKwh: 0.15
    },
    m4: {
      scenarioCapexWeight: 0.18,
      scenarioRiskWeight: 0.44,
      scenarioGridWeight: 0.16,
      scenarioPvWeight: 0.1,
      scenarioLcoeWeight: 0.12
    }
  },
  previousResults: {
    m1: {
      hardwarePlan: {
        pvKw: 300,
        storageKwh: 600,
        pcsKw: 150,
        n7kw: 12,
        n30kw: 4
      },
      economics: {
        capexWan: 260
      }
    },
    m2: {
      summary: {
        monthIndex: 6,
        transformerLimitKw: 500
      },
      riskReport: {
        realPeakKw: 540
      }
    },
    m3: {
      routeOptions: {
        traditional_pile: {
          key: "traditional_pile",
          label: "传统桩站调度路线",
          result: {
            realPeakKw: 545,
            unmetTotalKwh: 180,
            queueUnmetKwh: 75,
            overflowCount: 4,
            socMinPct: 6
          },
          handoffToM4: {
            residualUnmetKwh: 180,
            residualQueueUnmetKwh: 75,
            residualOverflowCount: 4,
            residualSocRiskPct: 6
          }
        }
      }
    }
  }
};

const base = buildBasePayload(context);
assert.equal(base.selectedRouteKey, "traditional_pile");
assert.equal(base.config.P_pv, 300);
assert.equal(base.params.gTiltData.length, 8760);

const diagnosis = diagnoseResidualRisk(base);
assert.equal(diagnosis.energyRisk.active, true);
assert.equal(diagnosis.serviceRisk.active, true);
assert.equal(diagnosis.storageRisk.active, true);

const scenarios = buildScenarioPlans(base, diagnosis);
// Rebase-R1: 方案族候选搜索，不再是固定 5 个
assert.ok(scenarios.length >= 5);
assert.ok(scenarios.every((scenario) => scenario.deltas && scenario.family && Array.isArray(scenario.triggerBasis)));
assert.ok(scenarios.some(s => s.family === "S1"));
assert.ok(scenarios.some(s => s.family === "S2"));
assert.ok(scenarios.some(s => s.family === "S3"));

const evaluated = scenarios.map((scenario, index) => ({
  ...scenario,
  extraCapexWan: index * 20,
  stressMonth: {
    socMinPct: index >= 3 ? 10 : 6
  },
  annualValidation: {
    totalUnmetKwh: Math.max(0, 120 - index * 40),
    totalQueueUnmetKwh: Math.max(0, 45 - index * 15),
    totalOverflowCount: Math.max(0, 4 - index),
    serviceRate: index >= 3 ? 0.995 : 0.96,
    monthsWithSocRisk: index >= 3 ? 0 : 1
  },
  evaluationIndicators: {
    gff: 0.4 + index * 0.05,
    pvur: 0.6 + index * 0.04,
    annualLcoeYuanPerKwh: 1.2 - index * 0.04
  }
}));

const scored = scoreScenarios(evaluated, context.input.m4);
assert.equal(scored.length, scenarios.length);
assert.ok(scored.every(s => typeof s.recommendation.totalScore === "number"));

const recommendation = buildRecommendation(scored);
assert.ok(recommendation.recommendedScenarioId);
assert.equal(typeof recommendation.feasibleCount, "number");

await import("../src/worker/m4-engine.js");

globalThis.self = { addEventListener() {} };
await import("../src/worker/solver.worker.js");

console.log("smoke-test ok");
