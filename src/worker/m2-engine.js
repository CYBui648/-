import { CITY_CLIMATE_DATA } from "../config/climate-data.js";

const GZ = {
    panelEfficiency: 0.21, workdayDays: 250, holidayDays: 115,
    monthlyOccupancy: [0.5, 0.05, 1.0, 1.0, 1.0, 0.5, 0.05, 0.05, 1.0, 1.0, 1.0, 0.5],
    monthlyRainProb: [0.065, 0.15, 0.25, 0.40, 0.516, 0.667, 0.60, 0.60, 0.50, 0.30, 0.20, 0.10],
    monthlyHPS: [126.5, 114.2, 131.1, 126.9, 165.5, 160.2, 165.5, 165.5, 160.2, 141.4, 136.8, 126.5],
    rainOutputRange: [0.10, 0.30], efficiencyDirect: 0.92, electricityPrice: 0.65,
    gridTouPrice: { valley: 0.28, flat: 0.65, peak: 0.85 },
    hourlyPvShape: [0,0,0,0,0,0, 0.05, 0.2, 0.5, 0.8, 1.0, 0.95, 0.8, 0.5, 0.2, 0.05, 0,0,0,0,0,0,0,0]
  };

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

function percentile(values, p) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((sorted.length - 1) * p)));
    return sorted[idx];
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

