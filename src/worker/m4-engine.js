import { CITY_CLIMATE_DATA } from "../config/climate-data.js";
import {
  runFlexibleMatrixDispatch,
  runTraditionalPileDispatch,
  runAnnualValidation
} from "./m4-dispatch-core.js";

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function ceilTo(value, step) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil(value / step) * step;
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

function buildBasePayload(context) {
  const input = context.input || {};
  const m1Input = input.m1 || {};
  const m2Input = input.m2 || {};
  const m3Input = input.m3 || {};
  const m1 = context.previousResults?.m1;
  const m2 = context.previousResults?.m2;
  const m3 = context.previousResults?.m3;
  const selectedRouteKey = m3Input.selectedRoute || null;
  const selectedRoute = selectedRouteKey ? m3?.routeOptions?.[selectedRouteKey] : null;

  if (!m1?.hardwarePlan) throw new Error("M4 缺少 M1Result，无法读取基准硬件。");
  if (!m2?.riskReport) throw new Error("M4 缺少 M2Result，无法读取压力测试结果。");
  if (!m3?.routeOptions) throw new Error("M4 缺少 M3Result，无法读取双路线评估。");
  if (!selectedRoute) throw new Error("请先在 M3 中选择一条技术路线，再进入 M4。");
  if (!Array.isArray(m2Input.gTiltData) || m2Input.gTiltData.length < 8760) {
    throw new Error("M4 需要沿用 M2 已加载的 8760 小时 TMY 气象数据。");
  }

  const climate = CITY_CLIMATE_DATA[m1Input.climateKey] || CITY_CLIMATE_DATA.guangzhou;
  const transformerLimit = safeNumber(m2.summary?.transformerLimitKw ?? m2Input.transformerLimitKw, 500);
  const monthIndex = safeNumber(m2.summary?.monthIndex ?? m2Input.monthIndex, 0);
  const baseCapexYuan = safeNumber(m1.economics?.capexWan, 0) * 10000;

  const config = {
    P_pv: safeNumber(m1.hardwarePlan.pvKw, 0),
    E_storage: safeNumber(m1.hardwarePlan.storageKwh, 0),
    P_storage: safeNumber(m1.hardwarePlan.pcsKw, 0),
    n7: safeNumber(m1.hardwarePlan.n7kw, 0),
    n30: safeNumber(m1.hardwarePlan.n30kw, 0),
    transformerLimit,
    baseCapexYuan
  };

  const params = {
    monthIndex,
    seed: 20260513 + monthIndex,
    gTiltData: m2Input.gTiltData,
    evCount: safeNumber(m1Input.evCount, 100),
    teacherRatio: safeNumber(m2Input.teacherRatio ?? m1Input.teacherRatio, 0.80),
    anxietyRatio: safeNumber(m2Input.anxietyRatio ?? m1Input.anxietyRatio, 0.20),
    batteryCapMean: safeNumber(m1Input.batteryCapMean, 65),
    initSocMean: safeNumber(m1Input.initSocMean, 0.40),
    targetSocMean: safeNumber(m1Input.targetSocMean, 0.95),
    sessionKwh: safeNumber(m1Input.batteryCapMean, 65) * Math.max(0, safeNumber(m1Input.targetSocMean, 0.95) - safeNumber(m1Input.initSocMean, 0.40)),
    holidayRatio: safeNumber(m1Input.holidayRatio, 0.10),
    pvEfficiency: safeNumber(m1Input.pvEfficiency, 0.72),
    valleySocTarget: 0.30,
    usePricing: true,
    useClipping: selectedRouteKey === "flex_matrix",
    useV2G: selectedRouteKey === "flex_matrix" ? Boolean(m3Input.useV2G ?? true) : false,
    priceShiftThreshold: safeNumber(m3Input.priceShiftThreshold, 0.55),
    clipThreshold: safeNumber(m3Input.clipThreshold, 0.90),
    minClipSlackTicks: safeNumber(m3Input.minClipSlackHours, 2) * 4,
    maxV2gPerEv: safeNumber(m3Input.maxV2gPerEvKwh, 8),
    gridTouPrice: climate?.gridTouPrice,
    climate,
    dispatchMode: selectedRouteKey
  };

  if (selectedRouteKey === "flex_matrix") {
    const matrixSizing = selectedRoute.matrixSizing || {};
    params.nMatrix = safeNumber(matrixSizing.recommended, config.n7 + config.n30);
    params.nMatrixP95 = safeNumber(matrixSizing.p95, params.nMatrix);
    params.nMatrixP99 = safeNumber(matrixSizing.p99, params.nMatrix);
    params.nMatrixMax = safeNumber(matrixSizing.max, params.nMatrix);
  }

  const economics = {
    priceGridValley: climate?.gridTouPrice?.valley ?? 0.28,
    priceGridFlat: climate?.gridTouPrice?.flat ?? 0.65,
    priceGridPeak: climate?.gridTouPrice?.peak ?? 0.85,
    opexRate: safeNumber(m3Input.opexRate, 0.015),
    v2gWearCost: safeNumber(m3Input.v2gWearCostYuanPerKwh, 0.15)
  };

  return {
    selectedRouteKey,
    selectedRoute,
    config,
    params,
    economics,
    m1Input,
    m2,
    m3
  };
}

