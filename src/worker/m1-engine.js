import {
  buildDemandProfile,
  buildHardwarePlan,
  buildIrradianceSeries,
  calcCapexWan,
  normalizeProjectInput,
  round,
  simulateEnergyScenario
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

function baselineScore(candidate, simulation, params, annualDemandKwh) {
  const summary = simulation.summary;
  const capex = calcCapexWan(candidate, params);
  const renewableShortfall = Math.max(0, params.renewableTarget - (summary.pvSelfUseRate || 0));
  return {
    unservedKwh: summary.unservedEnergyKwh,
    serviceRate: summary.serviceRate,
    deficitHours: summary.deficitHours,
    socMinPct: summary.socMinPct,
    renewableShortfall,
    capexWan: capex.capexWan,
    lcoeYuanPerKwh: calcLcoeYuanPerKwh(capex.capexWan, annualDemandKwh, 0, params.opexRate)
  };
}

function isBetterBaseline(next, best) {
  if (!best) return true;
  const n = next.score;
  const b = best.score;
  if (n.unservedKwh < b.unservedKwh - 1) return true;
  if (n.unservedKwh > b.unservedKwh + 1) return false;
  if (n.serviceRate > b.serviceRate + 0.001) return true;
  if (n.serviceRate < b.serviceRate - 0.001) return false;
  if (n.deficitHours < b.deficitHours - 1) return true;
  if (n.deficitHours > b.deficitHours + 1) return false;
  if (n.socMinPct > b.socMinPct + 0.5) return true;
  if (n.socMinPct < b.socMinPct - 0.5) return false;
  if (n.renewableShortfall < b.renewableShortfall - 0.005) return true;
  if (n.renewableShortfall > b.renewableShortfall + 0.005) return false;
  return n.capexWan < b.capexWan;
}

function chooseBaseline(params, demand) {
  const candidates = buildCandidateGrid(params, demand);
  const irradiance = buildIrradianceSeries(params, demand.loadCurve.length, { monthIndex: 0, useGTilt: false });
  const annualDemandKwh = demand.totalEnergyKwh * 365 / Math.max(1, demand.horizonDays);
  let best = null;

  candidates.forEach((candidate) => {
    const simulation = simulateEnergyScenario({
      hardware: candidate,
      loadCurve: demand.loadCurve,
      irradiance,
      params,
      scenarioKey: "offgrid_rule"
    });
    const score = baselineScore(candidate, simulation, params, annualDemandKwh);
    const evaluated = { candidate, simulation, score };
    if (isBetterBaseline(evaluated, best)) best = evaluated;
  });

  return { ...best, candidateCount: candidates.length, annualDemandKwh };
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
  const lcoe = calcLcoeYuanPerKwh(capex.capexWan, selected.annualDemandKwh, 0, params.opexRate);

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
      unservedKwh: round(selected.score.unservedKwh, 1),
      unservedRate: summary.demandKwh > 0 ? round(selected.score.unservedKwh / summary.demandKwh, 5) : 0,
      serviceRate: round(selected.score.serviceRate, 5),
      deficitHours: round(selected.score.deficitHours, 1),
      socMinPct: round(selected.score.socMinPct, 1),
      renewableShortfall: round(selected.score.renewableShortfall, 5),
      lcoeYuanPerKwh: round(lcoe, 3)
    },
    offgridBaselineCheck: {
      unservedKwh: round(summary.unservedEnergyKwh, 1),
      deficitHours: round(summary.deficitHours, 1),
      serviceRate: round(summary.serviceRate, 5),
      socMinPct: round(summary.socMinPct, 1),
      renewableShare: round(summary.pvSelfUseRate, 5),
      curtailmentRatePct: round(summary.curtailmentRatePct, 2),
      pvDirectToLoadKwh: round(summary.pvToLoadKwh, 1),
      batteryToLoadKwh: round(summary.batteryToLoadKwh, 1),
      totalLoadEnergyAnnualKwh: round(selected.annualDemandKwh, 1)
    },
    energyPerformance: {
      renewableShare: round(summary.pvSelfUseRate, 5),
      curtailmentRatePct: round(summary.curtailmentRatePct, 2),
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
    chartData: buildM1ChartData(demand, selected.simulation),
    sourceParams: {
      climateKey: params.climateKey,
      evCount: params.evCount,
      teacherRatio: params.teacherRatio,
      targetSocMean: params.targetSocMean,
      renewableTarget: params.renewableTarget
    }
  };
}
