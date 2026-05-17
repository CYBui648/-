function round(value, digits = 2) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function safeNumber(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function riskLevel(value, thresholds) {
  if (!Number.isFinite(value)) return null;
  if (value <= thresholds[0]) return "low";
  if (value <= thresholds[1]) return "medium";
  return "high";
}

export function maxRiskLevel(...levels) {
  const rank = { low: 1, medium: 2, high: 3 };
  return levels
    .filter(Boolean)
    .sort((a, b) => rank[b] - rank[a])[0] || null;
}

export function diagnoseResidualRisk(base) {
  const handoff = base.selectedRoute.handoffToM4 || {};
  const routeResult = base.selectedRoute.result || {};
  const residualUnmet = safeNumber(handoff.residualUnmetKwh, safeNumber(routeResult.unmetTotalKwh, 0));
  const residualQueue = safeNumber(handoff.residualQueueUnmetKwh, safeNumber(routeResult.queueUnmetKwh, 0));
  const residualOverflow = safeNumber(handoff.residualOverflowCount, safeNumber(routeResult.overflowCount, 0));
  const residualSoc = safeNumber(handoff.residualSocRiskPct, safeNumber(routeResult.socMinPct, 100));
  const peak = safeNumber(routeResult.realPeakKw, 0);
  const transformerGapKw = Math.max(0, peak - base.config.transformerLimit);

  // 拆分为两种服务风险：接入拥堵 vs 供电不足
  const accessServiceActive = residualQueue > 1;
  const deliveryServiceActive = residualUnmet > 1;
  const powerActive = residualOverflow > 0 || transformerGapKw > 1;
  const energyActive = residualUnmet > 1;
  const storageActive = residualSoc < 8;

  // powerLevel 用 maxRiskLevel 聚合两个维度，避免单维度零值覆盖高维度误判
  const powerLevel = powerActive
    ? maxRiskLevel(
        transformerGapKw > 1
          ? riskLevel(transformerGapKw, [30, 100])
          : null,
        residualOverflow > 0
          ? riskLevel(residualOverflow, [15, 30])
          : null
      )
    : null;
  const energyLevel = energyActive
    ? riskLevel(residualUnmet, [60, 200])
    : null;
  const accessServiceLevel = accessServiceActive
    ? riskLevel(residualQueue, [30, 100])
    : null;
  const deliveryServiceLevel = deliveryServiceActive
    ? riskLevel(residualUnmet, [60, 200])
    : null;
  const storageLevel = storageActive
    ? (residualSoc >= 5 ? "low" : residualSoc >= 3 ? "medium" : "high")
    : null;

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
    // serviceRisk 今后专指"接入型服务风险"
    serviceRisk: { active: accessServiceActive, level: accessServiceLevel },
    // deliveryServiceRisk 新增，代表"供电不足导致的服务风险"
    deliveryServiceRisk: { active: deliveryServiceActive, level: deliveryServiceLevel },
    powerRisk: { active: powerActive, level: powerLevel },
    energyRisk: { active: energyActive, level: energyLevel },
    storageRisk: { active: storageActive, level: storageLevel },
    severity: severityScore >= 60 ? "high" : severityScore >= 25 ? "medium" : "low",
    severityScore: round(severityScore, 1)
  };
}