function diagnoseResidualRisk(base) {
  const handoff = base.selectedRoute.handoffToM4 || {};
  const routeResult = base.selectedRoute.result || {};
  const residualUnmet = safeNumber(handoff.residualUnmetKwh, safeNumber(routeResult.unmetTotalKwh, 0));
  const residualQueue = safeNumber(handoff.residualQueueUnmetKwh, safeNumber(routeResult.queueUnmetKwh, 0));
  const residualOverflow = safeNumber(handoff.residualOverflowCount, safeNumber(routeResult.overflowCount, 0));
  const residualSoc = safeNumber(handoff.residualSocRiskPct, safeNumber(routeResult.socMinPct, 100));
  const peak = safeNumber(routeResult.realPeakKw, 0);
  const transformerGapKw = Math.max(0, peak - base.config.transformerLimit);

  const serviceRisk = residualQueue > 1 || residualUnmet > 1;
  const powerRisk = residualOverflow > 0 || transformerGapKw > 1;
  const energyRisk = residualUnmet > 1;
  const storageRisk = residualSoc < 8;

  const severityScore =
    Math.min(35, residualUnmet / 120) +
    Math.min(25, residualQueue / 100) +
    Math.min(20, residualOverflow * 2) +
    Math.min(20, Math.max(0, 8 - residualSoc) * 2.5);

  return {
    residualUnmetKwh: round(residualUnmet, 1),
    residualQueueUnmetKwh: round(residualQueue, 1),
    residualOverflowCount: residualOverflow,
    residualSocMinPct: round(residualSoc, 1),
    routePeakKw: round(peak, 1),
    transformerGapKw: round(transformerGapKw, 1),
    serviceRisk,
    powerRisk,
    energyRisk,
    storageRisk,
    severity: severityScore >= 60 ? "high" : severityScore >= 25 ? "medium" : "low",
    severityScore: round(severityScore, 1)
  };
}