function getGridTouPrice(hour, touPrice = GZ.gridTouPrice) {
    if (hour < 8) return touPrice.valley;
    if ((hour >= 10 && hour < 12) || (hour >= 14 && hour < 19)) return touPrice.peak;
    return touPrice.flat;
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

function buildMonthlyPvShape96(month, baseShape96, climate) {
    const monthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const shapeDailyHps = baseShape96.reduce((sum, v) => sum + v * 0.25, 0) || 1;
    const monthlyHps = climate?.monthlyHPS || GZ.monthlyHPS.map((v, i) => v / monthDays[i]);
    const targetDailyHps = monthlyHps[month];
    const scale = targetDailyHps / shapeDailyHps;
    return baseShape96.map(v => v * scale);
  }

function getIrradianceForTick(p, tick, gStartIndex, ticksPerDay) {
    const h = Math.floor((tick % ticksPerDay) / 4);
    const subTick = tick % 4;
    const hourDataIdx = gStartIndex + Math.floor(tick / 4);
    if (p.gTiltData && p.gTiltData.length > hourDataIdx) {
      const currentIrr = parseFloat(p.gTiltData[hourDataIdx]) || 0;
      const nextIrr = (p.gTiltData.length > hourDataIdx + 1) ? (parseFloat(p.gTiltData[hourDataIdx + 1]) || 0) : currentIrr;
      return currentIrr + (nextIrr - currentIrr) * (subTick / 4);
    }
    const monthlyShape = buildMonthlyPvShape96(p.monthIndex || 0, buildPvShape96(), p.climate || null);
    return (monthlyShape[tick % ticksPerDay] || 0) * 1000;
  }

function simulateExtremeLedger(p) {
    const ticksPerDay = 96;
    const monthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const totalDays = monthDays[p.monthIndex], totalTicks = totalDays * ticksPerDay;
    const ledgerSeed = Number.isFinite(p.seed) ? p.seed : 20260513 + (p.monthIndex || 0);
    const random = seededRandom(ledgerSeed);
    const randomRange = (min, max) => min + random() * (max - min);
    const randNormalLocal = (mean, stdDev) => {
      const u = 1 - random(), v = random();
      return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v) * stdDev + mean;
    };
    const fixedRatio = clamp(Number.isFinite(p.teacherRatio) ? p.teacherRatio : 0.8, 0, 1);
    const anxietyRatio = Number.isFinite(p.anxietyRatio) ? p.anxietyRatio : 0.2;
    const targetSocMean = Number.isFinite(p.targetSocMean) ? p.targetSocMean : 0.95;
    const fixedFleetCount = Math.round(p.evCount * fixedRatio);
    const baseVisitorCount = Math.max(0, p.evCount - fixedFleetCount);
    const fixedFleet = [];
    for (let i = 0; i < fixedFleetCount; i++) {
      const capacity = randomRange(60, 100);
      const consumption = randomRange(10, 20);
      const meanDailyKm = randomRange(10, 60);
      const chargeThreshold = randomRange(0.10, 0.40);
      const targetSocBase = clamp(randNormalLocal(targetSocMean, 0.05), 0.80, 1.00);
      const dailyEnergy = meanDailyKm * consumption / 100;
      fixedFleet.push({
        id: i, capacity, consumption, meanDailyKm, chargeThreshold,
        targetSocBase, dailyEnergy,
        soc: clamp(randomRange(chargeThreshold, targetSocBase), 0.08, 1.00)
      });
    }

    const ledger = [];
    const pvSeries = new Float32Array(totalTicks), evSeries = new Float32Array(totalTicks), socSeries = new Float32Array(totalTicks), gridSeries = new Float32Array(totalTicks);
    const queueSeries = new Float32Array(totalTicks), chargingSeries = new Float32Array(totalTicks);
    const virtualFastOcc = new Float32Array(totalTicks), virtualSlowOcc = new Float32Array(totalTicks);
    const fixedReadyConcurrency = new Float32Array(totalTicks); // fixed-car concurrent demand for N_matrix
    const waitingQueue = [], chargingList = [];
    let nextPending = 0, generatedEventCount = 0;
    let overflowCount = 0, blackoutCount = 0, queueUnmet = 0, energyUnmet = 0, deliveredEnergy = 0, demandEnergy = 0, eBuyValley = 0, eBuyFlat = 0, eBuyPeak = 0, gridCost = 0;
    let abandonedCount = 0, departedCount = 0, chargedFullCount = 0, realPeak = 0, queuedPeak = 0, chargingPeak = 0;
    let totalCurtailed = 0, totalPvGen = 0, socMin = 100, soc = p.E_storage * 0.2;
    let gStartIndex = 0;
    for (let m = 0; m < p.monthIndex; m++) gStartIndex += monthDays[m] * 24;

    const closeEv = (ev) => {
      if (ev.car && !ev.socWrittenBack) {
        ev.car.soc = clamp(ev.initSoc + ev.deliveredEnergy / ev.car.capacity, 0.03, ev.targetSoc);
        ev.socWrittenBack = true;
      }
    };

    const enqueueDayEvents = (day) => {
      const dayEvents = [];
      const isWeekend = day % 7 === 5 || day % 7 === 6;
      const dayFactor = clamp(isWeekend ? (p.holidayRatio || 0.1) : 1, 0, 1);
      const dayStart = day * ticksPerDay;
      const pushEvent = (ev) => {
        if (ev.energyNeed <= 0) return;
        demandEnergy += ev.energyNeed;
        const dwellTicks = Math.max(1, ev.leaveTick - ev.arriveTick);
        const minChargeTicks = Math.ceil(ev.energyNeed / (Math.max(1, ev.power) * 0.25));
        const usefulWaitTicks = Math.max(1, dwellTicks - minChargeTicks);
        const maxWaitTicks = ev.type === 'Teacher'
          ? (ev.isAnxious ? Math.max(8, Math.floor(usefulWaitTicks * 0.5)) : usefulWaitTicks)
          : (ev.isAnxious ? Math.max(4, Math.min(8, usefulWaitTicks)) : Math.max(4, Math.min(12, usefulWaitTicks)));
        dayEvents.push({
          ...ev,
          id: ev.id || 'D' + (day + 1) + '_EV' + (++generatedEventCount),
          preferredTag: ev.tag,
          deliveredEnergy: 0,
          waitTicks: 0,
          maxWaitTicks,
          status: 'PENDING'
        });
      };

      fixedFleet.forEach(car => {
        if (random() > dayFactor) return;
        car.soc = clamp(car.soc - (car.dailyEnergy / car.capacity), 0.03, 1.00);
        if (car.soc > car.chargeThreshold) return;
        const targetSoc = clamp(randNormalLocal(car.targetSocBase, 0.035), 0.80, 1.00);
        const energyNeed = Math.max(car.dailyEnergy, car.capacity * Math.max(0, targetSoc - car.soc));
        const arriveHour = clamp(randNormalLocal(8.4, 0.55), 7, 10);
        const dwellHours = clamp(randNormalLocal(8.5, 0.75), 6, 10);
        const arriveTick = dayStart + clamp(Math.floor(arriveHour * 4), 0, ticksPerDay - 1);
        const leaveTick = Math.min((day + 1) * ticksPerDay, arriveTick + Math.max(2, Math.ceil(dwellHours * 4)));
        const isAnxious = random() < anxietyRatio;
        const mustFast = energyNeed / 7 > Math.max(0.5, dwellHours);
        const tag = (mustFast || (isAnxious && random() < 0.35)) ? 'FAST' : 'SLOW';
        pushEvent({
          id: 'F' + car.id + '_D' + (day + 1),
          type: 'Teacher',
          tag,
          mustFast,
          arriveTick,
          leaveTick,
          energyNeed,
          power: tag === 'FAST' ? 30 : 7,
          isAnxious,
          initSoc: car.soc,
          targetSoc,
          car
        });
      });

      const visitorCountToday = Math.round(baseVisitorCount * dayFactor);
      for (let i = 0; i < visitorCountToday; i++) {
        const capacity = randomRange(50, 95);
        const initSoc = randomRange(0.20, 0.70);
        const targetSoc = clamp(randNormalLocal(0.78, 0.08), 0.60, 0.92);
        const arriveHour = clamp(randNormalLocal(random() < 0.55 ? 10.8 : 14.5, 1.15), 8.5, 17);
        const dwellHours = clamp(randNormalLocal(2.4, 0.9), 0.75, 5);
        const arriveTick = dayStart + clamp(Math.floor(arriveHour * 4), 0, ticksPerDay - 1);
        const leaveTick = Math.min((day + 1) * ticksPerDay, arriveTick + Math.max(2, Math.ceil(dwellHours * 4)));
        const wantsCharge = initSoc < 0.45 || random() < 0.35;
        const energyNeed = wantsCharge ? Math.max(0, capacity * (targetSoc - initSoc)) : 0;
        const mustFast = dwellHours < energyNeed / 7;
        const tag = (mustFast || random() < 0.55) ? 'FAST' : 'SLOW';
        pushEvent({
          type: 'Visitor',
          tag,
          mustFast,
          arriveTick,
          leaveTick,
          energyNeed,
          power: tag === 'FAST' ? 30 : 7,
          isAnxious: true,
          initSoc,
          targetSoc
        });
      }
      dayEvents.sort((a, b) => a.arriveTick - b.arriveTick);
      ledger.push(...dayEvents);
    };

    for (let tick = 0; tick < totalTicks; tick++) {
      for (let i = chargingList.length - 1; i >= 0; i--) {
        const ev = chargingList[i];
        const done = ev.deliveredEnergy >= ev.energyNeed - 0.001;
        const mustLeave = tick >= ev.leaveTick;
        if (done || mustLeave) {
          chargingList.splice(i, 1);
          ev.status = done ? 'DONE' : 'LEFT_UNMET';
          if (done) chargedFullCount++;
          if (mustLeave && !done) energyUnmet += Math.max(0, ev.energyNeed - ev.deliveredEnergy);
          closeEv(ev);
          departedCount++;
        }
      }

      if (tick % ticksPerDay === 0) enqueueDayEvents(Math.floor(tick / ticksPerDay));

      while (nextPending < ledger.length && ledger[nextPending].arriveTick <= tick) {
        const ev = ledger[nextPending++];
        ev.status = 'WAITING';
        ev.waitStartTick = tick;
        waitingQueue.push(ev);
      }

      let usedFast = chargingList.reduce((s, ev) => s + (ev.tag === 'FAST' ? 1 : 0), 0);
      let usedSlow = chargingList.length - usedFast;
      for (let i = 0; i < waitingQueue.length;) {
        const ev = waitingQueue[i];
        const fastSlot = ev.tag === 'FAST' && usedFast < p.n30;
        const slowSlot = ev.tag === 'SLOW' && usedSlow < p.n7;
        const slowFallback = ev.tag === 'FAST' && !ev.mustFast && usedSlow < p.n7;
        if (fastSlot || slowSlot || slowFallback) {
          waitingQueue.splice(i, 1);
          if (slowFallback && !fastSlot) {
            ev.tag = 'SLOW';
            ev.power = 7;
          }
          ev.status = 'CHARGING';
          ev.plugTick = tick;
          chargingList.push(ev);
          if (ev.tag === 'FAST') usedFast++; else usedSlow++;
        } else {
          i++;
        }
      }

      const h = Math.floor((tick % ticksPerDay) / 4);
      const irradiance = getIrradianceForTick(p, tick, gStartIndex, ticksPerDay);
      const pvPower = p.P_pv * (irradiance / 1000) * p.pvEfficiency * GZ.efficiencyDirect;
      const pvEnergy = pvPower * 0.25;
      const loadPower = chargingList.reduce((s, ev) => s + ev.power, 0);
      const requestedEnergy = loadPower * 0.25;
      totalPvGen += pvEnergy;

      const standbyLoss = p.P_storage * 0.005 * 0.25;
      let availableEnergy = pvEnergy - standbyLoss;
      if (availableEnergy < requestedEnergy) {
        const discharge = Math.min(requestedEnergy - availableEnergy, p.P_storage * 0.25, Math.max(0, soc - p.E_storage * 0.05));
        soc -= discharge;
        availableEnergy += discharge;
      }
      if (availableEnergy < requestedEnergy) {
        const gridNeed = requestedEnergy - availableEnergy;
        const gridBuy = Math.min(gridNeed, Math.max(0, p.transformerLimit) * 0.25);
        availableEnergy += gridBuy;
        gridSeries[tick] = gridBuy / 0.25;
        const gridPrice = getGridTouPrice(h, p.gridTouPrice || p.climate?.gridTouPrice);
        gridCost += gridBuy * gridPrice;
        if (Math.abs(gridPrice - (p.gridTouPrice || p.climate?.gridTouPrice || GZ.gridTouPrice).valley) < 1e-9) eBuyValley += gridBuy;
        else if (Math.abs(gridPrice - (p.gridTouPrice || p.climate?.gridTouPrice || GZ.gridTouPrice).flat) < 1e-9) eBuyFlat += gridBuy;
        else eBuyPeak += gridBuy;
      }
      const actualDelivered = Math.max(0, Math.min(requestedEnergy, availableEnergy));
      if (requestedEnergy > 0 && actualDelivered + 0.025 < requestedEnergy) blackoutCount++;
      if (requestedEnergy > 0 && actualDelivered > 0) {
        for (const ev of chargingList) {
          const share = (ev.power * 0.25 / requestedEnergy) * actualDelivered;
          const before = ev.deliveredEnergy;
          ev.deliveredEnergy = Math.min(ev.energyNeed, ev.deliveredEnergy + share);
          deliveredEnergy += Math.max(0, ev.deliveredEnergy - before);
        }
      }
      if (availableEnergy > requestedEnergy) {
        const surplus = availableEnergy - requestedEnergy;
        const charge = Math.min(surplus, p.P_storage * 0.25, p.E_storage - soc);
        soc += charge;
        totalCurtailed += Math.max(0, surplus - charge);
      }

      for (let i = waitingQueue.length - 1; i >= 0; i--) {
        const ev = waitingQueue[i];
        ev.waitTicks++;
        if (tick >= ev.leaveTick || ev.waitTicks > ev.maxWaitTicks) {
          waitingQueue.splice(i, 1);
          ev.status = 'ABANDONED';
          queueUnmet += ev.energyNeed;
          closeEv(ev);
          abandonedCount++;
        }
      }

      const fastWaiting = waitingQueue.reduce((s, ev) => s + (ev.tag === 'FAST' ? 1 : 0), 0);
      const slowWaiting = waitingQueue.length - fastWaiting;
      virtualFastOcc[tick] = usedFast + fastWaiting;
      virtualSlowOcc[tick] = usedSlow + slowWaiting;
      // Fixed-car concurrent demand: Teacher vehicles in queue + charging, still needing energy
      fixedReadyConcurrency[tick] = waitingQueue.filter(ev => ev.type === 'Teacher').length +
        chargingList.filter(ev => ev.type === 'Teacher' && ev.deliveredEnergy < ev.energyNeed - 0.001).length;
      realPeak = Math.max(realPeak, loadPower);
      queuedPeak = Math.max(queuedPeak, waitingQueue.length);
      chargingPeak = Math.max(chargingPeak, chargingList.length);
      if (loadPower > p.transformerLimit) overflowCount++;
      if (p.E_storage > 0) socMin = Math.min(socMin, soc / p.E_storage * 100);
      pvSeries[tick] = pvPower;
      evSeries[tick] = loadPower;
      socSeries[tick] = p.E_storage > 0 ? soc / p.E_storage * 100 : 0;
      queueSeries[tick] = waitingQueue.length;
      chargingSeries[tick] = chargingList.length;
    }

    for (const ev of chargingList) {
      energyUnmet += Math.max(0, ev.energyNeed - ev.deliveredEnergy);
      closeEv(ev);
    }
    for (const ev of waitingQueue) {
      queueUnmet += Math.max(0, ev.energyNeed);
      closeEv(ev);
      abandonedCount++;
    }
    return {
      chartData: {
        pv: Array.from(pvSeries),
        ev: Array.from(evSeries),
        grid: Array.from(gridSeries),
        soc: Array.from(socSeries),
        queue: Array.from(queueSeries),
        charging: Array.from(chargingSeries)
      },
      overflowCount,
      blackouts: blackoutCount,
      queueUnmet,
      energyUnmet,
      unmetTotal: queueUnmet + energyUnmet,
      demandEnergy,
      realPeak,
      deliveredEnergy,
      eBuyValley,
      eBuyFlat,
      eBuyPeak,
      gridCost,
      abandonedCount,
      departedCount,
      chargedFullCount,
      queuedPeak,
      chargingPeak,
      virtualFastP95: percentile(Array.from(virtualFastOcc), 0.95),
      virtualFastP99: percentile(Array.from(virtualFastOcc), 0.99),
      virtualSlowP95: percentile(Array.from(virtualSlowOcc), 0.95),
      virtualSlowP99: percentile(Array.from(virtualSlowOcc), 0.99),
      fixedReadyP95: Math.ceil(percentile(Array.from(fixedReadyConcurrency), 0.95)),
      fixedReadyP99: Math.ceil(percentile(Array.from(fixedReadyConcurrency), 0.99)),
      fixedReadyMax: Math.ceil(Math.max(...fixedReadyConcurrency)),
      ledgerCount: ledger.length,
      curtailmentRate: totalPvGen > 0 ? totalCurtailed / totalPvGen * 100 : 0,
      socMin: Number.isFinite(socMin) ? socMin : 0,
      seed: ledgerSeed,
      monthName: (p.monthIndex + 1) + String.fromCharCode(26376)
    };
  }
