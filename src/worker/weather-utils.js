const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const MONTH_NAMES = [
  "1月", "2月", "3月", "4月", "5月", "6月",
  "7月", "8月", "9月", "10月", "11月", "12月"
];

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sum(values) {
  return values.reduce((s, v) => s + safeNumber(v, 0), 0);
}

export function isValidGTiltData(gTiltData) {
  return Array.isArray(gTiltData) && gTiltData.length >= 8760;
}

/**
 * 将 24 点小时典型日曲线插值成 96 点 15min 曲线。
 *
 * 输入单位：
 * - hourlyShape24: W/m² 或等效辐照强度
 *
 * 输出单位：
 * - shape96: kW/m² 等效值
 * - shape96 每点乘以 0.25h 后累加，约等于日 HPS
 */
function interpolateHourlyIrradianceToShape96(hourlyShape24, targetDailyHps) {
  const shape96 = [];

  for (let t = 0; t < 96; t++) {
    const hour = Math.floor(t / 4);
    const sub = (t % 4) / 4;

    const current = safeNumber(hourlyShape24[hour], 0);
    const next = safeNumber(hourlyShape24[Math.min(23, hour + 1)], current);

    // W/m² -> kW/m²
    shape96.push((current + (next - current) * sub) / 1000);
  }

  // 归一化校准：确保 96 点曲线积分严格等于该月日均 HPS
  const dailyHpsFromShape = shape96.reduce((s, v) => s + v * 0.25, 0);

  if (dailyHpsFromShape > 0 && targetDailyHps > 0) {
    const scale = targetDailyHps / dailyHpsFromShape;
    return shape96.map(v => v * scale);
  }

  return shape96;
}

/**
 * 从 8760 小时 G_tilt 数据提炼 M1 可用的基准气象情景。
 *
 * 输入：
 * - gTiltData: 8760 小时倾斜面辐照度，单位通常为 W/m²
 * - baseClimate: 原城市气候对象，用于继承电价、降雨、默认参数等
 *
 * 输出：
 * - monthlyTotalHPS: 月总峰值日照小时，kWh/m²/month
 * - monthlyDailyHPS: 月均日峰值日照小时，h/day
 * - monthlyPvShape96: 每个月一条 96 点典型日光伏曲线
 * - annualSolar: 年总辐照量，kWh/m²/year
 * - avgSolar: 年均日 HPS，h/day
 */
export function buildWeatherScenarioFromGTilt(gTiltData, baseClimate = {}) {
  if (!isValidGTiltData(gTiltData)) {
    return null;
  }

  const monthlyTotalHPS = [];
  const monthlyDailyHPS = [];
  const monthlyHourlyAvg24 = [];
  const monthlyPvShape96 = [];

  let cursor = 0;

  for (let month = 0; month < 12; month++) {
    const days = MONTH_DAYS[month];
    const hours = days * 24;

    const monthValues = gTiltData
      .slice(cursor, cursor + hours)
      .map(v => Math.max(0, safeNumber(v, 0)));

    cursor += hours;

    // G_tilt 为 W/m²，逐小时积分后 /1000 = kWh/m² ≈ HPS
    const monthTotalHps = sum(monthValues) / 1000;
    const monthDailyHps = monthTotalHps / days;

    monthlyTotalHPS.push(round(monthTotalHps, 3));
    monthlyDailyHPS.push(round(monthDailyHps, 3));

    const hourlyAvg24 = [];

    for (let hour = 0; hour < 24; hour++) {
      let hourSum = 0;

      for (let day = 0; day < days; day++) {
        hourSum += safeNumber(monthValues[day * 24 + hour], 0);
      }

      hourlyAvg24.push(hourSum / days);
    }

    monthlyHourlyAvg24.push(hourlyAvg24);

    monthlyPvShape96.push(
      interpolateHourlyIrradianceToShape96(hourlyAvg24, monthDailyHps)
    );
  }

  const annualSolar = monthlyTotalHPS.reduce((s, v) => s + v, 0);
  const avgSolar = annualSolar / 365;

  const worstMonthByDailyHPS = monthlyDailyHPS.indexOf(
    Math.min(...monthlyDailyHPS)
  );

  const worstMonthByTotalHPS = monthlyTotalHPS.indexOf(
    Math.min(...monthlyTotalHPS)
  );

  const bestMonthByDailyHPS = monthlyDailyHPS.indexOf(
    Math.max(...monthlyDailyHPS)
  );

  return {
    ...baseClimate,

    source: "tmy_8760_fitted",
    sourceLabel: "由 8760 小时 TMY 倾斜面辐照度拟合",

    // 原生数据保留给 M2/M3/M4 使用
    gTiltData,

    // 明确单位的新字段
    monthlyTotalHPS,
    monthlyDailyHPS,
    monthlyHourlyAvg24,
    monthlyPvShape96,

    annualSolar: round(annualSolar, 3),
    avgSolar: round(avgSolar, 3),

    worstMonthByDailyHPS,
    worstMonthByDailyHPSName: MONTH_NAMES[worstMonthByDailyHPS],

    worstMonthByTotalHPS,
    worstMonthByTotalHPSName: MONTH_NAMES[worstMonthByTotalHPS],

    bestMonthByDailyHPS,
    bestMonthByDailyHPSName: MONTH_NAMES[bestMonthByDailyHPS],

    // 兼容旧字段：
    // 注意：这里的 monthlyHPS 明确用"月均日 HPS"，不是月总量
    monthlyHPS: monthlyDailyHPS
  };
}

/**
 * 给页面或调试输出用的轻量摘要。
 */
export function buildWeatherSummary(weatherScenario) {
  if (!weatherScenario) {
    return {
      source: "fallback_city_climate",
      sourceLabel: "城市默认气候参数"
    };
  }

  return {
    source: weatherScenario.source,
    sourceLabel: weatherScenario.sourceLabel,
    annualSolar: weatherScenario.annualSolar,
    avgSolar: weatherScenario.avgSolar,
    monthlyDailyHPS: weatherScenario.monthlyDailyHPS,
    monthlyTotalHPS: weatherScenario.monthlyTotalHPS,
    worstMonthByDailyHPS: weatherScenario.worstMonthByDailyHPS,
    worstMonthByDailyHPSName: weatherScenario.worstMonthByDailyHPSName,
    worstMonthByTotalHPS: weatherScenario.worstMonthByTotalHPS,
    worstMonthByTotalHPSName: weatherScenario.worstMonthByTotalHPSName,
    bestMonthByDailyHPS: weatherScenario.bestMonthByDailyHPS,
    bestMonthByDailyHPSName: weatherScenario.bestMonthByDailyHPSName
  };
}

export { MONTH_DAYS, MONTH_NAMES };