function buildScenarioPlans(base, diagnosis) {
  const pvBase = base.config.P_pv;
  const essBase = base.config.E_storage;
  const pcsBase = base.config.P_storage;
  const routeKey = base.selectedRouteKey;
  const residualUnmet = safeNumber(diagnosis.residualUnmetKwh, 0);
  const residualQueue = safeNumber(diagnosis.residualQueueUnmetKwh, 0);
  const transformerGap = safeNumber(diagnosis.transformerGapKw, 0);

  const powerDelta = ceilTo(Math.max(transformerGap * 0.9, pcsBase * 0.25, diagnosis.powerRisk ? 25 : 0), 25);
  const energyDelta = ceilTo(Math.max(residualUnmet * 0.05, essBase * 0.35, diagnosis.storageRisk ? 100 : 0, diagnosis.energyRisk ? 75 : 0), 50);
  const pvDelta = ceilTo(Math.max(residualUnmet * 0.02, diagnosis.energyRisk ? pvBase * 0.10 : 0), 25);

  const pileDelta = Math.max(1, Math.ceil(residualQueue / 600));
  const matrixDelta = Math.max(2, Math.ceil(residualQueue / 900));

  const serviceDelta = routeKey === "traditional_pile"
    ? { deltaN7: pileDelta, deltaN30: diagnosis.serviceRisk ? Math.max(0, Math.ceil(pileDelta / 2)) : 0, deltaMatrix: 0 }
    : { deltaN7: 0, deltaN30: 0, deltaMatrix: matrixDelta };

  return [
    {
      id: "S0",
      title: "S0 基准对照",
      intent: "不新增硬件，保留 M3 已选路线，作为所有加固方案的比较基线。",
      deltas: { deltaPvKw: 0, deltaStorageKwh: 0, deltaPcsKw: 0, deltaN7: 0, deltaN30: 0, deltaMatrix: 0 }
    },
    {
      id: "S1",
      title: "S1 功率瓶颈加固",
      intent: "优先加强 PCS / 功率支撑能力，用于压低峰值压力与运行功率瓶颈。",
      deltas: { deltaPvKw: 0, deltaStorageKwh: 0, deltaPcsKw: powerDelta, deltaN7: 0, deltaN30: 0, deltaMatrix: 0 }
    },
    {
      id: "S2",
      title: "S2 储能韧性加固",
      intent: "优先增加储能容量，并辅以适度光伏补量，提升能量韧性与 SOC 安全边界。",
      deltas: { deltaPvKw: pvDelta, deltaStorageKwh: energyDelta, deltaPcsKw: Math.min(powerDelta, 25), deltaN7: 0, deltaN30: 0, deltaMatrix: 0 }
    },
    {
      id: "S3",
      title: "S3 服务能力加固",
      intent: routeKey === "traditional_pile"
        ? "围绕传统桩站路线，补充固定桩位服务能力，缓解排队和放弃离场。"
        : "围绕柔性调度路线，扩大矩阵接入能力，缓解服务侧拥堵。",
      deltas: { deltaPvKw: 0, deltaStorageKwh: 0, deltaPcsKw: 0, ...serviceDelta }
    },
    {
      id: "S4",
      title: "S4 综合平衡方案",
      intent: "以中等补量同时处理功率、能量与服务三类短板，追求风险修复与投资代价的综合均衡。",
      deltas: {
        deltaPvKw: Math.max(0, ceilTo(pvDelta * 0.6, 25)),
        deltaStorageKwh: Math.max(0, ceilTo(energyDelta * 0.65, 50)),
        deltaPcsKw: Math.max(0, ceilTo(powerDelta * 0.65, 25)),
        deltaN7: routeKey === "traditional_pile" ? Math.max(0, Math.ceil(serviceDelta.deltaN7 * 0.75)) : 0,
        deltaN30: routeKey === "traditional_pile" ? Math.max(0, Math.ceil(serviceDelta.deltaN30 * 0.75)) : 0,
        deltaMatrix: routeKey === "flex_matrix" ? Math.max(0, Math.ceil(serviceDelta.deltaMatrix * 0.75)) : 0
      }
    }
  ];
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

function calcPVURProxy(annual) {
  const pvGen = safeNumber(annual.totalPvGen, 0);
  if (pvGen <= 0) return 0;
  const estimatedCurtail = Math.max(0, safeNumber(annual.totalCurtailed, 0));
  return clamp((pvGen - estimatedCurtail) / pvGen, 0, 1);
}

function calcGFFProxy(annual) {
  const total = safeNumber(annual.totalGridPeak, 0) + safeNumber(annual.totalGridFlat, 0) + safeNumber(annual.totalGridValley, 0);
  if (total <= 0) return 0;
  const peakShare = safeNumber(annual.totalGridPeak, 0) / total;
  const flatShare = safeNumber(annual.totalGridFlat, 0) / total;
  const valleyShare = safeNumber(annual.totalGridValley, 0) / total;
  return peakShare + flatShare - valleyShare;
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
      pvurProxy: round(calcPVURProxy(annual), 4),
      gffProxy: round(calcGFFProxy(annual), 4),
      annualLcoeYuanPerKwh: round(annual.annualLCOE || 999, 3)
    }
  };
}

function normMin(value, min, max) {
  if (!Number.isFinite(value)) return 0;
  if (max <= min) return 1;
  return clamp((max - value) / (max - min), 0, 1);
}

function normMax(value, min, max) {
  if (!Number.isFinite(value)) return 0;
  if (max <= min) return 1;
  return clamp((value - min) / (max - min), 0, 1);
}

