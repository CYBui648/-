import {
  buildDemandProfile,
  buildHardwarePlan,
  calcCapexWan,
  normalizeProjectInput,
  round,
  runScenarioSet,
  selectPressureMonth,
  simulateEnergyScenario,
  buildIrradianceSeries,
  MONTH_DAYS,
  MONTH_NAMES,
  SCENARIO_DEFINITIONS,
  SCENARIO_KEYS
} from "./scenario-core.js";

function requireBaseline(context) {
  const m1 = context.previousResults?.m1;
  if (!m1?.hardwarePlan) throw new Error("M3 缺少 M1Result，无法读取 S0 基准配置。");
  return m1;
}

function buildBaselineHardware(m1, params) {
  return buildHardwarePlan({
    pvKw: m1.hardwarePlan.pvKw,
    storageKwh: m1.hardwarePlan.storageKwh,
    pcsKw: m1.hardwarePlan.pcsKw,
    n7kw: m1.hardwarePlan.n7kw,
    n30kw: m1.hardwarePlan.n30kw,
    transformerLimitKw: params.transformerLimitKw
  });
}

function uniqueNumbers(values) {
  return [...new Set(values.map((value) => Math.max(0, Math.round(value))))].sort((a, b) => a - b);
}

function generateM3Candidates(baseline, params, demand) {
  const roofPvMax = params.roofArea > 0 ? params.roofArea / 6.5 : baseline.pvKw * 2.2;
  const pvValues = uniqueNumbers([
    baseline.pvKw * 0.7,
    baseline.pvKw * 0.85,
    baseline.pvKw,
    baseline.pvKw * 1.15,
    baseline.pvKw * 1.35,
    baseline.pvKw * 1.6
  ]).filter((value) => value <= roofPvMax + 1);
  const storageValues = uniqueNumbers([
    baseline.storageKwh * 0.55,
    baseline.storageKwh * 0.75,
    baseline.storageKwh,
    baseline.storageKwh * 1.25,
    baseline.storageKwh * 1.55,
    baseline.storageKwh * 1.9
  ]);
  const pcsValues = uniqueNumbers([
    baseline.pcsKw * 0.65,
    baseline.pcsKw * 0.85,
    baseline.pcsKw,
    baseline.pcsKw * 1.2,
    baseline.pcsKw * 1.45
  ]);
  const pilePairs = [
    [baseline.n7kw, baseline.n30kw],
    [Math.ceil(baseline.n7kw * 1.1), baseline.n30kw],
    [baseline.n7kw, Math.ceil(baseline.n30kw * 1.15)]
  ];
  const baselineCapex = calcCapexWan(baseline, params).capexWan;
  const candidates = [];
  let id = 0;

  pvValues.forEach((pvKw) => {
    storageValues.forEach((storageKwh) => {
      pcsValues.forEach((pcsKw) => {
        pilePairs.forEach(([n7kw, n30kw]) => {
          const hardware = buildHardwarePlan({
            pvKw,
            storageKwh,
            pcsKw,
            n7kw,
            n30kw,
            transformerLimitKw: params.transformerLimitKw
          });
          const capex = calcCapexWan(hardware, params);
          const deltas = {
            deltaPvKw: round(hardware.pvKw - baseline.pvKw, 1),
            deltaStorageKwh: round(hardware.storageKwh - baseline.storageKwh, 1),
            deltaPcsKw: round(hardware.pcsKw - baseline.pcsKw, 1),
            deltaN7kw: hardware.n7kw - baseline.n7kw,
            deltaN30kw: hardware.n30kw - baseline.n30kw
          };
          candidates.push({
            candidateId: `C${String(++id).padStart(3, "0")}`,
            hardwarePlan: hardware,
            capex,
            deltas,
            extraCapexWan: round(capex.capexWan - baselineCapex, 2),
            demandPeakCoverage: demand.peakLoadKw > 0 ? round(hardware.pcsKw / demand.peakLoadKw, 3) : 1
          });
        });
      });
    });
  });

  return candidates;
}

