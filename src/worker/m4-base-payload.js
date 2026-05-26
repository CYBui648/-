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

  const selectedRouteKey = "traditional_pile";
  const selectedRoute = m3?.routeOptions?.traditional_pile || null;

  if (!m1?.hardwarePlan) {
    throw new Error("M4 缺少 M1Result，无法读取基准硬件。");
  }

  if (!m2?.riskReport) {
    throw new Error("M4 缺少 M2Result，无法读取压力测试结果。");
  }

  if (!m3?.routeOptions?.traditional_pile) {
    throw new Error("M4 缺少 M3Result，无法读取价格调度结果。");
  }

  if (!Array.isArray(m2Input.gTiltData) || m2Input.gTiltData.length < 8760) {
    throw new Error("M4 需要沿用 M2 已加载的 8760 小时 TMY 气象数据。");
  }

  const climate = CITY_CLIMATE_DATA[m1Input.climateKey] || CITY_CLIMATE_DATA.guangzhou;

  const transformerLimit = safeNumber(
    m2.summary?.transformerLimitKw ?? m2Input.transformerLimitKw,
    500
  );

  const monthIndex = safeNumber(
    m2.summary?.monthIndex ?? m2Input.monthIndex,
    0
  );

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

    sessionKwh:
      safeNumber(m1Input.batteryCapMean, 65) *
      Math.max(
        0,
        safeNumber(m1Input.targetSocMean, 0.95) -
        safeNumber(m1Input.initSocMean, 0.40)
      ),

    holidayRatio: safeNumber(m1Input.holidayRatio, 0.10),
    pvEfficiency: safeNumber(m1Input.pvEfficiency, 0.72),
    valleySocTarget: 0.30,

    usePricing: true,
    useClipping: false,
    useV2G: false,

    priceShiftThreshold: safeNumber(m3Input.priceShiftThreshold, 0.55),
    clipThreshold: 1,
    minClipSlackTicks: 0,
    maxV2gPerEv: 0,

    gridTouPrice: climate?.gridTouPrice,
    climate,
    dispatchMode: "traditional_pile"
  };

  const economics = {
    priceGridValley: climate?.gridTouPrice?.valley ?? 0.28,
    priceGridFlat: climate?.gridTouPrice?.flat ?? 0.65,
    priceGridPeak: climate?.gridTouPrice?.peak ?? 0.85,
    opexRate: safeNumber(m3Input.opexRate, 0.015),
    v2gWearCost: 0
  };

  const weatherContext = {
    m1WeatherSummary: m1?.weatherSummary || null,
    m2WeatherSummary: m2?.weatherSummary || null,
    m3WeatherContext: m3?.weatherContext || null,
    m3AnnualWeatherContext:
      m3?.selectedAnnualValidation?.weatherContext || null,

    source: m2?.weatherSummary?.source || "tmy_8760_raw",
    monthIndex,
    monthName:
      m2?.weatherSummary?.selectedMonthName ||
      m2?.summary?.monthName ||
      `${monthIndex + 1}月`,

    selectedMonthMethod:
      m2?.weatherSummary?.selectedMonthMethod ||
      (m2?.weatherSummary?.isAutoSelectedMonth ? "daily_hps_min" : "manual"),

    selectedMonthDailyHPS:
      m2?.weatherSummary?.selectedMonthDailyHPS ?? null,

    selectedMonthTotalHPS:
      m2?.weatherSummary?.selectedMonthTotalHPS ?? null,

    gTiltDataLength: Array.isArray(m2Input.gTiltData)
      ? m2Input.gTiltData.length
      : 0,

    validationMode: "stress_month_and_annual_8760_raw"
  };

  return {
    selectedRouteKey,
    selectedRoute,
    config,
    params,
    economics,
    weatherContext,
    m1Input,
    m2Input,
    m3Input,
    m1,
    m2,
    m3
  };
}
