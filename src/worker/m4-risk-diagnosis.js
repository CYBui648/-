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

  // severityScore：从"直接揉指标"改为"风险等级综合打分"
  const severityScore =
    levelScore(energyLevel) * 6 +
    levelScore(deliveryServiceLevel) * 6 +
    levelScore(powerLevel) * 5 +
    levelScore(storageLevel) * 4 +
    levelScore(accessPortRiskLevel) * 4 +
    levelScore(matrixPowerRiskLevel) * 4;

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