function feasibilityForScenario(scenarioKey, summary) {
  if (scenarioKey.startsWith("offgrid_")) {
    return {
      feasible: summary.unservedEnergyKwh <= 1 && summary.serviceRate >= 0.99 && summary.socMinPct >= 8,
      serviceOk: summary.serviceRate >= 0.99,
      unservedOk: summary.unservedEnergyKwh <= 1,
      socOk: summary.socMinPct >= 8,
      gridOk: summary.gridImportKwh === 0
    };
  }
  return {
    feasible: summary.serviceRate >= 0.995 && summary.peakGridKw <= Math.max(1, summary.peakLoadKw),
    serviceOk: summary.serviceRate >= 0.995,
    unservedOk: summary.unservedEnergyKwh <= 1,
    socOk: summary.socMinPct >= 5,
    gridOk: true
  };
}

function scenarioObjective(scenarioKey, candidate, simulation) {
  const summary = simulation.summary;
  const capex = candidate.capex.capexWan;
  const gridCostWan = summary.gridCostYuan / 10000;
  const unmetPenaltyWan = summary.unservedEnergyKwh * (scenarioKey.startsWith("offgrid_") ? 0.02 : 0.01);
  const gridDependencyPenaltyWan = scenarioKey.startsWith("grid_") ? summary.gridDependencyRate * 20 : 0;
  const curtailmentPenaltyWan = summary.curtailmentRatePct * 0.03;
  const annualizedCapexWan = capex * 0.085;
  const opexWan = capex * 0.015;

  if (scenarioKey === "offgrid_rule") {
    return annualizedCapexWan + opexWan + unmetPenaltyWan * 6 + curtailmentPenaltyWan;
  }
  if (scenarioKey === "offgrid_dispatch") {
    return annualizedCapexWan + opexWan + unmetPenaltyWan * 5 + curtailmentPenaltyWan;
  }
  if (scenarioKey === "grid_rule") {
    return annualizedCapexWan + opexWan + gridCostWan * 12 + gridDependencyPenaltyWan + unmetPenaltyWan;
  }
  return annualizedCapexWan + opexWan + gridCostWan * 12 + gridDependencyPenaltyWan * 0.8 + unmetPenaltyWan;
}

function isBetterEvaluation(next, best, scenarioKey) {
  if (!best) return true;
  const n = next.riskMetrics;
  const b = best.riskMetrics;
  const nf = next.feasibility.feasible;
  const bf = best.feasibility.feasible;
  if (nf && !bf) return true;
  if (!nf && bf) return false;

  if (scenarioKey.startsWith("offgrid_")) {
    if (n.unservedEnergyKwh < b.unservedEnergyKwh - 1) return true;
    if (n.unservedEnergyKwh > b.unservedEnergyKwh + 1) return false;
    if (n.serviceRate > b.serviceRate + 0.001) return true;
    if (n.serviceRate < b.serviceRate - 0.001) return false;
    if (n.socMinPct > b.socMinPct + 0.5) return true;
    if (n.socMinPct < b.socMinPct - 0.5) return false;
  } else {
    const ng = next.gridMetrics;
    const bg = best.gridMetrics;
    if (n.serviceRate > b.serviceRate + 0.001) return true;
    if (n.serviceRate < b.serviceRate - 0.001) return false;
    if (ng.gridCostYuan < bg.gridCostYuan - 10) return true;
    if (ng.gridCostYuan > bg.gridCostYuan + 10) return false;
    if (ng.gridDependencyRate < bg.gridDependencyRate - 0.005) return true;
    if (ng.gridDependencyRate > bg.gridDependencyRate + 0.005) return false;
  }

  return next.costMetrics.objectiveWan < best.costMetrics.objectiveWan;
}

