function round(value, digits = 2) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function safeNumber(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
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

export function scoreScenarios(evaluated, weightsInput = {}) {
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
  const gridValues = evaluated.map(s => safeNumber(s.evaluationIndicators.gff, 0));
  const pvValues = evaluated.map(s => safeNumber(s.evaluationIndicators.pvur, 0));
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
    const gridScore = normMax(safeNumber(scenario.evaluationIndicators.gff, 0), ...ranges.grid);
    const pvScore = normMax(safeNumber(scenario.evaluationIndicators.pvur, 0), ...ranges.pv);
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

export function isM4ScenarioFeasible(scenario) {
  const v = scenario.annualValidation || {};
  const m = scenario.stressMonth || {};
  return (
    (v.totalOverflowCount || 0) <= 0 &&
    (v.totalUnmetKwh || 0) <= 1 &&
    (v.totalQueueUnmetKwh || 0) <= 1 &&
    (m.socMinPct == null || m.socMinPct >= 8) &&
    (v.monthsWithSocRisk || 0) <= 0 &&
    (v.serviceRate == null || v.serviceRate >= 0.99)
  );
}

function isMeaningfulImprovedScenario(scenario) {
  return scenario?.familyEffectiveness?.isMeaningful === true;
}

function pickBalancedImprovedCandidate(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  const rankedByImprovement = [...candidates].sort((a, b) => {
    const aRate = safeNumber(a.familyEffectiveness?.primaryReductionRate, -Infinity);
    const bRate = safeNumber(b.familyEffectiveness?.primaryReductionRate, -Infinity);
    return bRate - aRate;
  });

  const bestImprovementRate =
    safeNumber(
      rankedByImprovement[0]?.familyEffectiveness?.primaryReductionRate,
      -Infinity
    );

  const nearBestCandidates = rankedByImprovement.filter((scenario) => {
    const rate = safeNumber(
      scenario.familyEffectiveness?.primaryReductionRate,
      -Infinity
    );

    return bestImprovementRate - rate <= 0.05;
  });

  return [...nearBestCandidates].sort((a, b) =>
    safeNumber(b.recommendation?.totalScore, 0) -
    safeNumber(a.recommendation?.totalScore, 0)
  )[0] || rankedByImprovement[0] || null;
}

export function buildRecommendation(scored) {
  const feasible = scored.filter((s) => isM4ScenarioFeasible(s));
  const meaningfulImproved = scored.filter((s) =>
    isMeaningfulImprovedScenario(s)
  );

  let status = "no_effective_solution";
  let recommendation = null;
  let pool = scored;
  let explanation = "当前未生成可推荐方案。";

  if (feasible.length > 0) {
    status = "finalized";
    pool = feasible;
    recommendation = feasible[0] || null;

    explanation = recommendation
      ? `综合推荐 ${recommendation.id}：该方案已满足当前硬可行性约束，并在风险修复、追加投资与运行指标之间取得了当前候选集下的最佳平衡。`
      : "当前存在硬可行方案，但未能选出最终推荐。";
  } else if (meaningfulImproved.length > 0) {
    status = "improved_candidate";
    pool = meaningfulImproved;
    recommendation = pickBalancedImprovedCandidate(meaningfulImproved);

    const familyLabel =
      recommendation?.family === "S1"
        ? "功率侧"
        : recommendation?.family === "S2"
          ? "能量/SOC 侧"
          : recommendation?.family === "S3"
            ? "服务侧"
            : "专项";

    const metricLabel =
      recommendation?.familyEffectiveness?.primaryMetricLabel || "主导风险指标";

    const improveRate =
      recommendation?.familyEffectiveness?.primaryReductionRate;

    explanation = recommendation
      ? `当前无方案完全满足硬可行性约束，${recommendation.id} 被选为本轮折中改进候选。该方案属于${familyLabel}有效加固方案，对"${metricLabel}"形成了${Number.isFinite(improveRate) ? `${round(improveRate * 100, 1)}%` : "较明显"}改善；推荐逻辑优先保留接近最佳风险改善幅度的候选，再在其中选择综合评分更均衡者。`
      : "当前无硬可行方案，但已识别到部分有效改善候选。";
  } else {
    status = "no_effective_solution";
    pool = scored;
    recommendation = null;

    explanation =
      "当前候选方案中既没有满足硬可行性约束的定型方案，也没有形成足够明确的专项风险改善。建议扩大方案搜索边界、调整技术路线，或重新审视当前工程约束。";
  }

  const lowInvestment = [...pool].sort((a, b) =>
    safeNumber(a.extraCapexWan, 0) - safeNumber(b.extraCapexWan, 0)
  )[0] || null;

  const highProtection = [...pool].sort((a, b) => {
    const aRisk =
      safeNumber(a.annualValidation?.totalUnmetKwh, 0) +
      safeNumber(a.annualValidation?.totalOverflowCount, 0) * 100;

    const bRisk =
      safeNumber(b.annualValidation?.totalUnmetKwh, 0) +
      safeNumber(b.annualValidation?.totalOverflowCount, 0) * 100;

    return aRisk - bRisk;
  })[0] || null;

  return {
    status,
    recommendedScenarioId: recommendation?.id || null,
    recommendedScenarioTitle: recommendation?.title || null,
    recommendedScenarioFamily: recommendation?.family || null,

    lowInvestmentScenarioId: lowInvestment?.id || null,
    highProtectionScenarioId: highProtection?.id || null,

    isFallbackRecommendation: status !== "finalized",
    feasibleCount: feasible.length,
    meaningfulImprovedCount: meaningfulImproved.length,

    explanation
  };
}
