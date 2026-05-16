import { CITY_CLIMATE_DATA } from "../config/climate-data.js";
const SCHOOL_SCENARIO = [
  0.01,0.01,0.01,0.01,0.01,0.02,0.12,0.20,0.10,0.05,0.05,0.10,
  0.15,0.08,0.04,0.08,0.15,0.10,0.05,0.02,0.02,0.01,0.01,0.01
];

const GZ = {
    panelEfficiency: 0.21, workdayDays: 250, holidayDays: 115,
    monthlyOccupancy: [0.5, 0.05, 1.0, 1.0, 1.0, 0.5, 0.05, 0.05, 1.0, 1.0, 1.0, 0.5],
    monthlyRainProb: [0.065, 0.15, 0.25, 0.40, 0.516, 0.667, 0.60, 0.60, 0.50, 0.30, 0.20, 0.10],
    monthlyHPS: [126.5, 114.2, 131.1, 126.9, 165.5, 160.2, 165.5, 165.5, 160.2, 141.4, 136.8, 126.5],
    rainOutputRange: [0.10, 0.30], efficiencyDirect: 0.92, electricityPrice: 0.65,
    gridTouPrice: { valley: 0.28, flat: 0.65, peak: 0.85 },
    hourlyPvShape: [0,0,0,0,0,0, 0.05, 0.2, 0.5, 0.8, 1.0, 0.95, 0.8, 0.5, 0.2, 0.05, 0,0,0,0,0,0,0,0]
  };

function getGridTouPrice(hour, touPrice = GZ.gridTouPrice) {
    if (hour < 8) return touPrice.valley;
    if ((hour >= 10 && hour < 12) || (hour >= 14 && hour < 19)) return touPrice.peak;
    return touPrice.flat;
  }

function getStorageUnitPrice(E_kWh, basePrice) {
    let price;
    if (E_kWh <= 500) price = 1.10 + (500 - E_kWh) * 0.0004;
    else if (E_kWh <= 1500) price = 0.85 + (1500 - E_kWh) * 0.000125;
    else if (E_kWh <= 3000) price = 0.70 + (3000 - E_kWh) * 0.000067;
    else price = 0.65 + Math.max(0, (4000 - E_kWh)) * 0.000025;
    return Math.max(0.5, price * (basePrice / 1.0));
  }

function calculateDCF_LCOE(C_total_yuan, C_battery_yuan, annualServedKwhFromStdWeek, gridCostYear) {
    const r = 0.05, dE = 0.01, gOm = 0.025, gE = 0.025;
    let num = C_total_yuan, den = 0;
    for (let y = 1; y <= 20; y++) {
      const Ey = annualServedKwhFromStdWeek * Math.pow(1 - dE, y - 1);
      den += Ey / Math.pow(1 + r, y);
      num += (0.015 * C_total_yuan * Math.pow(1 + gOm, y - 1) + gridCostYear * Math.pow(1 + gE, y - 1)) / Math.pow(1 + r, y);
      if (y === 10) num += (0.48 * C_battery_yuan) / Math.pow(1 + r, y);
    }
    return den > 0 ? num / den : Infinity;
  }

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

function percentile(values, p) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((sorted.length - 1) * p)));
    return sorted[idx];
  }

function normalFrom(random, mean, stdDev) {
    const u = 1 - random();
    const v = random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v) * stdDev + mean;
  }

function buildPvShape96() {
    const shape = [];
    for (let t = 0; t < 96; t++) {
      const hour = Math.floor(t / 4);
      const sub = (t % 4) / 4;
      const cur = GZ.hourlyPvShape[hour] || 0;
      const next = GZ.hourlyPvShape[Math.min(23, hour + 1)] || 0;
      shape.push(cur + (next - cur) * sub);
    }
    return shape;
  }

