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

function levelScore(level) {
  if (level === "high") return 3;
  if (level === "medium") return 2;
  if (level === "low") return 1;
  return 0;
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

  // ---- M3-B 全年核心指标 ----
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

  // ============================================================
  // Round 6：传统风险拆分为 stressRisk / annualRisk / combinedRisk
  // ============================================================

  // 1) 压力月风险：仅看 M3-A 压力月残余表现
  const stressEnergyRiskLevel =
    residualUnmet > 1
      ? riskLevel(residualUnmet, [60, 200])
      : null;

  const stressDeliveryServiceRiskLevel =
    residualQueue > 1
      ? riskLevel(residualQueue, [30, 100])
      : null;

  const stressPowerRiskLevel =
    residualOverflow > 0 || transformerGapKw > 1
      ? maxRiskLevel(
          transformerGapKw > 1
            ? riskLevel(transformerGapKw, [30, 100])
            : null,
          residualOverflow > 0
            ? riskLevel(residualOverflow, [15, 30])
            : null
        )
      : null;

  const stressStorageRiskLevel =
    residualSoc < 8
      ? (
          residualSoc >= 5
            ? "low"
            : residualSoc >= 3
              ? "medium"
              : "high"
        )
      : null;

  // 2) 全年风险：仅看 M3-B 年度验证画像
  const annualEnergyRiskLevel =
    annualTotalUnmet > 1 || annualServiceRate < 0.995
      ? maxRiskLevel(
          annualTotalUnmet > 1
            ? riskLevel(annualTotalUnmet, [300, 1200])
            : null,
          annualServiceRate < 0.995
            ? (
                annualServiceRate >= 0.99
                  ? "low"
                  : annualServiceRate >= 0.97
                    ? "medium"
                    : "high"
              )
            : null
        )
      : null;

  const annualDeliveryServiceRiskLevel =
    annualTotalQueueUnmet > 1
      ? riskLevel(annualTotalQueueUnmet, [150, 600])
      : null;

  const annualPowerRiskLevel =
    annualTotalOverflow > 0 || annualMonthsWithOverflow > 0
      ? maxRiskLevel(
          annualTotalOverflow > 0
            ? riskLevel(annualTotalOverflow, [30, 120])
            : null,
          annualMonthsWithOverflow > 0
            ? riskLevel(annualMonthsWithOverflow, [1, 3])
            : null
        )
      : null;

  const annualStorageRiskLevel =
    annualMonthsWithSocRisk > 0
      ? riskLevel(annualMonthsWithSocRisk, [1, 3])
      : null;

  // 3) 综合风险：M4 最终采用"压力月 vs 全年"更严重的等级
  const energyLevel = maxRiskLevel(
    stressEnergyRiskLevel,
    annualEnergyRiskLevel
  );

  const deliveryServiceLevel = maxRiskLevel(
    stressDeliveryServiceRiskLevel,
    annualDeliveryServiceRiskLevel
  );

  const powerLevel = maxRiskLevel(
    stressPowerRiskLevel,
    annualPowerRiskLevel
  );

  const storageLevel = maxRiskLevel(
    stressStorageRiskLevel,
    annualStorageRiskLevel
  );

  const energyActive = Boolean(energyLevel);
  const deliveryServiceActive = Boolean(deliveryServiceLevel);
  const powerActive = Boolean(powerLevel);
  const storageActive = Boolean(storageLevel);

  // severityScore：四类传统风险综合打分
  const severityScore =
    levelScore(energyLevel) * 6 +
    levelScore(deliveryServiceLevel) * 6 +
    levelScore(powerLevel) * 5 +
    levelScore(storageLevel) * 4;

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

    // 压力月残余原始量：保留原始物理含义，Round 7 再决定方案生成如何使用
    residualUnmetKwh: round(residualUnmet, 1),
    residualQueueUnmetKwh: round(residualQueue, 1),
    residualOverflowCount: residualOverflow,
    residualSocMinPct: round(residualSoc, 1),
    routePeakKw: round(peak, 1),
    transformerGapKw: round(transformerGapKw, 1),

    // 三层风险画像
    riskLayers: {
      stressRisk: {
        energyRisk: stressEnergyRiskLevel,
        deliveryServiceRisk: stressDeliveryServiceRiskLevel,
        powerRisk: stressPowerRiskLevel,
        storageRisk: stressStorageRiskLevel
      },
      annualRisk: {
        energyRisk: annualEnergyRiskLevel,
        deliveryServiceRisk: annualDeliveryServiceRiskLevel,
        powerRisk: annualPowerRiskLevel,
        storageRisk: annualStorageRiskLevel
      },
      combinedRisk: {
        energyRisk: energyLevel,
        deliveryServiceRisk: deliveryServiceLevel,
        powerRisk: powerLevel,
        storageRisk: storageLevel
      }
    },

    // 四类风险
    deliveryServiceRisk: { active: deliveryServiceActive, level: deliveryServiceLevel },
    powerRisk: { active: powerActive, level: powerLevel },
    energyRisk: { active: energyActive, level: energyLevel },
    storageRisk: { active: storageActive, level: storageLevel },

    severity: severityScore >= 50 ? "high" : severityScore >= 20 ? "medium" : "low",
    severityScore: round(severityScore, 1),

    // 兼容 M4 方案生成器的命名
    powerBoundaryRisk: { active: powerActive, level: powerLevel },
    energySocRisk: {
      active: energyActive || storageActive,
      level: maxRiskLevel(energyLevel, storageLevel),
      energyLevel,
      storageLevel
    },

    compositeRisk: {
      active:
        energyActive ||
        deliveryServiceActive ||
        powerActive ||
        storageActive,
      level: severityScore >= 50 ? "high" : severityScore >= 20 ? "medium" : "low",
      severityScore: round(severityScore, 1)
    },

    summary: {
      activeRiskCount: [
        energyActive,
        deliveryServiceActive,
        powerActive,
        storageActive
      ].filter(Boolean).length,
      conclusion:
        severityScore > 0
          ? "价格调度后仍存在残余风险，需要进入工程加固方案生成。"
          : "价格调度后主要运行风险已被有效控制，可将基准方案作为候选定型方案。"
    }
  };
}
