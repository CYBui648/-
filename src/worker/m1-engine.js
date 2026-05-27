import {
  buildDemandProfile,
  buildHardwarePlan,
  buildIrradianceSeries,
  calcCapexWan,
  normalizeProjectInput,
  round,
  simulateEnergyScenario,
  MONTH_DAYS,
  MONTH_NAMES
} from "./scenario-core.js";

function calcLcoeYuanPerKwh(capexWan, annualDemandKwh, annualGridCostYuan = 0, opexRate = 0.015) {
  const annualizedCostYuan = capexWan * 10000 * 0.085 + capexWan * 10000 * opexRate + annualGridCostYuan;
  return annualDemandKwh > 0 ? annualizedCostYuan / annualDemandKwh : 0;
}

function buildCandidateGrid(params, demand) {
  const dailyKwh = Math.max(1, demand.totalDailyKwh);
  const peakLoad = Math.max(10, demand.peakLoadKw);
  const roofPvMax = params.roofArea > 0 ? params.roofArea / 6.5 : dailyKwh * 8;
  const pvBase = Math.max(40, Math.ceil(dailyKwh / Math.max(params.weather?.avgSolar || 3.5, 1) / 10) * 10);
  const storageBase = Math.max(50, Math.ceil(dailyKwh * 1.2 / 50) * 50);
  const pcsBase = Math.max(20, Math.ceil(peakLoad / 10) * 10);

  const pvValues = [0.8, 1, 1.25, 1.5, 1.8, 2.2]
    .map((factor) => Math.min(roofPvMax, Math.ceil(pvBase * factor / 10) * 10));
  const storageValues = [0.7, 1, 1.3, 1.7, 2.2, 2.8]
    .map((factor) => Math.ceil(storageBase * factor / 50) * 50);
  const pcsValues = [0.8, 1, 1.25, 1.5]
    .map((factor) => Math.ceil(pcsBase * factor / 10) * 10);

  const candidates = [];
  pvValues.forEach((pvKw) => {
    storageValues.forEach((storageKwh) => {
      pcsValues.forEach((pcsKw) => {
        candidates.push(buildHardwarePlan({
          pvKw,
          storageKwh,
          pcsKw,
          n7kw: demand.pilePlan.n7kw,
          n30kw: demand.pilePlan.n30kw,
          transformerLimitKw: params.transformerLimitKw
        }));
      });
    });
  });
  return candidates;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function aggregateMonthlyBaseline(monthEvaluations) {
  const total = {
    demandKwh: 0,
    deliveredKwh: 0,
    unservedEnergyKwh: 0,
    deficitHours: 0,
    pvGenerationKwh: 0,
    pvToLoadKwh: 0,
    batteryToLoadKwh: 0,
    curtailmentKwh: 0
  };

  let socMinPct = Infinity;

  monthEvaluations.forEach((item) => {
    const s = item.simulation.summary;
    const w = item.weight;

    total.demandKwh += (s.demandKwh || 0) * w;
    total.deliveredKwh += (s.deliveredKwh || 0) * w;
    total.unservedEnergyKwh += (s.unservedEnergyKwh || 0) * w;
    total.deficitHours += (s.deficitHours || 0) * w;
    total.pvGenerationKwh += (s.pvGenerationKwh || 0) * w;
    total.pvToLoadKwh += (s.pvToLoadKwh || 0) * w;
    total.batteryToLoadKwh += (s.batteryToLoadKwh || 0) * w;
    total.curtailmentKwh += (s.curtailmentKwh || 0) * w;

    socMinPct = Math.min(socMinPct, s.socMinPct ?? Infinity);
  });

  const renewableUsedKwh = total.pvToLoadKwh + total.batteryToLoadKwh;

  const worstMonth = monthEvaluations.reduce((worst, item) => {
    if (!worst) return item;

    const a = item.simulation.summary;
    const b = worst.simulation.summary;

    const aUnservedRate = ratio(a.unservedEnergyKwh || 0, a.demandKwh || 0);
    const bUnservedRate = ratio(b.unservedEnergyKwh || 0, b.demandKwh || 0);

    if (aUnservedRate > bUnservedRate + 1e-6) return item;
    if (aUnservedRate < bUnservedRate - 1e-6) return worst;

    if ((a.unservedEnergyKwh || 0) > (b.unservedEnergyKwh || 0) + 1e-6) return item;
    if ((a.unservedEnergyKwh || 0) < (b.unservedEnergyKwh || 0) - 1e-6) return worst;

    if ((a.socMinPct ?? 100) < (b.socMinPct ?? 100)) return item;

    return worst;
  }, null);

  const worstSummary = worstMonth?.simulation?.summary || {};
  const worstMonthUnservedRate = ratio(
    worstSummary.unservedEnergyKwh || 0,
    worstSummary.demandKwh || 0
  );

  return {
    annualDemandKwh: total.demandKwh,
    annualDeliveredKwh: total.deliveredKwh,
    annualEquivalentUnservedKwh: total.unservedEnergyKwh,
    annualUnservedRate: ratio(total.unservedEnergyKwh, total.demandKwh),
    annualDeficitHours: total.deficitHours,

    serviceRate: ratio(total.deliveredKwh, total.demandKwh),
    socMinPct: Number.isFinite(socMinPct) ? socMinPct : 0,

    pvGenerationKwh: total.pvGenerationKwh,
    pvToLoadKwh: total.pvToLoadKwh,
    batteryToLoadKwh: total.batteryToLoadKwh,
    curtailmentKwh: total.curtailmentKwh,

    pvSelfUseRate: ratio(renewableUsedKwh, total.pvGenerationKwh),
    renewableSupplyRate: ratio(renewableUsedKwh, total.demandKwh),
    curtailmentRatePct: ratio(total.curtailmentKwh, total.pvGenerationKwh) * 100,

    worstMonthIndex: worstMonth?.monthIndex ?? 0,
    worstMonthName: worstMonth?.monthName || MONTH_NAMES[0],
    worstMonthUnservedKwh: worstSummary.unservedEnergyKwh || 0,
    worstMonthUnservedRate,
    worstMonthDeficitHours: worstSummary.deficitHours || 0,
    worstMonthSocMinPct: worstSummary.socMinPct || 0,

    worstMonth
  };
}

function evaluateCandidateAcrossMonths(candidate, params, demand) {
  const monthEvaluations = Array.from({ length: 12 }, (_, monthIndex) => {
    const irradiance = buildIrradianceSeries(params, demand.loadCurve.length, {
      monthIndex,
      useGTilt: false
    });

    const simulation = simulateEnergyScenario({
      hardware: candidate,
      loadCurve: demand.loadCurve,
      irradiance,
      params,
      scenarioKey: "offgrid_rule"
    });

    return {
      monthIndex,
      monthName: MONTH_NAMES[monthIndex],
      days: MONTH_DAYS[monthIndex],
      weight: MONTH_DAYS[monthIndex] / 7,
      simulation
    };
  });

  const annual = aggregateMonthlyBaseline(monthEvaluations);
  const capex = calcCapexWan(candidate, params);

  const renewableShortfall = Math.max(
    0,
    params.renewableTarget - annual.renewableSupplyRate
  );

  const score = {
    annualDemandKwh: annual.annualDemandKwh,
    annualEquivalentUnservedKwh: annual.annualEquivalentUnservedKwh,
    annualUnservedRate: annual.annualUnservedRate,

    worstMonthIndex: annual.worstMonthIndex,
    worstMonthName: annual.worstMonthName,
    worstMonthUnservedKwh: annual.worstMonthUnservedKwh,
    worstMonthUnservedRate: annual.worstMonthUnservedRate,

    serviceRate: annual.serviceRate,
    deficitHours: annual.annualDeficitHours,
    socMinPct: annual.socMinPct,

    pvSelfUseRate: annual.pvSelfUseRate,
    renewableSupplyRate: annual.renewableSupplyRate,
    renewableShortfall,
    curtailmentRatePct: annual.curtailmentRatePct,

    capexWan: capex.capexWan,
    lcoeYuanPerKwh: calcLcoeYuanPerKwh(
      capex.capexWan,
      annual.annualDemandKwh,
      0,
      params.opexRate
    )
  };

  return {
    candidate,
    monthEvaluations,
    annualSummary: annual,
    simulation: annual.worstMonth?.simulation || monthEvaluations[0].simulation,
    score
  };
}

function annualizeWeekValue(value) {
  return (value || 0) * 365 / 7;
}

function buildBaselineIrradianceSeries(params, length) {
  const monthlySeries = Array.from({ length: 12 }, (_, monthIndex) => {
    const irradiance = buildIrradianceSeries(params, length, {
      monthIndex,
      useGTilt: false
    });

    return {
      monthIndex,
      weight: MONTH_DAYS[monthIndex] / 7,
      irradiance
    };
  });

  const totalWeight = monthlySeries.reduce((sum, item) => sum + item.weight, 0);

  return Array.from({ length }, (_, i) => {
    const weightedValue = monthlySeries.reduce((sum, item) => {
      return sum + (item.irradiance[i] || 0) * item.weight;
    }, 0);

    return totalWeight > 0 ? weightedValue / totalWeight : 0;
  });
}

function evaluateCandidateOnBaselineWeather(candidate, params, demand) {
  const irradiance = buildBaselineIrradianceSeries(params, demand.loadCurve.length);

  const simulation = simulateEnergyScenario({
    hardware: candidate,
    loadCurve: demand.loadCurve,
    irradiance,
    params,
    scenarioKey: "offgrid_rule"
  });

  const summary = simulation.summary;
  const capex = calcCapexWan(candidate, params);

  const renewableUsedKwh = (summary.pvToLoadKwh || 0) + (summary.batteryToLoadKwh || 0);
  const renewableSupplyRate = ratio(renewableUsedKwh, summary.demandKwh || 0);
  const pvSelfUseRate = ratio(renewableUsedKwh, summary.pvGenerationKwh || 0);

  const annualDemandKwh = annualizeWeekValue(summary.demandKwh);
  const annualEquivalentUnservedKwh = annualizeWeekValue(summary.unservedEnergyKwh);
  const annualEquivalentPvKwh = annualizeWeekValue(summary.pvGenerationKwh);
  const annualEquivalentCurtailmentKwh = annualizeWeekValue(summary.curtailmentKwh);

  const renewableShortfall = Math.max(
    0,
    params.renewableTarget - renewableSupplyRate
  );

  const baselineUnservedRate = ratio(
    summary.unservedEnergyKwh || 0,
    summary.demandKwh || 0
  );

  const score = {
    baselineWeatherType: "weighted_average_typical_week",

    baselineDemandKwh: summary.demandKwh || 0,
    baselineUnservedKwh: summary.unservedEnergyKwh || 0,
    baselineUnservedRate,

    annualDemandKwh,
    annualEquivalentUnservedKwh,
    annualUnservedRate: baselineUnservedRate,
    annualEquivalentPvKwh,
    annualEquivalentCurtailmentKwh,

    serviceRate: summary.serviceRate || 0,
    deficitHours: summary.deficitHours || 0,
    socMinPct: summary.socMinPct || 0,

    pvSelfUseRate,
    renewableSupplyRate,
    renewableShortfall,
    curtailmentRatePct: summary.curtailmentRatePct || 0,

    capexWan: capex.capexWan,
    lcoeYuanPerKwh: calcLcoeYuanPerKwh(
      capex.capexWan,
      annualDemandKwh,
      0,
      params.opexRate
    )
  };

  return {
    candidate,
    baselineWeatherType: "weighted_average_typical_week",
    simulation,
    score
  };
}

function isBetterBaseline(next, best) {
  if (!best) return true;

  const n = next.score;
  const b = best.score;

  // 1. 基准气象下离网缺口率
  if (n.baselineUnservedRate < b.baselineUnservedRate - 0.0005) return true;
  if (n.baselineUnservedRate > b.baselineUnservedRate + 0.0005) return false;

  // 2. 基准气象下绝对缺口
  if (n.baselineUnservedKwh < b.baselineUnservedKwh - 1) return true;
  if (n.baselineUnservedKwh > b.baselineUnservedKwh + 1) return false;

  // 3. 服务率
  if (n.serviceRate > b.serviceRate + 0.001) return true;
  if (n.serviceRate < b.serviceRate - 0.001) return false;

  // 4. SOC 安全
  if (n.socMinPct > b.socMinPct + 0.5) return true;
  if (n.socMinPct < b.socMinPct - 0.5) return false;

  // 5. 可再生供能目标
  if (n.renewableShortfall < b.renewableShortfall - 0.005) return true;
  if (n.renewableShortfall > b.renewableShortfall + 0.005) return false;

  // 6. 经济性：先 LCOE，再 CAPEX
  if (n.lcoeYuanPerKwh < b.lcoeYuanPerKwh - 0.001) return true;
  if (n.lcoeYuanPerKwh > b.lcoeYuanPerKwh + 0.001) return false;

  return n.capexWan < b.capexWan;
}

function chooseBaseline(params, demand) {
  const candidates = buildCandidateGrid(params, demand);

  let best = null;

  candidates.forEach((candidate) => {
    const evaluated = evaluateCandidateOnBaselineWeather(
      candidate,
      params,
      demand
    );

    if (isBetterBaseline(evaluated, best)) {
      best = evaluated;
    }
  });

  const monthlyValidation = evaluateCandidateAcrossMonths(
    best.candidate,
    params,
    demand
  );

  return {
    ...best,
    monthlyValidation,
    candidateCount: candidates.length,
    annualDemandKwh: best?.score?.annualDemandKwh || 0
  };
}

function buildM1ChartData(demand, simulation) {
  return {
    pv: simulation.chartData.pv,
    ev: demand.loadCurve,
    rawDemand: demand.rawLoadCurve,
    soc: simulation.chartData.soc,
    fastOcc: demand.fastOccupancy,
    slowOcc: demand.slowOccupancy,
    rawFastOcc: demand.rawFastOccupancy,
    rawSlowOcc: demand.rawSlowOccupancy
  };
}

export function runM1Plan(context) {
  const params = normalizeProjectInput(context);
  const demand = buildDemandProfile(params, { days: 7, seed: 20260512 });
  const selected = chooseBaseline(params, demand);
  const hardware = selected.candidate;
  const capex = calcCapexWan(hardware, params);

  const summary = selected.simulation.summary;
  const monthlyValidation = selected.monthlyValidation || {};
  const monthlySummary = monthlyValidation.annualSummary || {};
  const monthEvaluations = monthlyValidation.monthEvaluations || [];

  const lcoe = selected.score.lcoeYuanPerKwh ?? calcLcoeYuanPerKwh(
    capex.capexWan,
    selected.annualDemandKwh,
    0,
    params.opexRate
  );

  return {
    contract: "M1Result",
    baseConfigType: "s0_offgrid_baseline",
    summary: {
      title: "S0 离网基准配置已生成",
      city: params.climate.city,
      climateZone: params.climate.zone,
      candidateCount: selected.candidateCount,
      renewableTarget: params.renewableTarget
    },
    hardwarePlan: {
      ...hardware,
      pvAreaM2: round(hardware.pvKw * 6.5, 1)
    },
    economics: {
      ...capex,
      lcoeYuanPerKwh: round(lcoe, 3)
    },
    baselineMatch: {
      baselineWeatherType: selected.score.baselineWeatherType,
      baselineDemandKwh: round(selected.score.baselineDemandKwh, 1),
      baselineUnservedKwh: round(selected.score.baselineUnservedKwh, 1),
      baselineUnservedRate: round(selected.score.baselineUnservedRate, 5),

      annualDemandKwh: round(selected.score.annualDemandKwh, 1),
      annualEquivalentUnservedKwh: round(selected.score.annualEquivalentUnservedKwh, 1),
      annualUnservedRate: round(selected.score.annualUnservedRate, 5),

      serviceRate: round(selected.score.serviceRate, 5),
      deficitHours: round(selected.score.deficitHours, 1),
      socMinPct: round(selected.score.socMinPct, 1),

      pvSelfUseRate: round(selected.score.pvSelfUseRate, 5),
      renewableSupplyRate: round(selected.score.renewableSupplyRate, 5),
      renewableShortfall: round(selected.score.renewableShortfall, 5),
      curtailmentRatePct: round(selected.score.curtailmentRatePct, 2),

      lcoeYuanPerKwh: round(lcoe, 3)
    },
    offgridBaselineCheck: {
      checkType: "baseline_weighted_average_weather_standard_week",
      baselineWeatherType: selected.score.baselineWeatherType,

      annualEquivalentUnservedKwh: round(selected.score.annualEquivalentUnservedKwh, 1),
      unservedKwh: round(selected.score.baselineUnservedKwh, 1),
      unservedRate: round(selected.score.baselineUnservedRate, 5),

      deficitHours: round(selected.score.deficitHours, 1),
      serviceRate: round(selected.score.serviceRate, 5),
      socMinPct: round(selected.score.socMinPct, 1),

      pvGenerationAnnualKwh: round(selected.score.annualEquivalentPvKwh, 1),
      pvDirectToLoadKwh: round(annualizeWeekValue(summary.pvToLoadKwh), 1),
      batteryToLoadKwh: round(annualizeWeekValue(summary.batteryToLoadKwh), 1),
      curtailmentKwh: round(selected.score.annualEquivalentCurtailmentKwh, 1),
      curtailmentRatePct: round(selected.score.curtailmentRatePct, 2),

      pvSelfUseRate: round(selected.score.pvSelfUseRate, 5),
      renewableSupplyRate: round(selected.score.renewableSupplyRate, 5),
      renewableShare: round(selected.score.renewableSupplyRate, 5),

      totalLoadEnergyAnnualKwh: round(selected.annualDemandKwh, 1),
      lcoeYuanPerKwh: round(lcoe, 3)
    },
    monthlyAdaptationCheck: {
      checkType: "selected_s0_monthly_weather_sensitivity",

      annualEquivalentUnservedKwh: round(monthlySummary.annualEquivalentUnservedKwh, 1),
      unservedRate: round(monthlySummary.annualUnservedRate, 5),
      serviceRate: round(monthlySummary.serviceRate, 5),
      deficitHours: round(monthlySummary.annualDeficitHours, 1),
      socMinPct: round(monthlySummary.socMinPct, 1),

      worstMonthIndex: monthlySummary.worstMonthIndex,
      worstMonthName: monthlySummary.worstMonthName,
      worstMonthUnservedKwh: round(monthlySummary.worstMonthUnservedKwh, 1),
      worstMonthUnservedRate: round(monthlySummary.worstMonthUnservedRate, 5),
      worstMonthDeficitHours: round(monthlySummary.worstMonthDeficitHours, 1),
      worstMonthSocMinPct: round(monthlySummary.worstMonthSocMinPct, 1),

      pvGenerationAnnualKwh: round(monthlySummary.pvGenerationKwh, 1),
      curtailmentKwh: round(monthlySummary.curtailmentKwh, 1),
      curtailmentRatePct: round(monthlySummary.curtailmentRatePct, 2),

      pvSelfUseRate: round(monthlySummary.pvSelfUseRate, 5),
      renewableSupplyRate: round(monthlySummary.renewableSupplyRate, 5),

      monthlyChecks: monthEvaluations.map((item) => {
        const s = item.simulation.summary;
        return {
          monthIndex: item.monthIndex,
          monthName: item.monthName,
          days: item.days,
          weight: round(item.weight, 3),
          demandKwhWeek: round(s.demandKwh, 1),
          unservedKwhWeek: round(s.unservedEnergyKwh, 1),
          unservedRate: s.demandKwh > 0 ? round(s.unservedEnergyKwh / s.demandKwh, 5) : 0,
          serviceRate: round(s.serviceRate, 5),
          deficitHours: round(s.deficitHours, 1),
          socMinPct: round(s.socMinPct, 1),
          pvGenerationKwhWeek: round(s.pvGenerationKwh, 1),
          curtailmentRatePct: round(s.curtailmentRatePct, 2)
        };
      })
    },
    energyPerformance: {
      renewableShare: round(selected.score.renewableSupplyRate, 5),
      renewableSupplyRate: round(selected.score.renewableSupplyRate, 5),
      pvSelfUseRate: round(selected.score.pvSelfUseRate, 5),

      pvGenerationAnnualKwh: round(selected.score.annualEquivalentPvKwh, 1),
      curtailmentAnnualKwh: round(selected.score.annualEquivalentCurtailmentKwh, 1),
      curtailmentRatePct: round(selected.score.curtailmentRatePct, 2),

      gridBuyDailyKwh: 0,
      gridBuyAnnualKwh: 0,
      gridCostDailyYuan: 0,
      gridCostAnnualYuan: 0
    },
    demandProfile: {
      totalDailyKwh: round(demand.totalDailyKwh, 1),
      totalWeekKwh: round(demand.totalEnergyKwh, 1),
      peakLoadKw: round(demand.peakLoadKw, 1),
      rawPeakLoadKw: round(demand.rawPeakLoadKw, 1),
      averageSessionNeedKwh: round(demand.averageSessionNeedKwh, 1),
      unmetByPileKwh: round(demand.unmetByPileKwh, 1),
      queueUnmetKwh: round(demand.queueUnmetKwh, 1),
      abandonedCount: demand.abandonedCount,
      fastCount: demand.events.filter((event) => event.tag === "FAST").length,
      slowCount: demand.events.filter((event) => event.tag === "SLOW").length
    },
    weatherSummary: params.weatherSummary,
    chartData: {
      ...buildM1ChartData(demand, selected.simulation),
      chartMeaning: "baseline_weighted_average_weather_standard_week"
    },
    sourceParams: {
      climateKey: params.climateKey,
      evCount: params.evCount,
      teacherRatio: params.teacherRatio,
      targetSocMean: params.targetSocMean,
      renewableTarget: params.renewableTarget
    }
  };
}