function buildBottomUpDemand(params) {
    const random = seededRandom(20260512);
    const randomRange = (min, max) => min + random() * (max - min);
    const fixedRatio = clamp(Number.isFinite(params.teacherRatio) ? params.teacherRatio : 0.8, 0, 1);
    const anxietyRatio = Number.isFinite(params.anxietyRatio) ? params.anxietyRatio : 0.2;
    const targetSocMean = Number.isFinite(params.targetSocMean) ? params.targetSocMean : 0.95;
    const fixedFleetCount = Math.round(params.evCount * fixedRatio);
    const baseVisitorCount = Math.max(0, params.evCount - fixedFleetCount);
    const weekendFactor = clamp(Number.isFinite(params.holidayRatio) ? params.holidayRatio : 0.1, 0, 1);
    const dayFactors = [1, 1, 1, 1, 1, weekendFactor, weekendFactor];
    const evs = [];
    const T = 96 * 7;
    const rawLoadCurve = Array(T).fill(0);
    const rawFastOcc = Array(T).fill(0);
    const rawSlowOcc = Array(T).fill(0);
    let totalWeekKwh = 0, fastCount = 0, slowCount = 0, totalDwell = 0, unmetByDwell = 0;
    let activeFixedCount = 0, activeVisitorCount = 0, visitorEventCount = 0;

    const fixedFleet = [];
    for (let i = 0; i < fixedFleetCount; i++) {
      const capacity = randomRange(60, 100);
      const consumption = randomRange(10, 20);
      const meanDailyKm = randomRange(10, 60);
      const chargeThreshold = randomRange(0.10, 0.40);
      const targetSocBase = clamp(normalFrom(random, targetSocMean, 0.05), 0.80, 1.00);
      const dailyEnergy = meanDailyKm * consumption / 100;
      fixedFleet.push({
        id: i, capacity, consumption, meanDailyKm, chargeThreshold, targetSocBase,
        dailyEnergy,
        soc: clamp(randomRange(chargeThreshold, targetSocBase), 0.08, 1.00)
      });
    }

    const addEvent = (ev) => {
      evs.push(ev);
      totalWeekKwh += ev.energyNeed;
      totalDwell += ev.dwellHours;
      if (ev.energyNeed > 0 && ev.group === 'fixed') activeFixedCount++;
      if (ev.energyNeed > 0 && ev.group === 'visitor') activeVisitorCount++;
      if (ev.tag === 'FAST' && ev.energyNeed > 0) fastCount++;
      else if (ev.tag === 'SLOW' && ev.energyNeed > 0) slowCount++;
      if (ev.energyNeed <= 0) return;
      const start = clamp(Math.floor(ev.arriveHour * 4), 0, T - 1);
      const leave = clamp(Math.ceil(ev.leaveHour * 4), start + 1, T);
      const duration = Math.ceil(ev.energyNeed / (ev.power * 0.25));
      const end = Math.min(T, leave, start + duration);
      const delivered = Math.max(0, end - start) * ev.power * 0.25;
      unmetByDwell += Math.max(0, ev.energyNeed - delivered);
      for (let t = start; t < end; t++) {
        rawLoadCurve[t] += ev.power;
        if (ev.tag === 'FAST') rawFastOcc[t] += 1;
        else rawSlowOcc[t] += 1;
      }
    };

    for (let day = 0; day < 7; day++) {
      const dayOffsetHour = day * 24;
      const dayFactor = dayFactors[day];

      fixedFleet.forEach(car => {
        if (random() > dayFactor) return;
        car.soc = clamp(car.soc - (car.dailyEnergy / car.capacity), 0.03, 1.00);
        if (car.soc > car.chargeThreshold) return;
        const targetSoc = clamp(normalFrom(random, car.targetSocBase, 0.035), 0.80, 1.00);
        const energyNeed = Math.max(car.dailyEnergy, car.capacity * Math.max(0, targetSoc - car.soc));
        const arriveLocal = clamp(normalFrom(random, 8.4, 0.55), 7, 10);
        const leaveLocal = clamp(normalFrom(random, 17.6, 0.65), arriveLocal + 6, 20);
        const dwellHours = leaveLocal - arriveLocal;
        const isAnxious = random() < anxietyRatio;
        const slowHours = energyNeed / 7;
        const mustFast = slowHours > Math.max(0.5, dwellHours);
        const tag = (mustFast || (isAnxious && random() < 0.35)) ? 'FAST' : 'SLOW';
        const power = tag === 'FAST' ? 30 : 7;
        addEvent({
          id: car.id, day, group: 'fixed', tag, isTeacher: true, isAnxious,
          capacity: car.capacity, consumption: car.consumption, meanDailyKm: car.meanDailyKm,
          chargeThreshold: car.chargeThreshold, initSoc: car.soc, targetSoc,
          arriveHour: dayOffsetHour + arriveLocal, plugInHour: dayOffsetHour + arriveLocal,
          leaveHour: dayOffsetHour + leaveLocal, dwellHours, energyNeed, power,
          slackHours: dwellHours - (energyNeed / Math.max(1, power))
        });
        car.soc = targetSoc;
      });

      const visitorCountToday = Math.round(baseVisitorCount * dayFactor);
      visitorEventCount += visitorCountToday;
      for (let j = 0; j < visitorCountToday; j++) {
        const capacity = randomRange(50, 95);
        const initSoc = randomRange(0.20, 0.70);
        const targetSoc = clamp(normalFrom(random, 0.78, 0.08), 0.60, 0.92);
        const arriveLocal = clamp(normalFrom(random, random() < 0.55 ? 10.8 : 14.5, 1.15), 8.5, 17);
        const dwellHours = clamp(normalFrom(random, 2.4, 0.9), 0.75, 5);
        const leaveLocal = clamp(arriveLocal + dwellHours, arriveLocal + 0.5, 20);
        const wantsCharge = initSoc < 0.45 || random() < 0.35;
        const energyNeed = wantsCharge ? Math.max(0, capacity * (targetSoc - initSoc)) : 0;
        const mustFast = dwellHours < energyNeed / 7;
        const tag = (mustFast || random() < 0.55) ? 'FAST' : 'SLOW';
        const power = tag === 'FAST' ? 30 : 7;
        addEvent({
          id: fixedFleetCount + day * Math.max(1, baseVisitorCount) + j, day,
          group: 'visitor', tag, isTeacher: false, isAnxious: true,
          capacity, initSoc, targetSoc,
          arriveHour: dayOffsetHour + arriveLocal,
          leaveHour: dayOffsetHour + leaveLocal,
          dwellHours, energyNeed, power,
          slackHours: dwellHours - (energyNeed / Math.max(1, power))
        });
      }
    }

    const fastSla = Number.isFinite(params.slaFast) ? params.slaFast : 0.95;
    const slowSla = Number.isFinite(params.slaSlow) ? params.slaSlow : 0.85;
    const fastSlaPiles = fastCount > 0 ? Math.max(1, Math.ceil(percentile(rawFastOcc, fastSla))) : 0;
    const slowSlaPiles = slowCount > 0 ? Math.ceil(percentile(rawSlowOcc, slowSla)) : 0;
    const maxTotalPiles = params.evCount > 0 ? Math.max(1, Math.ceil(params.evCount / Math.max(1, params.evRatio))) : 0;
    const n30 = Math.min(fastSlaPiles, maxTotalPiles);
    const n7 = Math.max(0, Math.min(slowSlaPiles, maxTotalPiles - n30));
    const service = simulatePileService(evs, n30, n7, T);

    return {
      evs, loadCurve: service.loadCurve, rawLoadCurve,
      fastOccupancy: service.fastOccupancy, slowOccupancy: service.slowOccupancy,
      rawFastOccupancy: rawFastOcc, rawSlowOccupancy: rawSlowOcc,
      n30, n7, totalDailyKwh: service.deliveredEnergy / 7, totalWeekKwh: service.deliveredEnergy, unmetByDwell,
      stats: {
        avgNeed: (activeFixedCount + activeVisitorCount) ? totalWeekKwh / (activeFixedCount + activeVisitorCount) : 0,
        avgDwell: evs.length ? totalDwell / evs.length : 0,
        fastCount, slowCount,
        peakLoad: Math.max(...service.loadCurve),
        rawPeakLoad: Math.max(...rawLoadCurve),
        totalDailyKwh: service.deliveredEnergy / 7,
        totalWeekKwh: service.deliveredEnergy,
        rawDailyKwh: totalWeekKwh / 7,
        rawWeekKwh: totalWeekKwh,
        unmetByDwell,
        unmetByPile: service.unmetEnergy,
        queueUnmet: service.queueUnmet,
        abandonedCount: service.abandonedCount,
        fastSla,
        slowSla,
        fastOccPctl: percentile(rawFastOcc, fastSla),
        slowOccPctl: percentile(rawSlowOcc, slowSla),
        fastSlaPiles,
        slowSlaPiles,
        maxTotalPiles,
        cappedByEvRatio: (fastSlaPiles + slowSlaPiles) > maxTotalPiles,
        fixedCount: fixedFleetCount,
        visitorCount: visitorEventCount,
        activeFixedCount,
        activeVisitorCount,
        horizonDays: 7
      }
    };
  }