function round(value, digits = 2) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function resolveWorstMonthIndex(gTiltData) {
  if (!Array.isArray(gTiltData) || gTiltData.length < 8760) return 0;
  const monthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const monthlySums = new Array(12).fill(0);
  let cursor = 0;
  for (let month = 0; month < 12; month++) {
    const hours = monthDays[month] * 24;
    for (let h = 0; h < hours; h++) {
      monthlySums[month] += Number(gTiltData[cursor + h] || 0);
    }
    cursor += hours;
  }
  return monthlySums.indexOf(Math.min(...monthlySums));
}

function normalizeM2Input(context) {
  const m1Input = context.input?.m1 || {};
  const m2Input = context.input?.m2 || {};
  const m1Result = context.previousResults?.m1;

  if (!m1Result?.hardwarePlan) {
    throw new Error("M2 缺少 M1Result，无法读取基准硬件方案。");
  }
  if (!Array.isArray(m2Input.gTiltData) || m2Input.gTiltData.length < 8760) {
    throw new Error("请先上传包含 8760 行 G_tilt 数据的 TMY CSV。");
  }

  const monthIndex = m2Input.monthMode === "auto"
    ? resolveWorstMonthIndex(m2Input.gTiltData)
    : Number(m2Input.monthIndex || 0);

  const climate = CITY_CLIMATE_DATA[m1Input.climateKey] || CITY_CLIMATE_DATA.guangzhou;
  const monthNames = ["1月","2月","3月","4月","5月","6月","7月","8月","9月","10月","11月","12月"];

  return {
    P_pv: Number(m1Result.hardwarePlan.pvKw || 0),
    E_storage: Number(m1Result.hardwarePlan.storageKwh || 0),
    P_storage: Number(m1Result.hardwarePlan.pcsKw || 0),
    n7: Number(m1Result.hardwarePlan.n7kw || 0),
    n30: Number(m1Result.hardwarePlan.n30kw || 0),
    monthIndex,
    monthLabel: monthNames[monthIndex] || `${monthIndex + 1}月`,
    seed: 20260513 + monthIndex,
    gTiltData: m2Input.gTiltData,
    transformerLimit: Number(m2Input.transformerLimitKw ?? 500),
    anxietyRatio: Number(m2Input.anxietyRatio ?? m1Input.anxietyRatio ?? 0.20),
    teacherRatio: Number(m2Input.teacherRatio ?? m1Input.teacherRatio ?? 0.80),
    batteryCapMean: Number(m1Input.batteryCapMean ?? 65),
    initSocMean: Number(m1Input.initSocMean ?? 0.40),
    targetSocMean: Number(m1Input.targetSocMean ?? 0.95),
    evCount: Number(m1Input.evCount ?? 100),
    sessionKwh: Number(m1Input.batteryCapMean ?? 65) * Math.max(0, Number(m1Input.targetSocMean ?? 0.95) - Number(m1Input.initSocMean ?? 0.40)),
    holidayRatio: Number(m1Input.holidayRatio ?? 0.10),
    pvEfficiency: Number(m1Input.pvEfficiency ?? 0.72),
    climate
  };
}

