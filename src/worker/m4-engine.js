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
import {
  buildScenarioPlans,
  buildCompositeScenarioPlans
} from "./m4-scenarios.js";

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

function calcReductionAbs(baseValue, currentValue) {
  return round(safeNumber(baseValue, 0) - safeNumber(currentValue, 0), 4);
}

function calcReductionRate(baseValue, currentValue) {
  const base = safeNumber(baseValue, 0);
  const current = safeNumber(currentValue, 0);
  if (base <= 0) return null;
  return round((base - current) / base, 4);
}

function calcGainAbs(currentValue, baseValue) {
  return round(safeNumber(currentValue, 0) - safeNumber(baseValue, 0), 4);
}

function classifyImprovement(rate) {
  if (rate == null) return "not_applicable";
  if (rate >= 0.60) return "strong";
  if (rate >= 0.30) return "moderate";
  if (rate >= 0.05) return "limited";
  return "none";
}

function isMeaningfulImprovement(level) {
  return level === "strong" || level === "moderate";
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
  const transformerUpgradeCostWanPerKw =
    safeNumber(input.transformerUpgradeCostWanPerKw, 0);

  const finalStorage = base.config.E_storage + safeNumber(d.deltaStorageKwh, 0);
  const pvYuan = safeNumber(d.deltaPvKw, 0) * 1000 * pvPrice * (1 + pvRate / 100);
  const essYuan = safeNumber(d.deltaStorageKwh, 0) * 1000 * calcStorageUnitPrice(finalStorage, storBasePrice) * (1 + storRate / 100);
  const pcsYuan = safeNumber(d.deltaPcsKw, 0) * 450 * (1 + storRate / 100);
  const chargersWan = safeNumber(d.deltaN7, 0) * cost7kw + safeNumber(d.deltaN30, 0) * cost30kw;
  const matrixWan = safeNumber(d.deltaMatrix, 0) * 0.08;
  const transformerWan =
    safeNumber(d.deltaTransformerKw, 0) *
    transformerUpgradeCostWanPerKw;

  return round(
    (pvYuan + essYuan + pcsYuan) / 10000 +
    chargersWan +
    matrixWan +
    transformerWan,
    2
  );
}

