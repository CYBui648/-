import {
  runFlexibleMatrixDispatch,
  runTraditionalPileDispatch,
  runAnnualValidation
} from "./m4-dispatch-core.js";
import { buildBasePayload } from "./m4-base-payload.js";
import { diagnoseResidualRisk } from "./m4-risk-diagnosis.js";
import {
  buildRecommendation,
  scoreScenarios
} from "./m4-recommendation.js";
import { buildScenarioPlans } from "./m4-scenarios.js";

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function calcStorageUnitPrice(E_kWh, basePrice) {
  let price;
  if (E_kWh <= 500) price = 1.10 + (500 - E_kWh) * 0.0004;
  else if (E_kWh <= 1500) price = 0.85 + (1500 - E_kWh) * 0.000125;
  else if (E_kWh <= 3000) price = 0.70 + (3000 - E_kWh) * 0.000067;
  else price = 0.65 + Math.max(0, (4000 - E_kWh)) * 0.000025;
  return Math.max(0.5, price * ((Number.isFinite(basePrice) ? basePrice : 1.0) / 1.0));
}

function safeNumber(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function calcExtraCapexWan(base, scenario) {
  const input = base.m1Input || {};
  const d = scenario.deltas || {};
  const pvPrice = safeNumber(input.pvPrice, 1.50);
  const pvRate = safeNumber(input.pvRate, 15);
  const storBasePrice = safeNumber(input.storBasePrice, 1.00);
  const storRate = safeNumber(input.storRate, 12);
  const cost7kw = safeNumber(input.cost7kw, 0.30);
  const cost30kw = safeNumber(input.cost30kw, 2.50);

  const finalStorage = base.config.E_storage + safeNumber(d.deltaStorageKwh, 0);
  const pvYuan = safeNumber(d.deltaPvKw, 0) * 1000 * pvPrice * (1 + pvRate / 100);
  const essYuan = safeNumber(d.deltaStorageKwh, 0) * 1000 * calcStorageUnitPrice(finalStorage, storBasePrice) * (1 + storRate / 100);
  const pcsYuan = safeNumber(d.deltaPcsKw, 0) * 450 * (1 + storRate / 100);
  const chargersWan = safeNumber(d.deltaN7, 0) * cost7kw + safeNumber(d.deltaN30, 0) * cost30kw;
  const matrixWan = safeNumber(d.deltaMatrix, 0) * 0.08;

  return round((pvYuan + essYuan + pcsYuan) / 10000 + chargersWan + matrixWan, 2);
}

function materializeScenarioPayload(base, scenario, extraCapexWan) {
  const d = scenario.deltas || {};
  const config = {
    ...base.config,
    P_pv: base.config.P_pv + safeNumber(d.deltaPvKw, 0),
    E_storage: base.config.E_storage + safeNumber(d.deltaStorageKwh, 0),
    P_storage: base.config.P_storage + safeNumber(d.deltaPcsKw, 0),
    n7: base.config.n7 + safeNumber(d.deltaN7, 0),
    n30: base.config.n30 + safeNumber(d.deltaN30, 0),
    baseCapexYuan: base.config.baseCapexYuan + extraCapexWan * 10000
  };

  const params = {
    ...base.params,
    dispatchMode: base.selectedRouteKey
  };

  if (base.selectedRouteKey === "flex_matrix") {
    params.nMatrix = safeNumber(base.params.nMatrix, config.n7 + config.n30) + safeNumber(d.deltaMatrix, 0);
    params.nMatrixP95 = Math.max(safeNumber(base.params.nMatrixP95, params.nMatrix), params.nMatrix);
    params.nMatrixP99 = Math.max(safeNumber(base.params.nMatrixP99, params.nMatrix), params.nMatrix);
    params.nMatrixMax = Math.max(safeNumber(base.params.nMatrixMax, params.nMatrix), params.nMatrix);
  }

  return {
    config,
    params,
    economics: { ...base.economics },
    preferred: base.selectedRouteKey
  };
}

function runStressMonth(payload, routeKey) {
  return routeKey === "flex_matrix"
    ? runFlexibleMatrixDispatch(payload)
    : runTraditionalPileDispatch(payload);
}

function calcPVUR(annual) {
  const pvGen = safeNumber(annual.totalPvGen, 0);
  if (pvGen <= 0) return 0;
  const curtailed = Math.max(0, safeNumber(annual.totalCurtailed, 0));
  return clamp((pvGen - curtailed) / pvGen, 0, 1);
}

function calcGFF(annual) {
  const peak = safeNumber(annual.totalGridPeak, 0);
  const flat = safeNumber(annual.totalGridFlat, 0);
  const valley = safeNumber(annual.totalGridValley, 0);
  const total = peak + flat + valley;
  if (total <= 0) return 1;
  const peakShare = peak / total;
  const flatShare = flat / total;
  const gridBurdenScore = 1.0 * peakShare + 0.5 * flatShare;
  return clamp(1 - gridBurdenScore, 0, 1);
}

function evaluateScenario(base, scenario) {
  const extraCapexWan = calcExtraCapexWan(base, scenario);
  const payload = materializeScenarioPayload(base, scenario, extraCapexWan);
  const monthResult = runStressMonth(payload, base.selectedRouteKey);
  const annualValidation = runAnnualValidation(payload);
  const annual = annualValidation.annual || {};

  return {
    ...scenario,
    extraCapexWan,
    finalHardware: {
      pvKw: round(payload.config.P_pv, 1),
      storageKwh: round(payload.config.E_storage, 1),
      pcsKw: round(payload.config.P_storage, 1),
      n7kw: payload.config.n7,
      n30kw: payload.config.n30,
      nMatrix: base.selectedRouteKey === "flex_matrix" ? safeNumber(payload.params.nMatrix, 0) : null
    },
    stressMonth: {
      realPeakKw: round(monthResult.realPeak || 0, 1),
      overflowCount: monthResult.overflowCount || 0,
      unmetTotalKwh: round(monthResult.unmetTotal || 0, 1),
      queueUnmetKwh: round(monthResult.queueUnmet || 0, 1),
      socMinPct: round(monthResult.socMin || 100, 1),
      abandonedCount: monthResult.abandonedCount || 0
    },
    annualValidation: {
      totalUnmetKwh: round(annual.totalUnmet || 0, 1),
      totalQueueUnmetKwh: round(annual.totalQueueUnmet || 0, 1),
      totalOverflowCount: annual.totalOverflow || 0,
      serviceRate: round(annual.serviceRate || 0, 4),
      monthsWithOverflow: annual.monthsWithOverflow || 0,
      monthsWithSocRisk: annual.monthsWithSocRisk || 0,
      totalDeliveredKwh: round(annual.totalDelivered || 0, 1),
      totalGridBuyKwh: round(annual.totalGridBuy || 0, 1),
      totalV2gKwh: round(annual.totalV2g || 0, 1),
      annualGridCostYuan: round(annual.annualGridCost || 0, 1),
      annualLcoeYuanPerKwh: round(annual.annualLCOE || 999, 3)
    },
    evaluationIndicators: {
      pvur: round(calcPVUR(annual), 4),
      gff: round(calcGFF(annual), 4),
      annualLcoeYuanPerKwh: round(annual.annualLCOE || 999, 3)
    }
  };
}

export function runM4FinalPlanner(context) {
  const base = buildBasePayload(context);
  const diagnosis = diagnoseResidualRisk(base);
  const scenarioPlans = buildScenarioPlans(base, diagnosis);
  const evaluated = scenarioPlans.map((scenario) => evaluateScenario(base, scenario));
  const scored = scoreScenarios(evaluated, context.input?.m4 || {});
  const recommendation = buildRecommendation(scored);

  return {
    contract: "M4Result",
    summary: {
      title: "最终工程方案定型已完成",
      selectedRouteKey: base.selectedRouteKey,
      selectedRouteLabel: base.selectedRoute.label,
      scenarioCount: scored.length,
      evaluationNote: "本版已接入 S0~S4 方案生成、压力月复验、全年复验与综合评分。PVUR 与 GFF 已作为年度方案评价指标正式纳入推荐逻辑。"
    },
    residualDiagnosis: diagnosis,
    scenarios: scored,
    recommendation,
    metricInterpretation: {
      pvur: "PVUR：年度光伏利用率，表示全年光伏发电中被系统有效利用的比例，越高越好。",
      gff: "GFF：年度电网友好度，基于峰/平/谷购电结构计算；越少依赖峰段购电，数值越高。",
      lcoe: "年度单位服务成本，越低越好。"
    }
  };
}