function evaluateCandidate(candidate, scenarioKey, demand, irradiance, params) {
  const simulation = simulateEnergyScenario({
    hardware: candidate.hardwarePlan,
    loadCurve: demand.loadCurve,
    irradiance,
    params,
    scenarioKey
  });
  const summary = simulation.summary;
  const feasibility = feasibilityForScenario(scenarioKey, summary);
  const objectiveWan = scenarioObjective(scenarioKey, candidate, simulation);
  return {
    candidateId: candidate.candidateId,
    scenarioKey,
    hardwarePlan: candidate.hardwarePlan,
    deltas: candidate.deltas,
    extraCapexWan: candidate.extraCapexWan,
    feasibility,
    riskMetrics: {
      unservedEnergyKwh: round(summary.unservedEnergyKwh, 1),
      deficitHours: round(summary.deficitHours, 1),
      serviceRate: round(summary.serviceRate, 5),
      socMinPct: round(summary.socMinPct, 1),
      peakLoadKw: round(summary.peakLoadKw, 1)
    },
    gridMetrics: {
      gridImportKwh: round(summary.gridImportKwh, 1),
      peakGridKw: round(summary.peakGridKw, 1),
      gridDependencyRate: round(summary.gridDependencyRate, 5),
      gridCostYuan: round(summary.gridCostYuan, 1)
    },
    energyMetrics: {
      pvGenerationKwh: round(summary.pvGenerationKwh, 1),
      pvSelfUseRate: round(summary.pvSelfUseRate, 5),
      curtailmentRatePct: round(summary.curtailmentRatePct, 2)
    },
    costMetrics: {
      capexWan: candidate.capex.capexWan,
      extraCapexWan: candidate.extraCapexWan,
      annualizedCapexWan: round(candidate.capex.capexWan * 0.085, 2),
      objectiveWan: round(objectiveWan, 2),
      totalCostProxyWan: round(objectiveWan, 2)
    },
    summary
  };
}

function optimizeScenario(scenarioKey, candidates, demand, irradiance, params) {
  let recommended = null;
  const evaluatedCandidates = candidates.map((candidate) => {
    const evaluated = evaluateCandidate(candidate, scenarioKey, demand, irradiance, params);
    if (isBetterEvaluation(evaluated, recommended, scenarioKey)) recommended = evaluated;
    return {
      candidateId: evaluated.candidateId,
      hardwarePlan: evaluated.hardwarePlan,
      deltas: evaluated.deltas,
      extraCapexWan: evaluated.extraCapexWan,
      feasibility: evaluated.feasibility,
      riskMetrics: evaluated.riskMetrics,
      gridMetrics: evaluated.gridMetrics,
      energyMetrics: evaluated.energyMetrics,
      costMetrics: evaluated.costMetrics
    };
  });

  return {
    scenarioKey,
    scenarioLabel: SCENARIO_DEFINITIONS[scenarioKey].label,
    optimizationTarget: getOptimizationTarget(scenarioKey),
    feasibleCount: evaluatedCandidates.filter((item) => item.feasibility.feasible).length,
    recommendedConfig: recommended,
    evaluatedCandidates
  };
}

function getOptimizationTarget(scenarioKey) {
  return {
    offgrid_rule: "无电网、无调度条件下，以供能可靠性优先并最小化年化硬件成本。",
    offgrid_dispatch: "无电网条件下利用 SOC 保护调度降低硬件冗余和缺口风险。",
    grid_rule: "电网兜底但不主动调度，平衡投资、电网购电量和服务可靠性。",
    grid_dispatch: "并网条件下通过谷价补能和峰时放电降低综合成本与电网依赖。"
  }[scenarioKey];
}

function getRecommended(result, key) {
  return result.scenarioOptimums?.[key]?.recommendedConfig || null;
}