function simulatePileService(evs, n30, n7, totalTicks) {
    const loadCurve = Array(totalTicks).fill(0);
    const fastOccupancy = Array(totalTicks).fill(0);
    const slowOccupancy = Array(totalTicks).fill(0);
    const queueFast = [];
    const queueSlow = [];
    const activeFast = [];
    const activeSlow = [];
    const eventsByStart = new Map();
    let deliveredEnergy = 0, unmetEnergy = 0, queueUnmet = 0, abandonedCount = 0;

    evs.filter(ev => ev.energyNeed > 0).forEach(ev => {
      const startTick = clamp(Math.floor(ev.arriveHour * 4), 0, totalTicks - 1);
      const leaveTick = clamp(Math.ceil(ev.leaveHour * 4), startTick + 1, totalTicks);
      const item = {
        id: ev.id, group: ev.group, tag: ev.tag, power: ev.power,
        startTick, leaveTick, remaining: ev.energyNeed, initialNeed: ev.energyNeed
      };
      if (!eventsByStart.has(startTick)) eventsByStart.set(startTick, []);
      eventsByStart.get(startTick).push(item);
    });

    const dropExpired = (queue, tick) => {
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].leaveTick <= tick) {
          queueUnmet += Math.max(0, queue[i].remaining);
          unmetEnergy += Math.max(0, queue[i].remaining);
          abandonedCount++;
          queue.splice(i, 1);
        }
      }
    };
    const fillSlots = (queue, active, capacity, tick) => {
      while (active.length < capacity && queue.length) {
        const ev = queue.shift();
        if (ev.leaveTick <= tick) {
          queueUnmet += Math.max(0, ev.remaining);
          unmetEnergy += Math.max(0, ev.remaining);
          abandonedCount++;
        } else {
          active.push(ev);
        }
      }
    };
    const chargeActive = (active, tick, occCurve) => {
      for (let i = active.length - 1; i >= 0; i--) {
        const ev = active[i];
        if (ev.leaveTick <= tick || ev.remaining <= 1e-6) {
          if (ev.remaining > 1e-6) unmetEnergy += ev.remaining;
          active.splice(i, 1);
        }
      }
      for (let i = active.length - 1; i >= 0; i--) {
        const ev = active[i];
        const delivered = Math.min(ev.remaining, ev.power * 0.25);
        ev.remaining -= delivered;
        deliveredEnergy += delivered;
        loadCurve[tick] += delivered / 0.25;
        occCurve[tick] += 1;
        if (ev.remaining <= 1e-6) active.splice(i, 1);
      }
    };

    for (let tick = 0; tick < totalTicks; tick++) {
      const arrivals = eventsByStart.get(tick) || [];
      arrivals.forEach(ev => {
        if (ev.tag === 'FAST') queueFast.push(ev);
        else queueSlow.push(ev);
      });
      dropExpired(queueFast, tick);
      dropExpired(queueSlow, tick);
      fillSlots(queueFast, activeFast, n30, tick);
      fillSlots(queueSlow, activeSlow, n7, tick);
      chargeActive(activeFast, tick, fastOccupancy);
      chargeActive(activeSlow, tick, slowOccupancy);
    }

    [...queueFast, ...queueSlow, ...activeFast, ...activeSlow].forEach(ev => {
      if (ev.remaining > 1e-6) {
        unmetEnergy += ev.remaining;
        if (ev.startTick < totalTicks) abandonedCount++;
      }
    });

    return {
      loadCurve,
      fastOccupancy,
      slowOccupancy,
      deliveredEnergy,
      unmetEnergy,
      queueUnmet,
      abandonedCount
    };
  }

