import { CITY_CLIMATE_DATA } from "../config/climate-data.js";

function safeNumber(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

export function buildBasePayload(context) {
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

    // P_matrix 继承：优先 M3-B 年度验证 matrixConfig，其次 M3-A sizing / summary
    const annualMatrixConfig =
      m3?.selectedAnnualValidation?.matrixConfig ?? {};
    const flexMatrixSizing =
      m3?.routeOptions?.flex_matrix?.matrixSizing ?? {};

    const pMatrixKw =
      annualMatrixConfig.pMatrixKw ??
      flexMatrixSizing.recommendedPowerKw ??
      m3?.summary?.pMatrixRecommendedKw ??
      null;

    if (Number.isFinite(pMatrixKw) && pMatrixKw > 0) {
      params.pMatrixKw = pMatrixKw;
      params.pMatrixP95Kw =
        annualMatrixConfig.pMatrixP95Kw ??
        flexMatrixSizing.powerP95Kw ??
        m3?.summary?.pMatrixP95Kw ??
        null;
      params.pMatrixP99Kw =
        annualMatrixConfig.pMatrixP99Kw ??
        flexMatrixSizing.powerP99Kw ??
        m3?.summary?.pMatrixP99Kw ??
        null;
      params.pMatrixMaxKw =
        annualMatrixConfig.pMatrixMaxKw ??
        flexMatrixSizing.powerMaxKw ??
        m3?.summary?.pMatrixMaxKw ??
        null;
    }
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