function buildComparison(result) {
  const offgridRule = getRecommended(result, "offgrid_rule");
  const offgridDispatch = getRecommended(result, "offgrid_dispatch");
  const gridRule = getRecommended(result, "grid_rule");
  const gridDispatch = getRecommended(result, "grid_dispatch");
  const recommendations = [offgridRule, offgridDispatch, gridRule, gridDispatch].filter(Boolean);
  const lowestCapex = [...recommendations].sort((a, b) => a.costMetrics.capexWan - b.costMetrics.capexWan)[0] || null;
  const lowestTotalCost = [...recommendations].sort((a, b) => a.costMetrics.objectiveWan - b.costMetrics.objectiveWan)[0] || null;
  const highestReliability = [...recommendations].sort((a, b) => b.riskMetrics.serviceRate - a.riskMetrics.serviceRate)[0] || null;

  return {
    dispatchValueOffgrid: offgridRule && offgridDispatch ? {
      capexSavingWan: round(offgridRule.costMetrics.capexWan - offgridDispatch.costMetrics.capexWan, 2),
      storageSavingKwh: round(offgridRule.hardwarePlan.storageKwh - offgridDispatch.hardwarePlan.storageKwh, 1),
      unservedReductionKwh: round(offgridRule.riskMetrics.unservedEnergyKwh - offgridDispatch.riskMetrics.unservedEnergyKwh, 1)
    } : null,
    dispatchValueGrid: gridRule && gridDispatch ? {
      totalCostSavingWan: round(gridRule.costMetrics.objectiveWan - gridDispatch.costMetrics.objectiveWan, 2),
      gridImportReductionKwh: round(gridRule.gridMetrics.gridImportKwh - gridDispatch.gridMetrics.gridImportKwh, 1),
      gridCostReductionYuan: round(gridRule.gridMetrics.gridCostYuan - gridDispatch.gridMetrics.gridCostYuan, 1)
    } : null,
    gridAccessValueRule: offgridRule && gridRule ? {
      capexSavingWan: round(offgridRule.costMetrics.capexWan - gridRule.costMetrics.capexWan, 2),
      storageSavingKwh: round(offgridRule.hardwarePlan.storageKwh - gridRule.hardwarePlan.storageKwh, 1),
      addedGridCostYuan: round(gridRule.gridMetrics.gridCostYuan, 1)
    } : null,
    gridAccessValueDispatch: offgridDispatch && gridDispatch ? {
      capexSavingWan: round(offgridDispatch.costMetrics.capexWan - gridDispatch.costMetrics.capexWan, 2),
      storageSavingKwh: round(offgridDispatch.hardwarePlan.storageKwh - gridDispatch.hardwarePlan.storageKwh, 1),
      addedGridCostYuan: round(gridDispatch.gridMetrics.gridCostYuan, 1)
    } : null,
    lowestCapexScenario: lowestCapex?.scenarioKey || null,
    lowestTotalCostScenario: lowestTotalCost?.scenarioKey || null,
    highestReliabilityScenario: highestReliability?.scenarioKey || null,
    recommendedForEngineering: gridDispatch?.feasibility?.feasible
      ? "grid_dispatch"
      : (lowestTotalCost?.scenarioKey || null)
  };
}

export function runM3ScenarioOptimization(context) {
  const m1 = requireBaseline(context);
  const params = normalizeProjectInput(context);
  const monthIndex = context.previousResults?.m2?.summary?.monthIndex ?? selectPressureMonth(params);
  const days = MONTH_DAYS[monthIndex] || 30;
  const baseline = buildBaselineHardware(m1, params);
  const demand = buildDemandProfile(params, {
    days,
    seed: 20260513 + monthIndex,
    pilePlan: { n7kw: baseline.n7kw, n30kw: baseline.n30kw }
  });
  const irradiance = buildIrradianceSeries(params, demand.loadCurve.length, {
    monthIndex,
    useGTilt: Boolean(params.gTiltData?.length)
  });
  const candidates = generateM3Candidates(baseline, params, demand);
  const scenarioOptimums = Object.fromEntries(
    SCENARIO_KEYS.map((key) => [key, optimizeScenario(key, candidates, demand, irradiance, params)])
  );
  const result = {
    contract: "M3ScenarioOptimizationResult",
    summary: {
      title: "四情景配置优化与横向比较已完成",
      candidateCount: candidates.length,
      scenarioCount: SCENARIO_KEYS.length,
      horizon: "pressure_month",
      monthName: MONTH_NAMES[monthIndex]
    },
    baseline: {
      hardwarePlan: baseline,
      m2ScenarioCompare: context.previousResults?.m2?.comparison || null
    },
    candidateCount: candidates.length,
    candidates: candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      hardwarePlan: candidate.hardwarePlan,
      deltas: candidate.deltas,
      extraCapexWan: candidate.extraCapexWan
    })),
    scenarioOptimums,
    weatherContext: {
      source: params.weatherSummary?.source,
      selectedMonthIndex: monthIndex,
      selectedMonthName: MONTH_NAMES[monthIndex]
    }
  };
  result.comparison = buildComparison(result);
  return result;
}

export function runM3DispatchDiagnosis(context) {
  return runM3ScenarioOptimization(context);
}