function simulateStorage96(P_pv, E_storage_cap, P_storage_limit, loadCurve, effectivePvEfficiency, pvShape96, touPrice = GZ.gridTouPrice) {
    let currentSOC = E_storage_cap * 0.2, greenSOC = 0, maxGridPower = 0, totalCurtailed = 0, totalPvGen = 0;
    let totalLoadEnergy = 0, gridBuy = 0, gridCost = 0, renewableToLoad = 0, pvDirectToLoad = 0, batteryToLoad = 0;
    const soc = [];
    const pv = [];
    for (let t = 0; t < loadCurve.length; t++) {
      const pvPower = P_pv * pvShape96[t % pvShape96.length] * effectivePvEfficiency;
      const loadPower = loadCurve[t] || 0;
      const loadEnergy = loadPower * 0.25;
      totalLoadEnergy += loadEnergy;
      pv.push(pvPower);
      totalPvGen += pvPower * 0.25;
      const standbyLoss = P_storage_limit * 0.005 * 0.25;
      let pvEnergy = Math.max(0, pvPower * 0.25 - standbyLoss);
      const directPv = Math.min(loadEnergy, pvEnergy);
      pvEnergy -= directPv;
      let remainingLoad = loadEnergy - directPv;
      pvDirectToLoad += directPv;
      renewableToLoad += directPv;

      if (remainingLoad > 0) {
        const discharge = Math.min(remainingLoad, P_storage_limit * 0.25, Math.max(0, currentSOC - E_storage_cap * 0.05));
        const greenDischarge = Math.min(discharge, greenSOC);
        currentSOC -= discharge;
        greenSOC -= greenDischarge;
        remainingLoad -= discharge;
        batteryToLoad += discharge;
        renewableToLoad += greenDischarge;
      }

      if (remainingLoad > 0) {
        gridBuy += remainingLoad;
        gridCost += remainingLoad * getGridTouPrice(Math.floor((t % 96) / 4), touPrice);
        maxGridPower = Math.max(maxGridPower, remainingLoad / 0.25);
        remainingLoad = 0;
      }

      if (pvEnergy > 0) {
        const charge = Math.min(pvEnergy, P_storage_limit * 0.25, E_storage_cap - currentSOC);
        currentSOC += charge;
        greenSOC = Math.min(currentSOC, greenSOC + charge);
        totalCurtailed += Math.max(0, pvEnergy - charge);
      } else {
        totalCurtailed += 0;
      }
      soc.push(E_storage_cap > 0 ? (currentSOC / E_storage_cap) * 100 : 0);
    }
    const renewableShare = totalLoadEnergy > 0 ? renewableToLoad / totalLoadEnergy : 0;
    return {
      maxGridPower,
      gridBuy,
      gridCost,
      totalLoadEnergy,
      totalPvGen,
      totalCurtailed,
      renewableToLoad,
      renewableShare,
      pvDirectToLoad,
      batteryToLoad,
      unmetDemand: 0,
      chart: { pv, ev: loadCurve, soc },
      curtailmentRate: totalPvGen > 0 ? (totalCurtailed / totalPvGen) * 100 : 0
    };
  }