function scoreScenarios(evaluated, weightsInput = {}) {
  const w = {
    risk: safeNumber(weightsInput.scenarioRiskWeight, 0.44),
    capex: safeNumber(weightsInput.scenarioCapexWeight, 0.18),
    grid: safeNumber(weightsInput.scenarioGridWeight, 0.16),
    pv: safeNumber(weightsInput.scenarioPvWeight, 0.10),
    lcoe: safeNumber(weightsInput.scenarioLcoeWeight, 0.12)
  };
  const totalW = w.risk + w.capex + w.grid + w.pv + w.lcoe || 1;

  const annualUnmetValues = evaluated.map(s => safeNumber(s.annualValidation.totalUnmetKwh, 0));
  const overflowValues = evaluated.map(s => safeNumber(s.annualValidation.totalOverflowCount, 0));
  const capexValues = evaluated.map(s => safeNumber(s.extraCapexWan, 0));
  const gridValues = evaluated.map(s => safeNumber(s.evaluationIndicators.gffProxy, 0));
  const pvValues = evaluated.map(s => safeNumber(s.evaluationIndicators.pvurProxy, 0));
  const lcoeValues = evaluated.map(s => safeNumber(s.evaluationIndicators.annualLcoeYuanPerKwh, 999));

  const ranges = {
    unmet: [Math.min(...annualUnmetValues), Math.max(...annualUnmetValues)],
    overflow: [Math.min(...overflowValues), Math.max(...overflowValues)],
    capex: [Math.min(...capexValues), Math.max(...capexValues)],
    grid: [Math.min(...gridValues), Math.max(...gridValues)],
    pv: [Math.min(...pvValues), Math.max(...pvValues)],
    lcoe: [Math.min(...lcoeValues), Math.max(...lcoeValues)]
  };

  return evaluated.map((scenario) => {
    const unmetScore = normMin(safeNumber(scenario.annualValidation.totalUnmetKwh, 0), ...ranges.unmet);
    const overflowScore = normMin(safeNumber(scenario.annualValidation.totalOverflowCount, 0), ...ranges.overflow);
    const riskScore = 0.72 * unmetScore + 0.28 * overflowScore;
    const capexScore = normMin(safeNumber(scenario.extraCapexWan, 0), ...ranges.capex);
    const gridScore = normMin(safeNumber(scenario.evaluationIndicators.gffProxy, 0), ...ranges.grid);
    const pvScore = normMax(safeNumber(scenario.evaluationIndicators.pvurProxy, 0), ...ranges.pv);
    const lcoeScore = normMin(safeNumber(scenario.evaluationIndicators.annualLcoeYuanPerKwh, 999), ...ranges.lcoe);

    const totalScore = (
      riskScore * w.risk +
      capexScore * w.capex +
      gridScore * w.grid +
      pvScore * w.pv +
      lcoeScore * w.lcoe
    ) / totalW;

    return {
      ...scenario,
      recommendation: {
        totalScore: round(totalScore * 100, 1),
        riskScore: round(riskScore * 100, 1),
        capexScore: round(capexScore * 100, 1),
        gridScore: round(gridScore * 100, 1),
        pvScore: round(pvScore * 100, 1),
        lcoeScore: round(lcoeScore * 100, 1)
      }
    };
  }).sort((a, b) => b.recommendation.totalScore - a.recommendation.totalScore);
}

function buildRecommendation(scored) {
  const recommendation = scored[0] || null;
  const lowInvestment = [...scored].sort((a, b) =>
    safeNumber(a.extraCapexWan, 0) - safeNumber(b.extraCapexWan, 0)
  )[0] || null;
  const highProtection = [...scored].sort((a, b) => {
    const aRisk = safeNumber(a.annualValidation.totalUnmetKwh, 0) + safeNumber(a.annualValidation.totalOverflowCount, 0) * 100;
    const bRisk = safeNumber(b.annualValidation.totalUnmetKwh, 0) + safeNumber(b.annualValidation.totalOverflowCount, 0) * 100;
    return aRisk - bRisk;
  })[0] || null;

  return {
    recommendedScenarioId: recommendation?.id || null,
    recommendedScenarioTitle: recommendation?.title || null,
    lowInvestmentScenarioId: lowInvestment?.id || null,
    highProtectionScenarioId: highProtection?.id || null,
    explanation: recommendation
      ? `综合评分最高的是 ${recommendation.id}。它在风险修复、追加投资与运行指标之间取得了当前版本下的最佳平衡。`
      : "当前未生成可推荐方案。"
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
      evaluationNote: "本版已接入 S0~S4 方案生成、压力月复验、全年复验与综合评分。PVUR / GFF 目前为工程近似指标，后续可按文献公式进一步精修。"
    },
    residualDiagnosis: diagnosis,
    scenarios: scored,
    recommendation,
    metricInterpretation: {
      pvurProxy: "PVUR 近似指标：基于全年光伏发电与估算弃光量得到，越高越好。",
      gffProxy: "GFF 近似指标：基于峰/平/谷购电结构构造的电网友好性代理值，越低越好。",
      lcoe: "年度单位服务成本，越低越好。"
    }
  };
}
