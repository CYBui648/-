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

  // M3-B 全年验证数据（优先级高于压力月）
  const annualSummary =
    base.m3?.selectedAnnualValidation?.annualValidation || {};
  const annualRaw =
    base.m3?.selectedAnnualValidation?.rawAnnual?.annual || {};

  // ---- 接口堵指标：压力月 ----
  const stressMatrixQueueTicks =
    safeNumber(routeResult.matrixQueueTicks, 0);
  const stressMatrixQueueVehicleTicks =
    safeNumber(routeResult.matrixQueueVehicleTicks, 0);
  const stressMatrixQueuePeak =
    safeNumber(routeResult.matrixQueuePeak, 0);

  // ---- 接口堵指标：全年 ----
  const annualMatrixQueueTicks =
    safeNumber(
      annualSummary.totalMatrixQueueTicks ??
      annualRaw.totalMatrixQueueTicks,
      0
    );
  const annualMatrixQueueVehicleTicks =
    safeNumber(
      annualSummary.totalMatrixQueueVehicleTicks ??
      annualRaw.totalMatrixQueueVehicleTicks,
      0
    );
  const annualMatrixQueuePeak =
    safeNumber(
      annualSummary.maxMatrixQueuePeak ??
      annualRaw.maxMatrixQueuePeak,
      0
    );

  // ---- 功率池堵指标：压力月 ----
  const stressPMatrixLimitedTicks =
    safeNumber(routeResult.pMatrixLimitedTicks, 0);
  const stressPMatrixLimitedEnergy =
    safeNumber(routeResult.pMatrixLimitedEnergyKwh, 0);
  const stressPMatrixMaxGap =
    safeNumber(routeResult.pMatrixMaxGapKw, 0);

  // ---- 功率池堵指标：全年 ----
  const annualPMatrixLimitedTicks =
    safeNumber(
      annualSummary.totalPMatrixLimitedTicks ??
      annualRaw.totalPMatrixLimitedTicks,
      0
    );
  const annualPMatrixLimitedEnergy =
    safeNumber(
      annualSummary.totalPMatrixLimitedEnergyKwh ??
      annualRaw.totalPMatrixLimitedEnergyKwh,
      0
    );
  const annualPMatrixMaxGap =
    safeNumber(
      annualSummary.maxPMatrixGapKw ??
      annualRaw.maxPMatrixGapKw,
      0
    );

  // ---- M3-B 全年核心指标（传统残余风险） ----
  const annualTotalUnmet =
    safeNumber(
      annualSummary.totalUnmetKwh ??
      annualRaw.totalUnmet,
      0
    );
  const annualTotalQueueUnmet =
    safeNumber(
      annualSummary.totalQueueUnmetKwh ??
      annualRaw.totalQueueUnmet,
      0
    );
  const annualTotalOverflow =
    safeNumber(
      annualSummary.totalOverflowCount ??
      annualRaw.totalOverflow,
      0
    );
  const annualMonthsWithSocRisk =
    safeNumber(
      annualSummary.monthsWithSocRisk ??
      annualRaw.monthsWithSocRisk,
      0
    );
  const annualMonthsWithOverflow =
    safeNumber(
      annualSummary.monthsWithOverflow ??
      annualRaw.monthsWithOverflow,
      0
    );
  const annualServiceRate =
    safeNumber(
      annualSummary.serviceRate ??
      annualRaw.serviceRate,
      1
    );

  // ---- 综合风险口径：压力月 + 全年 ----
  const combinedResidualUnmet =
    Math.max(residualUnmet, annualTotalUnmet);
  const combinedResidualQueue =
    Math.max(residualQueue, annualTotalQueueUnmet);
  const combinedResidualOverflow =
    Math.max(residualOverflow, annualTotalOverflow);
  // SOC：若全年有月度 SOC 风险，综合取更悲观值（cap at 5%）
  const combinedSocMin =
    annualMonthsWithSocRisk > 0
      ? Math.min(residualSoc, 5)
      : residualSoc;

  // ---- 经典风险维度（升级为 压力月 + 全年 综合口径） ----
  const accessServiceActive = combinedResidualQueue > 1;
  const deliveryServiceActive =
    combinedResidualUnmet > 1 || annualServiceRate < 0.95;
  const powerActive =
    combinedResidualOverflow > 0 ||
    transformerGapKw > 1 ||
    annualMonthsWithOverflow > 0;
  const energyActive =
    combinedResidualUnmet > 1 || annualServiceRate < 0.95;
  const storageActive =
    combinedSocMin < 8 || annualMonthsWithSocRisk > 0;

  const powerLevel = powerActive
    ? maxRiskLevel(
        transformerGapKw > 1
          ? riskLevel(transformerGapKw, [30, 100])
          : null,
        combinedResidualOverflow > 0
          ? riskLevel(combinedResidualOverflow, [15, 30])
          : null,
        annualMonthsWithOverflow > 0
          ? riskLevel(annualMonthsWithOverflow, [1, 3])
          : null
      )
    : null;
  const energyLevel = energyActive
    ? maxRiskLevel(
        combinedResidualUnmet > 1
          ? riskLevel(combinedResidualUnmet, [60, 200])
          : null,
        annualServiceRate < 0.95
          ? (annualServiceRate < 0.85 ? "high" : "medium")
          : null
      )
    : null;
  const accessServiceLevel = accessServiceActive
    ? riskLevel(combinedResidualQueue, [30, 100])
    : null;
  const deliveryServiceLevel = deliveryServiceActive
    ? maxRiskLevel(
        combinedResidualUnmet > 1
          ? riskLevel(combinedResidualUnmet, [60, 200])
          : null,
        annualServiceRate < 0.95
          ? (annualServiceRate < 0.85 ? "high" : "medium")
          : null
      )
    : null;
  const storageLevel = storageActive
    ? maxRiskLevel(
        combinedSocMin < 8
          ? (combinedSocMin >= 5 ? "low" : combinedSocMin >= 3 ? "medium" : "high")
          : null,
        annualMonthsWithSocRisk > 0
          ? riskLevel(annualMonthsWithSocRisk, [1, 3])
          : null
      )
    : null;

  // ---- 新增：accessPortRisk（接口堵） ----
  const accessPortRiskActive =
    stressMatrixQueueTicks > 0 ||
    stressMatrixQueuePeak > 0 ||
    annualMatrixQueueTicks > 0 ||
    annualMatrixQueuePeak > 0 ||
    residualQueue > 1;

  const accessPortRiskLevel = accessPortRiskActive
    ? maxRiskLevel(
        residualQueue > 1
          ? riskLevel(residualQueue, [30, 100])
          : null,

        stressMatrixQueueVehicleTicks > 0
          ? riskLevel(stressMatrixQueueVehicleTicks, [24, 120])
          : null,

        stressMatrixQueuePeak > 0
          ? riskLevel(stressMatrixQueuePeak, [2, 5])
          : null,

        annualMatrixQueueVehicleTicks > 0
          ? riskLevel(annualMatrixQueueVehicleTicks, [96, 480])
          : null,

        annualMatrixQueuePeak > 0
          ? riskLevel(annualMatrixQueuePeak, [2, 5])
          : null
      )
    : null;

  // ---- 新增：matrixPowerRisk（功率池堵） ----
  const matrixPowerRiskActive =
    stressPMatrixLimitedTicks > 0 ||
    stressPMatrixLimitedEnergy > 1 ||
    annualPMatrixLimitedTicks > 0 ||
    annualPMatrixLimitedEnergy > 1 ||
    annualPMatrixMaxGap > 1;

  const matrixPowerRiskLevel = matrixPowerRiskActive
    ? maxRiskLevel(
        stressPMatrixLimitedEnergy > 1
          ? riskLevel(stressPMatrixLimitedEnergy, [25, 120])
          : null,

        stressPMatrixLimitedTicks > 0
          ? riskLevel(stressPMatrixLimitedTicks, [24, 120])
          : null,

        stressPMatrixMaxGap > 1
          ? riskLevel(stressPMatrixMaxGap, [25, 100])
          : null,

        annualPMatrixLimitedEnergy > 1
          ? riskLevel(annualPMatrixLimitedEnergy, [100, 500])
          : null,

        annualPMatrixLimitedTicks > 0
          ? riskLevel(annualPMatrixLimitedTicks, [96, 480])
          : null,

        annualPMatrixMaxGap > 1
          ? riskLevel(annualPMatrixMaxGap, [25, 100])
          : null
      )
    : null;

  // ---- serviceRisk 转为兼容聚合 ----
  const serviceRiskLevel = maxRiskLevel(
    accessPortRiskLevel,
    matrixPowerRiskLevel
  );
  const serviceRiskActive =
    Boolean(accessPortRiskActive || matrixPowerRiskActive);

  // severityScore 纳入全年：serviceRate 惩罚 + monthsWithSocRisk 惩罚
  const baseSeverityScore =
    Math.min(35, combinedResidualUnmet / 120) +
    Math.min(25, combinedResidualQueue / 100) +
    Math.min(20, combinedResidualOverflow * 2) +
    Math.min(20, Math.max(0, 8 - combinedSocMin) * 2.5);

  const serviceRatePenalty =
    annualServiceRate < 0.85 ? 15 : annualServiceRate < 0.95 ? 8 : 0;

  const socMonthPenalty =
    Math.min(10, annualMonthsWithSocRisk * 2.5);

  const severityScore = baseSeverityScore + serviceRatePenalty + socMonthPenalty;

  return {
    // 压力月口径（保留用于对比）
    stressResidualUnmetKwh: round(residualUnmet, 1),
    stressResidualQueueUnmetKwh: round(residualQueue, 1),
    stressResidualOverflowCount: residualOverflow,
    stressSocMinPct: round(residualSoc, 1),

    // 全年口径
    annualTotalUnmetKwh: round(annualTotalUnmet, 1),
    annualTotalQueueUnmetKwh: round(annualTotalQueueUnmet, 1),
    annualTotalOverflowCount: annualTotalOverflow,
    annualMonthsWithSocRisk,
    annualMonthsWithOverflow,
    annualServiceRate: round(annualServiceRate, 4),

    // 综合口径（M4 后续主用）
    residualUnmetKwh: round(combinedResidualUnmet, 1),
    residualQueueUnmetKwh: round(combinedResidualQueue, 1),
    residualOverflowCount: combinedResidualOverflow,
    residualSocMinPct: round(combinedSocMin, 1),
    routePeakKw: round(peak, 1),
    transformerGapKw: round(transformerGapKw, 1),

    // 兼容聚合（旧字段）
    serviceRisk: { active: serviceRiskActive, level: serviceRiskLevel },
    deliveryServiceRisk: { active: deliveryServiceActive, level: deliveryServiceLevel },
    powerRisk: { active: powerActive, level: powerLevel },
    energyRisk: { active: energyActive, level: energyLevel },
    storageRisk: { active: storageActive, level: storageLevel },

    // 新拆分数值
    accessPortRisk: {
      active: accessPortRiskActive,
      level: accessPortRiskLevel
    },
    matrixPowerRisk: {
      active: matrixPowerRiskActive,
      level: matrixPowerRiskLevel
    },

    // 压力月柔性矩阵诊断明细
    stressMatrixQueueTicks,
    stressMatrixQueueVehicleTicks,
    stressMatrixQueuePeak,
    stressPMatrixLimitedTicks,
    stressPMatrixLimitedEnergyKwh: round(stressPMatrixLimitedEnergy, 1),
    stressPMatrixMaxGapKw: round(stressPMatrixMaxGap, 1),

    // 全年柔性矩阵诊断明细
    annualMatrixQueueTicks,
    annualMatrixQueueVehicleTicks,
    annualMatrixQueuePeak,
    annualPMatrixLimitedTicks,
    annualPMatrixLimitedEnergyKwh: round(annualPMatrixLimitedEnergy, 1),
    annualPMatrixMaxGapKw: round(annualPMatrixMaxGap, 1),

    severity: severityScore >= 60 ? "high" : severityScore >= 25 ? "medium" : "low",
    severityScore: round(severityScore, 1)
  };
}