function buildMonthlyPvShape96(month, baseShape96, climate) {
    const monthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const shapeDailyHps = baseShape96.reduce((sum, v) => sum + v * 0.25, 0) || 1;
    const monthlyHps = climate?.monthlyHPS || GZ.monthlyHPS.map((v, i) => v / monthDays[i]);
    const targetDailyHps = monthlyHps[month];
    const scale = targetDailyHps / shapeDailyHps;
    return baseShape96.map(v => v * scale);
  }

function simulateAnnualStandardWeeks(P_pv, E_storage_cap, P_storage_limit, loadCurve, effectivePvEfficiency, baseShape96, climate) {
    const monthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const points = loadCurve.length;
    const chart = { pv: Array(points).fill(0), ev: Array(points).fill(0), soc: Array(points).fill(0) };
    let gridBuyAnnual = 0, gridCostAnnual = 0, renewableToLoadAnnual = 0, totalLoadAnnual = 0;
    let pvDirectToLoadAnnual = 0, batteryToLoadAnnual = 0, totalPvAnnual = 0, totalCurtailedAnnual = 0;
    let maxGridPower = 0;
    const totalWeight = monthDays.reduce((sum, days) => sum + days / 7, 0);

    for (let month = 0; month < 12; month++) {
      const weight = monthDays[month] / 7;
      const sim = simulateStorage96(P_pv, E_storage_cap, P_storage_limit, loadCurve, effectivePvEfficiency, buildMonthlyPvShape96(month, baseShape96, climate), climate?.gridTouPrice || GZ.gridTouPrice);
      gridBuyAnnual += sim.gridBuy * weight;
      gridCostAnnual += sim.gridCost * weight;
      renewableToLoadAnnual += sim.renewableToLoad * weight;
      totalLoadAnnual += sim.totalLoadEnergy * weight;
      pvDirectToLoadAnnual += sim.pvDirectToLoad * weight;
      batteryToLoadAnnual += sim.batteryToLoad * weight;
      totalPvAnnual += sim.totalPvGen * weight;
      totalCurtailedAnnual += sim.totalCurtailed * weight;
      maxGridPower = Math.max(maxGridPower, sim.maxGridPower);
      for (let i = 0; i < points; i++) {
        chart.pv[i] += sim.chart.pv[i] * weight / totalWeight;
        chart.ev[i] += sim.chart.ev[i] * weight / totalWeight;
        chart.soc[i] += sim.chart.soc[i] * weight / totalWeight;
      }
    }

    return {
      maxGridPower,
      gridBuyAnnual,
      gridCostAnnual,
      renewableToLoad: renewableToLoadAnnual,
      renewableShare: totalLoadAnnual > 0 ? renewableToLoadAnnual / totalLoadAnnual : 0,
      pvDirectToLoad: pvDirectToLoadAnnual,
      batteryToLoad: batteryToLoadAnnual,
      totalLoadEnergyAnnual: totalLoadAnnual,
      chart,
      curtailmentRate: totalPvAnnual > 0 ? (totalCurtailedAnnual / totalPvAnnual) * 100 : 0
    };
  }

