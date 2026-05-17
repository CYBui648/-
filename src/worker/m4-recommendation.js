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

export function buildRecommendation(scored) {
  const feasible = scored.filter((s) => isM4ScenarioFeasible(s));
  const pool = feasible.length > 0 ? feasible : scored;
  const isFallback = feasible.length === 0;

  const recommendation = pool[0] || null;
  const lowInvestment = [...pool].sort((a, b) =>
    safeNumber(a.extraCapexWan, 0) - safeNumber(b.extraCapexWan, 0)
  )[0] || null;
  const highProtection = [...pool].sort((a, b) => {
    const aRisk = safeNumber(a.annualValidation.totalUnmetKwh, 0) + safeNumber(a.annualValidation.totalOverflowCount, 0) * 100;
    const bRisk = safeNumber(b.annualValidation.totalUnmetKwh, 0) + safeNumber(b.annualValidation.totalOverflowCount, 0) * 100;
    return aRisk - bRisk;
  })[0] || null;

  const explanation = recommendation
    ? (isFallback
        ? `当前无方案完全满足硬可行性约束，${recommendation.id} 为候选中的相对最优方案。该方案仍存在部分残余风险，建议进一步调整工程边界或扩展方案库。`
        : `综合推荐 ${recommendation.id}：硬可行方案中综合评分最高，在风险修复、追加投资与运行指标之间取得了当前版本下的最佳平衡。`)
    : "当前未生成可推荐方案。";

  return {
    recommendedScenarioId: recommendation?.id || null,
    recommendedScenarioTitle: recommendation?.title || null,
    lowInvestmentScenarioId: lowInvestment?.id || null,
    highProtectionScenarioId: highProtection?.id || null,
    isFallbackRecommendation: isFallback,
    feasibleCount: feasible.length,
    explanation
  };
}