function mapToM2Result(raw, params, upstreamM1) {
  const transformerUtilPct = params.transformerLimit > 0
    ? raw.realPeak / params.transformerLimit * 100
    : 0;
  const monthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const pressureMonthDays = monthDays[params.monthIndex] || 30;
  const dailyAccessDemand = pressureMonthDays > 0 ? raw.ledgerCount / pressureMonthDays : 0;

  return {
    contract: "M2Result",
    summary: {
      title: "真实月压力测试已完成",
      monthName: raw.monthName || params.monthLabel,
      monthIndex: params.monthIndex,
      transformerLimitKw: params.transformerLimit,
      transformerUtilPct: round(transformerUtilPct, 1),
      usesM1Hardware: true
    },
    hardwareSnapshot: {
      pvKw: params.P_pv,
      storageKwh: params.E_storage,
      pcsKw: params.P_storage,
      n7kw: params.n7,
      n30kw: params.n30
    },
    riskReport: {
      realPeakKw: round(raw.realPeak, 1),
      overflowCount: raw.overflowCount,
      blackoutCount: raw.blackouts,
      unmetTotalKwh: round(raw.unmetTotal, 1),
      queueUnmetKwh: round(raw.queueUnmet, 1),
      energyUnmetKwh: round(raw.energyUnmet, 1),
      abandonedCount: raw.abandonedCount,
      queuedPeak: raw.queuedPeak,
      chargingPeak: raw.chargingPeak,
      socMinPct: round(raw.socMin, 1)
    },
    energyLedger: {
      demandEnergyKwh: round(raw.demandEnergy, 1),
      deliveredEnergyKwh: round(raw.deliveredEnergy, 1),
      eBuyValleyKwh: round(raw.eBuyValley, 1),
      eBuyFlatKwh: round(raw.eBuyFlat, 1),
      eBuyPeakKwh: round(raw.eBuyPeak, 1),
      gridCostYuan: round(raw.gridCost, 1),
      curtailmentRatePct: round(raw.curtailmentRate, 2)
    },
    occupancyReference: {
      monthlyAccessDemand: raw.ledgerCount,
      dailyAccessDemand: round(dailyAccessDemand, 1),
      recommendedMatrixByDailyAccess: Math.ceil(dailyAccessDemand),
      virtualFastP95: round(raw.virtualFastP95, 1),
      virtualFastP99: round(raw.virtualFastP99, 1),
      virtualSlowP95: round(raw.virtualSlowP95, 1),
      virtualSlowP99: round(raw.virtualSlowP99, 1),
      fixedReadyP95: raw.fixedReadyP95,
      fixedReadyP99: raw.fixedReadyP99,
      fixedReadyMax: raw.fixedReadyMax
    },
    handoffToM3: {
      hasPeakRisk: raw.overflowCount > 0,
      hasServiceRisk: raw.unmetTotal > 0 || raw.abandonedCount > 0,
      hasStorageRisk: raw.socMin < 8,
      preferredReading: "M3 应评估软调度能否消化 M2 暴露的峰值、排队与缺口风险。"
    },
    chartData: raw.chartData,
    sourceParams: {
      monthIndex: params.monthIndex,
      monthLabel: params.monthLabel,
      transformerLimitKw: params.transformerLimit,
      teacherRatio: params.teacherRatio,
      anxietyRatio: params.anxietyRatio,
      seed: params.seed
    },
    upstreamM1Summary: {
      pvKw: upstreamM1.hardwarePlan?.pvKw,
      storageKwh: upstreamM1.hardwarePlan?.storageKwh,
      pcsKw: upstreamM1.hardwarePlan?.pcsKw
    },
    raw
  };
}

export function runM2StressTest(context) {
  const params = normalizeM2Input(context);
  const raw = simulateExtremeLedger(params);
  return mapToM2Result(raw, params, context.previousResults.m1);
}