function mipSolve(params) {
    if (params.evCount === 0) {
      return {
        P_pv: 0, E_storage: 0, P_storage: 0, C_total: 0,
        C_pv: 0, C_storage_energy: 0, C_storage_power: 0, C_charger: 0, C_ems: params.ems,
        n7: 0, n30: 0, mathPeak: 0, lcoe: 0, paybackYears: 0, pvArea: 0,
        chartData: { pv: Array(96).fill(0), ev: Array(96).fill(0), soc: Array(96).fill(0), fastOcc: Array(96).fill(0), slowOcc: Array(96).fill(0) },
        curtailmentRate: 0,
        renewableShare: 0,
        gridBuyDaily: 0,
        gridBuyAnnual: 0,
        agentStats: { avgNeed: 0, avgDwell: 0, fastCount: 0, slowCount: 0, peakLoad: 0, totalDailyKwh: 0, unmetByDwell: 0 }
      };
    }

    const demand = buildBottomUpDemand(params);
    const avgDailyKwh = demand.totalDailyKwh;
    const standardWeekKwh = demand.totalWeekKwh || (avgDailyKwh * 7);
    const weeksPerYear = 365 / 7;
    const annualServedKwhFromStdWeek = standardWeekKwh * weeksPerYear;
    const effectivePvEfficiency = params.pvEfficiency * GZ.efficiencyDirect;
    const pvShape96 = buildPvShape96();
    const climate = params.climate || null;
    const dynamicPvMax = Math.min(Math.max(2000, avgDailyKwh * 4), params.roofArea / 6.5);
    const mathPeak = demand.stats.peakLoad;
    const n30 = demand.n30;
    const n7 = demand.n7;
    const C_charger = n7 * params.cost7kw + n30 * params.cost30kw;

    let bestLcoe = Infinity, bestPv = 0, bestStorage = 0, bestPower = 0, bestChart = null, bestCurtailment = 0, bestSim = null;
    let bestRelaxed = null;
    const minStorage = params.backupDays > 0 ? avgDailyKwh * params.backupDays : 0;
    const maxStorage = Math.max(100, avgDailyKwh * 4 + minStorage);

    for (let E_storage = minStorage; E_storage <= maxStorage; E_storage += 100) {
      const initP = E_storage > 0 ? E_storage / 4 : 0;
      for (let P_pv = 0; P_pv <= dynamicPvMax; P_pv += 20) {
        const sim = simulateAnnualStandardWeeks(P_pv, E_storage, initP, demand.loadCurve, effectivePvEfficiency, pvShape96, climate);
        const actP = initP;
        const C_pv_yuan = P_pv * 1000 * params.pvPrice * (1 + params.pvRate / 100);
        const C_energy_yuan = E_storage * 1000 * getStorageUnitPrice(E_storage, params.storBasePrice) * (1 + params.storRate / 100);
        const C_power_yuan = actP * 450 * (1 + params.storRate / 100);
        const C_total_yuan = C_pv_yuan + C_energy_yuan + C_power_yuan + params.ems * 10000 + C_charger * 10000;
        const gridCostYear = sim.gridCostAnnual;
        const currentLcoe = calculateDCF_LCOE(C_total_yuan, C_energy_yuan, annualServedKwhFromStdWeek, gridCostYear);
        const shortfall = Math.max(0, params.renewableTarget - sim.renewableShare);
        if (!bestRelaxed || shortfall < bestRelaxed.shortfall || (shortfall === bestRelaxed.shortfall && currentLcoe < bestRelaxed.lcoe)) {
          bestRelaxed = { P_pv, E_storage, actP, sim, lcoe: currentLcoe, shortfall };
        }
        if (shortfall > 1e-6) continue;
        if (currentLcoe < bestLcoe) {
          bestLcoe = currentLcoe;
          bestPv = P_pv;
          bestStorage = E_storage;
          bestPower = actP;
          bestChart = sim.chart;
          bestCurtailment = sim.curtailmentRate;
          bestSim = sim;
        }
      }
    }

    if (!bestSim && bestRelaxed) {
      bestPv = bestRelaxed.P_pv;
      bestStorage = bestRelaxed.E_storage;
      bestPower = bestRelaxed.actP;
      bestLcoe = bestRelaxed.lcoe;
      bestSim = bestRelaxed.sim;
      bestChart = bestRelaxed.sim.chart;
      bestCurtailment = bestRelaxed.sim.curtailmentRate;
    }

    const storUnitPrice = getStorageUnitPrice(bestStorage, params.storBasePrice);
    const C_energy = bestStorage * 1000 * storUnitPrice * (1 + params.storRate / 100);
    const C_power = bestPower * 450 * (1 + params.storRate / 100);
    const C_pv = bestPv * 1000 * params.pvPrice * (1 + params.pvRate / 100);
    const C_total = C_pv + C_energy + C_power + params.ems * 10000 + C_charger * 10000;
    const finalSim = bestSim || simulateAnnualStandardWeeks(bestPv, bestStorage, bestPower, demand.loadCurve, effectivePvEfficiency, pvShape96, climate);
    const finalLcoe = Number.isFinite(bestLcoe) ? bestLcoe : calculateDCF_LCOE(C_total, C_energy, annualServedKwhFromStdWeek, finalSim.gridCostAnnual);
    const totalOpCost = C_total * 0.015 + finalSim.gridCostAnnual;

    if (!bestChart) {
      const fallback = simulateAnnualStandardWeeks(bestPv, bestStorage, bestPower, demand.loadCurve, effectivePvEfficiency, pvShape96, climate);
      bestChart = fallback.chart;
      bestCurtailment = fallback.curtailmentRate;
      bestSim = fallback;
    }
    bestChart.rawDemand = demand.rawLoadCurve;
    bestChart.fastOcc = demand.fastOccupancy;
    bestChart.slowOcc = demand.slowOccupancy;
    bestChart.fastSlaLine = Array(demand.loadCurve.length).fill(demand.n30);
    bestChart.slowSlaLine = Array(demand.loadCurve.length).fill(demand.n7);

    return {
      P_pv: bestPv, E_storage: bestStorage, P_storage: bestPower, C_total: C_total / 10000,
      C_pv: C_pv / 10000, C_storage_energy: C_energy / 10000, C_storage_power: C_power / 10000,
      C_charger: C_charger, n7: n7, n30: n30, mathPeak: mathPeak,
      C_ems: params.ems, lcoe: finalLcoe,
      paybackYears: ((annualServedKwhFromStdWeek * GZ.electricityPrice) - totalOpCost) > 0 ? C_total / ((annualServedKwhFromStdWeek * GZ.electricityPrice) - totalOpCost) : 999,
      pvArea: (bestPv / GZ.panelEfficiency) * 1.25,
      chartData: bestChart,
      curtailmentRate: bestCurtailment,
      renewableShare: finalSim.renewableShare,
      gridBuyDaily: finalSim.gridBuyAnnual / 365,
      gridBuyAnnual: finalSim.gridBuyAnnual,
      gridCostDaily: finalSim.gridCostAnnual / 365,
      gridCostAnnual: finalSim.gridCostAnnual,
      pvDirectToLoad: finalSim.pvDirectToLoad,
      batteryToLoad: finalSim.batteryToLoad,
      climate: climate ? { zone: climate.zone, city: climate.city, annualSolar: climate.annualSolar, avgSolar: climate.avgSolar, annualPrecip: climate.annualPrecip, avgTemp: climate.avgTemp, gridTouPrice: climate.gridTouPrice } : null,
      agentStats: demand.stats,
      fastOccupancy: demand.fastOccupancy,
      slowOccupancy: demand.slowOccupancy
    };
  }