function materializeScenarioPayload(base, scenario, extraCapexWan) {
  const d = scenario.deltas || {};
  const config = {
    ...base.config,
    P_pv: base.config.P_pv + safeNumber(d.deltaPvKw, 0),
    E_storage: base.config.E_storage + safeNumber(d.deltaStorageKwh, 0),
    P_storage: base.config.P_storage + safeNumber(d.deltaPcsKw, 0),
    transformerLimit:
      base.config.transformerLimit +
      safeNumber(d.deltaTransformerKw, 0),
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

    // P_matrix 固定继承：候选方案阶段不优化功率池，
    // 统一沿用 M3 已验证的 pMatrixKw，避免评估口径漂移。
    params.pMatrixKw = base.params.pMatrixKw ?? null;
    params.pMatrixP95Kw = base.params.pMatrixP95Kw ?? null;
    params.pMatrixP99Kw = base.params.pMatrixP99Kw ?? null;
    params.pMatrixMaxKw = base.params.pMatrixMaxKw ?? null;
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
      transformerLimitKw: round(payload.config.transformerLimit, 1),
      n7kw: payload.config.n7,
      n30kw: payload.config.n30,
      nMatrix: base.selectedRouteKey === "flex_matrix" ? safeNumber(payload.params.nMatrix, 0) : null,
      pMatrixKw: base.selectedRouteKey === "flex_matrix" ? safeNumber(payload.params.pMatrixKw, 0) || null : null
    },
    stressMonth: {
      realPeakKw: round(monthResult.realPeak || 0, 1),
      overflowCount: monthResult.overflowCount || 0,
      unmetTotalKwh: round(monthResult.unmetTotal || 0, 1),
      queueUnmetKwh: round(monthResult.queueUnmet || 0, 1),
      socMinPct: round(monthResult.socMin || 100, 1),
      abandonedCount: monthResult.abandonedCount || 0,

      matrixQueuePeak: monthResult.matrixQueuePeak || 0,
      matrixQueueTicks: monthResult.matrixQueueTicks || 0,
      matrixQueueVehicleTicks: monthResult.matrixQueueVehicleTicks || 0,

      pMatrixLimitedTicks: monthResult.pMatrixLimitedTicks || 0,
      pMatrixLimitedEnergyKwh: round(monthResult.pMatrixLimitedEnergyKwh || 0, 1),
      pMatrixMaxGapKw: round(monthResult.pMatrixMaxGapKw || 0, 1),
      pMatrixRawPeakKw: round(monthResult.pMatrixRawPeakKw || 0, 1)
    },
    annualValidation: {
      totalUnmetKwh: round(annual.totalUnmet || 0, 1),
      totalQueueUnmetKwh: round(annual.totalQueueUnmet || 0, 1),
      totalOverflowCount: annual.totalOverflow || 0,
      serviceRate: round(annual.serviceRate || 0, 4),

      totalMatrixQueueTicks: annual.totalMatrixQueueTicks || 0,
      totalMatrixQueueVehicleTicks: annual.totalMatrixQueueVehicleTicks || 0,
      maxMatrixQueuePeak: annual.maxMatrixQueuePeak || 0,

      totalPMatrixLimitedTicks: annual.totalPMatrixLimitedTicks || 0,
      totalPMatrixLimitedEnergyKwh: round(annual.totalPMatrixLimitedEnergyKwh || 0, 1),
      maxPMatrixGapKw: round(annual.maxPMatrixGapKw || 0, 1),
      maxPMatrixRawPeakKw: round(annual.maxPMatrixRawPeakKw || 0, 1),
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

function buildImprovementVsBaseline(scenario, baseline) {
  const sAnnual = scenario.annualValidation || {};
  const bAnnual = baseline.annualValidation || {};
  const sStress = scenario.stressMonth || {};
  const bStress = baseline.stressMonth || {};

  return {
    baselineScenarioId: baseline.id,

    annual: {
      unmetReductionKwh: calcReductionAbs(
        bAnnual.totalUnmetKwh,
        sAnnual.totalUnmetKwh
      ),
      unmetReductionRate: calcReductionRate(
        bAnnual.totalUnmetKwh,
        sAnnual.totalUnmetKwh
      ),

      queueUnmetReductionKwh: calcReductionAbs(
        bAnnual.totalQueueUnmetKwh,
        sAnnual.totalQueueUnmetKwh
      ),
      queueUnmetReductionRate: calcReductionRate(
        bAnnual.totalQueueUnmetKwh,
        sAnnual.totalQueueUnmetKwh
      ),

      overflowReductionCount: calcReductionAbs(
        bAnnual.totalOverflowCount,
        sAnnual.totalOverflowCount
      ),
      overflowReductionRate: calcReductionRate(
        bAnnual.totalOverflowCount,
        sAnnual.totalOverflowCount
      ),

      socRiskMonthsReduction: calcReductionAbs(
        bAnnual.monthsWithSocRisk,
        sAnnual.monthsWithSocRisk
      ),
      socRiskMonthsReductionRate: calcReductionRate(
        bAnnual.monthsWithSocRisk,
        sAnnual.monthsWithSocRisk
      ),

      serviceRateGain: calcGainAbs(
        sAnnual.serviceRate,
        bAnnual.serviceRate
      ),

      matrixQueueTicksReduction: calcReductionAbs(
        bAnnual.totalMatrixQueueTicks,
        sAnnual.totalMatrixQueueTicks
      ),
      matrixQueueTicksReductionRate: calcReductionRate(
        bAnnual.totalMatrixQueueTicks,
        sAnnual.totalMatrixQueueTicks
      ),

      matrixQueueVehicleTicksReduction: calcReductionAbs(
        bAnnual.totalMatrixQueueVehicleTicks,
        sAnnual.totalMatrixQueueVehicleTicks
      ),
      matrixQueueVehicleTicksReductionRate: calcReductionRate(
        bAnnual.totalMatrixQueueVehicleTicks,
        sAnnual.totalMatrixQueueVehicleTicks
      ),

      pMatrixLimitedEnergyReductionKwh: calcReductionAbs(
        bAnnual.totalPMatrixLimitedEnergyKwh,
        sAnnual.totalPMatrixLimitedEnergyKwh
      ),
      pMatrixLimitedEnergyReductionRate: calcReductionRate(
        bAnnual.totalPMatrixLimitedEnergyKwh,
        sAnnual.totalPMatrixLimitedEnergyKwh
      )
    },

    stressMonth: {
      unmetReductionKwh: calcReductionAbs(
        bStress.unmetTotalKwh,
        sStress.unmetTotalKwh
      ),

      queueUnmetReductionKwh: calcReductionAbs(
        bStress.queueUnmetKwh,
        sStress.queueUnmetKwh
      ),

      overflowReductionCount: calcReductionAbs(
        bStress.overflowCount,
        sStress.overflowCount
      ),

      socMinPctGain: calcGainAbs(
        sStress.socMinPct,
        bStress.socMinPct
      ),

      matrixQueueTicksReduction: calcReductionAbs(
        bStress.matrixQueueTicks,
        sStress.matrixQueueTicks
      ),

      matrixQueueVehicleTicksReduction: calcReductionAbs(
        bStress.matrixQueueVehicleTicks,
        sStress.matrixQueueVehicleTicks
      ),

      pMatrixLimitedEnergyReductionKwh: calcReductionAbs(
        bStress.pMatrixLimitedEnergyKwh,
        sStress.pMatrixLimitedEnergyKwh
      )
    }
  };
}

function buildFamilyEffectiveness(scenario, improvement, routeKey) {
  const family = scenario.family || scenario.id || "unknown";
  const annual = improvement?.annual || {};

  if (family === "S0") {
    return {
      family,
      primaryMetricKey: null,
      primaryMetricLabel: "基准对照",
      primaryReductionRate: null,
      level: "baseline",
      isMeaningful: null,
      note: "S0 为基准对照方案，不参与专项改善判定。"
    };
  }

  if (scenario.id?.endsWith("-0")) {
    return {
      family,
      primaryMetricKey: null,
      primaryMetricLabel: "未触发",
      primaryReductionRate: null,
      level: "not_triggered",
      isMeaningful: null,
      note: "该专项风险未触发，本候选仅作为说明性占位。"
    };
  }

  if (family === "S1") {
    const rate = annual.overflowReductionRate;
    const level = classifyImprovement(rate);

    return {
      family,
      primaryMetricKey: "annualOverflowReductionRate",
      primaryMetricLabel: "全年越限次数下降率",
      primaryReductionRate: rate,
      level,
      isMeaningful: isMeaningfulImprovement(level),
      note:
        level === "strong"
          ? "该功率侧候选对全年越限风险形成显著改善。"
          : level === "moderate"
            ? "该功率侧候选对全年越限风险形成中等改善。"
            : "该功率侧候选对全年越限风险的改善仍较有限。"
    };
  }

  if (family === "S2") {
    const unmetRate = annual.unmetReductionRate;
    const socRate = annual.socRiskMonthsReductionRate;

    const primaryRate =
      Math.max(
        unmetRate ?? -Infinity,
        socRate ?? -Infinity
      ) === -Infinity
        ? null
        : Math.max(unmetRate ?? 0, socRate ?? 0);

    const level = classifyImprovement(primaryRate);

    return {
      family,
      primaryMetricKey: "max(annualUnmetReductionRate, annualSocRiskMonthsReductionRate)",
      primaryMetricLabel: "全年能量缺口 / SOC 风险改善率",
      primaryReductionRate: primaryRate,
      level,
      isMeaningful: isMeaningfulImprovement(level),
      note:
        level === "strong"
          ? "该能量侧候选对全年缺口或 SOC 风险形成显著改善。"
          : level === "moderate"
            ? "该能量侧候选对全年缺口或 SOC 风险形成中等改善。"
            : "该能量侧候选对全年缺口或 SOC 风险的改善仍较有限。"
    };
  }

  if (family === "S3") {
    const rate =
      routeKey === "traditional_pile"
        ? annual.queueUnmetReductionRate
        : annual.matrixQueueVehicleTicksReductionRate;

    const level = classifyImprovement(rate);

    return {
      family,
      primaryMetricKey:
        routeKey === "traditional_pile"
          ? "annualQueueUnmetReductionRate"
          : "annualMatrixQueueVehicleTicksReductionRate",
      primaryMetricLabel:
        routeKey === "traditional_pile"
          ? "全年排队损失下降率"
          : "全年矩阵接口排队车时下降率",
      primaryReductionRate: rate,
      level,
      isMeaningful: isMeaningfulImprovement(level),
      note:
        level === "strong"
          ? "该服务侧候选对全年接入服务风险形成显著改善。"
          : level === "moderate"
            ? "该服务侧候选对全年接入服务风险形成中等改善。"
            : "该服务侧候选对全年接入服务风险的改善仍较有限。"
    };
  }

  if (family === "S4") {
    const componentFamilies =
      scenario.compositeMeta?.componentFamilies || [];

    const componentRates = componentFamilies.map((componentFamily) => {
      if (componentFamily === "S1") {
        return annual.overflowReductionRate;
      }

      if (componentFamily === "S2") {
        const unmetRate = annual.unmetReductionRate;
        const socRate = annual.socRiskMonthsReductionRate;

        if (unmetRate == null && socRate == null) return null;

        return Math.max(unmetRate ?? 0, socRate ?? 0);
      }

      if (componentFamily === "S3") {
        return routeKey === "traditional_pile"
          ? annual.queueUnmetReductionRate
          : annual.matrixQueueVehicleTicksReductionRate;
      }

      return null;
    }).filter((rate) => rate != null);

    const allModerateOrBetter =
      componentRates.length > 0 &&
      componentRates.every((rate) => rate >= 0.30);

    const allStrong =
      componentRates.length > 0 &&
      componentRates.every((rate) => rate >= 0.60);

    const primaryRate =
      componentRates.length > 0
        ? componentRates.reduce((sum, rate) => sum + rate, 0) /
          componentRates.length
        : null;

    const level =
      allStrong
        ? "strong"
        : allModerateOrBetter
          ? "moderate"
          : componentRates.some((rate) => rate >= 0.05)
            ? "limited"
            : "none";

    return {
      family,
      primaryMetricKey: "average(component risk reduction rates)",
      primaryMetricLabel: "组合风险平均改善率",
      primaryReductionRate: primaryRate == null ? null : round(primaryRate, 4),
      level,
      isMeaningful: allModerateOrBetter,
      note:
        allStrong
          ? "该综合方案对所组合的多个专项风险均形成显著改善。"
          : allModerateOrBetter
            ? "该综合方案对所组合的多个专项风险形成中等以上改善。"
            : "该综合方案尚未在多个专项风险上同时形成充分改善。"
    };
  }

  return {
    family,
    primaryMetricKey: null,
    primaryMetricLabel: "未知方案族",
    primaryReductionRate: null,
    level: "unknown",
    isMeaningful: null,
    note: "未识别的方案族，暂不进行专项改善判定。"
  };
}

function attachImprovementDiagnostics(evaluated, routeKey) {
  const baseline =
    evaluated.find((scenario) => scenario.id === "S0") ||
    evaluated.find((scenario) => scenario.family === "S0") ||
    null;

  if (!baseline) return evaluated;

  return evaluated.map((scenario) => {
    const improvementVsBaseline =
      buildImprovementVsBaseline(scenario, baseline);

    return {
      ...scenario,
      improvementVsBaseline,
      familyEffectiveness: buildFamilyEffectiveness(
        scenario,
        improvementVsBaseline,
        routeKey
      )
    };
  });
}

export function runM4FinalPlanner(context) {
  const base = buildBasePayload(context);
  const diagnosis = diagnoseResidualRisk(base);
  // ============================================================
  // 第一阶段：专项方案族 S0 / S1 / S2 / S3
  // ============================================================

  const specializedPlans = buildScenarioPlans(base, diagnosis);

  const evaluatedSpecialized = specializedPlans.map((scenario) =>
    evaluateScenario(base, scenario)
  );

  const specializedWithImprovement = attachImprovementDiagnostics(
    evaluatedSpecialized,
    base.selectedRouteKey
  );

  const scoredSpecialized = scoreScenarios(
    specializedWithImprovement,
    context.input?.m4 || {}
  );

  // ============================================================
  // 第二阶段：基于"已验证有效"的专项候选生成 S4 综合方案
  // ============================================================

  const compositePlans = buildCompositeScenarioPlans(
    scoredSpecialized,
    diagnosis,
    base.selectedRouteKey
  );

  const evaluatedComposite = compositePlans.map((scenario) =>
    evaluateScenario(base, scenario)
  );

  // ============================================================
  // 第三阶段：专项候选 + 综合候选合并后统一复算改善诊断与评分
  // ============================================================

  const allEvaluated = [
    ...evaluatedSpecialized,
    ...evaluatedComposite
  ];

  const allWithImprovement = attachImprovementDiagnostics(
    allEvaluated,
    base.selectedRouteKey
  );

  const scored = scoreScenarios(
    allWithImprovement,
    context.input?.m4 || {}
  );

  const recommendation = buildRecommendation(scored);

  const summaryTitle =
    recommendation.status === "finalized"
      ? "最终工程方案定型已完成"
      : recommendation.status === "improved_candidate"
        ? "当前已形成有效折中改进候选"
        : "当前方案边界内尚未形成有效定型解";

  return {
    contract: "M4Result",
    summary: {
      title: summaryTitle,
      selectedRouteKey: base.selectedRouteKey,
      selectedRouteLabel: base.selectedRoute.label,
      scenarioCount: scored.length,
      evaluationNote: "本版已接入方案族候选生成、压力月复验、全年复验、相对 S0 的专项改善诊断、基于有效专项候选的 S4 综合方案生成与综合评分。PVUR 与 GFF 已作为年度方案评价指标纳入推荐逻辑。"
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