function seededRandom(seed) {
    let t = seed >>> 0;
    return function() {
      t += 0x6D2B79F5;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }
function round(value, digits = 2) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function normalizeM1Input(input) {
  const source = input?.m1 || {};
  const climateKey = source.climateKey || "guangzhou";
  const climate = CITY_CLIMATE_DATA[climateKey] || CITY_CLIMATE_DATA.guangzhou;
  const batteryCapMean = Number(source.batteryCapMean ?? 65);
  const initSocMean = Number(source.initSocMean ?? 0.40);
  const targetSocMean = Number(source.targetSocMean ?? 0.95);

  return {
    evShapeRaw: SCHOOL_SCENARIO,
    climateKey,
    climate,
    renewableTarget: Number(source.renewableTarget ?? 0.50),
    evCount: Number(source.evCount ?? 100),
    teacherRatio: Number(source.teacherRatio ?? 0.80),
    batteryCapMean,
    initSocMean,
    targetSocMean,
    slaFast: Number(source.slaFast ?? 0.95),
    slaSlow: Number(source.slaSlow ?? 0.85),
    mileage: Number(source.mileage ?? 30),
    consumption: Number(source.consumption ?? 15),
    sessionKwh: Math.max(0, batteryCapMean * Math.max(0, targetSocMean - initSocMean)),
    backupDays: Number(source.backupDays ?? 0),
    holidayRatio: Number(source.holidayRatio ?? 0.10),
    pvEfficiency: Number(source.pvEfficiency ?? 0.72),
    pvPrice: Number(source.pvPrice ?? 1.50),
    pvRate: Number(source.pvRate ?? 15),
    storBasePrice: Number(source.storBasePrice ?? 1.00),
    storRate: Number(source.storRate ?? 12),
    ems: Number(source.ems ?? 10),
    roofArea: Number(source.roofArea ?? 10000),
    evRatio: Number(source.evRatio ?? 3),
    fastRatio: 0,
    cost7kw: Number(source.cost7kw ?? 0.30),
    cost30kw: Number(source.cost30kw ?? 2.50),
    anxietyRatio: Number(source.anxietyRatio ?? 0.20)
  };
}

function mapToM1Result(raw, params) {
  return {
    contract: "M1Result",
    summary: {
      title: "标准周基准规划已完成",
      city: raw.climate?.city || params.climate?.city || "未知城市",
      climateZone: raw.climate?.zone || params.climate?.zone || "--",
      renewableTarget: params.renewableTarget
    },
    hardwarePlan: {
      pvKw: round(raw.P_pv, 1),
      storageKwh: round(raw.E_storage, 1),
      pcsKw: round(raw.P_storage, 1),
      n7kw: raw.n7,
      n30kw: raw.n30,
      pvAreaM2: round(raw.pvArea, 1)
    },
    economics: {
      capexWan: round(raw.C_total, 2),
      pvCapexWan: round(raw.C_pv, 2),
      storageEnergyCapexWan: round(raw.C_storage_energy, 2),
      storagePowerCapexWan: round(raw.C_storage_power, 2),
      chargerCapexWan: round(raw.C_charger, 2),
      emsCapexWan: round(raw.C_ems, 2),
      lcoeYuanPerKwh: round(raw.lcoe, 3),
      paybackYears: raw.paybackYears >= 999 ? 999 : round(raw.paybackYears, 1)
    },
    energyPerformance: {
      renewableShare: round(raw.renewableShare, 4),
      curtailmentRatePct: round(raw.curtailmentRate, 2),
      gridBuyDailyKwh: round(raw.gridBuyDaily, 1),
      gridBuyAnnualKwh: round(raw.gridBuyAnnual, 1),
      gridCostDailyYuan: round(raw.gridCostDaily, 1),
      gridCostAnnualYuan: round(raw.gridCostAnnual, 1)
    },
    demandProfile: {
      totalDailyKwh: round(raw.agentStats?.totalDailyKwh ?? 0, 1),
      peakLoadKw: round(raw.mathPeak ?? raw.agentStats?.peakLoad ?? 0, 1),
      averageSessionNeedKwh: round(raw.agentStats?.avgNeed ?? 0, 1),
      averageDwellHours: round(raw.agentStats?.avgDwell ?? 0, 1),
      fastCount: raw.agentStats?.fastCount ?? 0,
      slowCount: raw.agentStats?.slowCount ?? 0,
      unmetByDwellKwh: round(raw.agentStats?.unmetByDwell ?? 0, 1)
    },
    chartData: raw.chartData,
    sourceParams: {
      climateKey: params.climateKey,
      evCount: params.evCount,
      teacherRatio: params.teacherRatio,
      targetSocMean: params.targetSocMean,
      renewableTarget: params.renewableTarget
    },
    raw
  };
}

export function runM1Plan(context) {
  const params = normalizeM1Input(context.input);
  const raw = mipSolve(params);
  return mapToM1Result(raw, params);
}
