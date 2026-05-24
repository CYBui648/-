import { CITY_CLIMATE_DATA } from "../config/climate-data.js";
import { runAnnualValidation } from "./m4-dispatch-core.js";

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

function ceilTo(value, step) {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.ceil(value / step) * step;
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

function generateMonthlyLedger(p, seed) {
    const random = seededRandom(seed || 20260513);
    const randNormalLocal = (mean, stdDev) => {
      let u = 1 - random(), v = random();
      return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v) * stdDev + mean;
    };
    const ticksPerDay = 96;
    const monthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const totalDays = monthDays[p.monthIndex];
    const ledger = [];
    let id = 0;
    const batteryCapMean = Number.isFinite(p.batteryCapMean) ? p.batteryCapMean : 65;
    const initSocMean = Number.isFinite(p.initSocMean) ? p.initSocMean : 0.4;
    const targetSocMean = Number.isFinite(p.targetSocMean) ? p.targetSocMean : 0.95;
    for (let d = 0; d < totalDays; d++) {
      const isWeekend = d % 7 === 5 || d % 7 === 6;
      const todayEvCount = Math.max(0, Math.round(p.evCount * (isWeekend ? p.holidayRatio : 1)));
      const dayTeacherRatio = isWeekend ? Math.min(0.25, p.teacherRatio * 0.35) : p.teacherRatio;
      for (let i = 0; i < todayEvCount; i++) {
        const isTeacher = random() < dayTeacherRatio;
        const isAnxious = random() < p.anxietyRatio;
        const capacity = clamp(randNormalLocal(batteryCapMean, 15), 40, 100);
        const initSoc = clamp(randNormalLocal(initSocMean, 0.15), 0.05, 0.90);
        const slowTargetSoc = clamp(randNormalLocal(targetSocMean, 0.06), 0.70, 1.00);
        const fastTargetSoc = random() < 0.75 ? 0.80 : 1.00;
        let arriveHour = isTeacher ? randNormalLocal(8.5, 1.0) : randNormalLocal(13.5, 2.0);
        arriveHour = clamp(arriveHour, 6, 22);
        const dwellHours = isTeacher ? clamp(randNormalLocal(8.5, 1.0), 6, 10) : clamp(randNormalLocal(3.0, 0.8), 1.5, 5);
        const arriveTick = d * ticksPerDay + clamp(Math.floor(arriveHour * 4), 0, ticksPerDay - 1);
        const leaveTick = Math.min((d + 1) * ticksPerDay, arriveTick + Math.max(2, Math.ceil(dwellHours * 4)));
        const slowNeed = Math.max(0, capacity * (slowTargetSoc - initSoc));
        const mustFast = dwellHours < slowNeed / 7;
        const tag = (mustFast || (isAnxious && random() < 0.75)) ? 'FAST' : 'SLOW';
        const targetSoc = tag === 'FAST' ? fastTargetSoc : slowTargetSoc;
        const energyNeed = Math.max(0, capacity * Math.max(0, targetSoc - initSoc));
        const dwellTicks = Math.max(1, leaveTick - arriveTick);
        const minChargeTicks = Math.ceil(energyNeed / ((tag === 'FAST' ? 30 : 7) * 0.25));
        const usefulWaitTicks = Math.max(1, dwellTicks - minChargeTicks);
        const maxWaitTicks = isTeacher
          ? (isAnxious ? Math.max(8, Math.floor(usefulWaitTicks * 0.5)) : usefulWaitTicks)
          : (isAnxious ? Math.max(4, Math.min(8, usefulWaitTicks)) : Math.max(4, Math.min(12, usefulWaitTicks)));
        ledger.push({
          id: `D${d + 1}_EV${++id}`,
          type: isTeacher ? 'Teacher' : 'Visitor',
          tag,
          preferredTag: tag,
          mustFast,
          arriveTick,
          leaveTick,
          energyNeed,
          deliveredEnergy: 0,
          waitTicks: 0,
          maxWaitTicks,
          power: tag === 'FAST' ? 30 : 7,
          status: 'PENDING'
        });
      }
    }
    return ledger.sort((a, b) => a.arriveTick - b.arriveTick);
  }

function generateAlignedMonthlyLedger(p, seed) {
    const random = seededRandom(seed || 20260513);
    const randomRange = (min, max) => min + random() * (max - min);
    const randNormalLocal = (mean, stdDev) => {
      const u = 1 - random(), v = random();
      return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v) * stdDev + mean;
    };
    const ticksPerDay = 96;
    const monthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const totalDays = monthDays[p.monthIndex];
    const fixedRatio = clamp(Number.isFinite(p.teacherRatio) ? p.teacherRatio : 0.8, 0, 1);
    const anxietyRatio = Number.isFinite(p.anxietyRatio) ? p.anxietyRatio : 0.2;
    const targetSocMean = Number.isFinite(p.targetSocMean) ? p.targetSocMean : 0.95;
    const fixedFleetCount = Math.round(p.evCount * fixedRatio);
    const baseVisitorCount = Math.max(0, p.evCount - fixedFleetCount);
    const fixedFleet = [];
    const ledger = [];
    let id = 0;

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

    const pushEvent = (ev) => {
      if (ev.energyNeed <= 0) return;
      const dwellTicks = Math.max(1, ev.leaveTick - ev.arriveTick);
      const minChargeTicks = Math.ceil(ev.energyNeed / (Math.max(1, ev.power) * 0.25));
      const usefulWaitTicks = Math.max(1, dwellTicks - minChargeTicks);
      const maxWaitTicks = ev.type === 'Teacher'
        ? (ev.isAnxious ? Math.max(8, Math.floor(usefulWaitTicks * 0.5)) : usefulWaitTicks)
        : (ev.isAnxious ? Math.max(4, Math.min(8, usefulWaitTicks)) : Math.max(4, Math.min(12, usefulWaitTicks)));
      ledger.push({
        ...ev,
        id: ev.id || `D${ev.day + 1}_EV${++id}`,
        preferredTag: ev.tag,
        chargeReadyTick: ev.arriveTick,
        deliveredEnergy: 0,
        waitTicks: 0,
        maxWaitTicks,
        status: 'PENDING'
      });
    };

    for (let day = 0; day < totalDays; day++) {
      const isWeekend = day % 7 === 5 || day % 7 === 6;
      const dayFactor = clamp(isWeekend ? (p.holidayRatio || 0.1) : 1, 0, 1);
      const dayStart = day * ticksPerDay;

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
          id: `F${car.id}_D${day + 1}`,
          day,
          type: 'Teacher',
          tag,
          mustFast,
          arriveTick,
          leaveTick,
          energyNeed,
          power: tag === 'FAST' ? 30 : 7,
          isAnxious,
          initSoc: car.soc,
          targetSoc
        });
        car.soc = targetSoc;
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
          day,
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
    }
    return ledger.sort((a, b) => a.arriveTick - b.arriveTick);
  }

function runFlexibleMatrixDispatch(payload) {
    const p = payload.params;
    const cfg = payload.config;
    const econ = payload.economics;
    const ticksPerDay = 96;
    const monthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const totalDays = monthDays[p.monthIndex], totalTicks = totalDays * ticksPerDay;
    const ledgerSeed = Number.isFinite(p.seed) ? p.seed : 20260513 + (p.monthIndex || 0);
    const agents = generateAlignedMonthlyLedger(p, ledgerSeed).map((ev, idx) => {
      const random = seededRandom(9000 + idx);
      const minTicks = Math.ceil(ev.energyNeed / (Math.max(1, ev.power) * 0.25));
      const slackTicks = ev.leaveTick - ev.arriveTick - minTicks;
      let chargeReadyTick = ev.arriveTick;
      const localTick = ev.arriveTick % ticksPerDay;
      const dayStart = ev.arriveTick - localTick;
      const priceElasticity = random();
      let shifted = false;
      if (p.usePricing && ev.type === 'Teacher' && localTick >= 28 && localTick <= 40 && slackTicks > 32 && priceElasticity > p.priceShiftThreshold) {
        const targetTick = dayStart + 52 + Math.floor(random() * 12);
        if (targetTick < ev.leaveTick - minTicks) {
          chargeReadyTick = targetTick;
          shifted = true;
        }
      }
      return {
        ...ev,
        chargeReadyTick,
        priceElasticity,
        shifted,
        maxPower: ev.power,
        currentPower: 0,
        v2gBorrowed: 0,
        clippedTicks: 0,
        closed: false
      };
    });
    const shiftedCount = agents.filter(ev => ev.shifted).length;
    const delayTicksTotal = agents.reduce((s, ev) => s + Math.max(0, ev.chargeReadyTick - ev.arriveTick), 0);

    let gStartIndex = 0;
    for (let m = 0; m < p.monthIndex; m++) gStartIndex += monthDays[m] * 24;
    let soc = cfg.E_storage * 0.2, socMin = 100, realPeak = 0, overflowCount = 0, unmetTotal = 0;
    let queueUnmet = 0, abandonedCount = 0; // matrix port queue losses
    let clippedEvSet = new Set(), v2gEvSet = new Set();

    // N_matrix 接入端口拥堵诊断
    let matrixQueuePeak = 0;
    let matrixQueueTicks = 0;
    let matrixQueueVehicleTicks = 0;

    // P_matrix 功率池拥堵诊断
    let pMatrixLimitedTicks = 0;
    let pMatrixLimitedEnergyKwh = 0;
    let pMatrixMaxGapKw = 0;
    let pMatrixRawPeakKw = 0;
    let v2gEnergy = 0, eBuyValley = 0, eBuyFlat = 0, eBuyPeak = 0, deliveredEnergy = 0, totalPvGen = 0, totalCurtailed = 0;
    let activePeak = 0, readyPeak = 0;
    const demandSeries = new Float32Array(totalTicks);
    const rawDemandSeries = new Float32Array(totalTicks);
    const activeSeries = new Float32Array(totalTicks);
    const socSeries = new Float32Array(totalTicks);
    const pvSeries = new Float32Array(totalTicks);
    const limitSeries = new Float32Array(totalTicks);

    // N_matrix：柔性矩阵可同时接入的终端数
    const nMatrix = p.nMatrix || (cfg.n7 + cfg.n30);

    // P_matrix：柔性矩阵共享功率池容量。
    // 若未传入，则视为"不额外施加矩阵功率池上限"，用于 sizing probe。
    const pMatrixKw =
      Number.isFinite(Number(p.pMatrixKw)) && Number(p.pMatrixKw) > 0
        ? Number(p.pMatrixKw)
        : Number.POSITIVE_INFINITY;

    const connected = [];      // vehicles occupying a matrix port
    const matrixQueue = [];    // vehicles arrived but waiting for a port

    for (let tick = 0; tick < totalTicks; tick++) {
      const h = Math.floor((tick % ticksPerDay) / 4);
      const subTick = tick % 4;
      const hourDataIdx = gStartIndex + Math.floor(tick / 4);
      const currentIrr = (p.gTiltData && p.gTiltData.length > hourDataIdx) ? parseFloat(p.gTiltData[hourDataIdx]) : (GZ.hourlyPvShape[h] * 1000 * 0.8);
      const nextIrr = (p.gTiltData && p.gTiltData.length > hourDataIdx + 1) ? parseFloat(p.gTiltData[hourDataIdx + 1]) : (GZ.hourlyPvShape[(h + 1) % 24] * 1000 * 0.8);
      const irradiance = currentIrr + (nextIrr - currentIrr) * (subTick / 4);
      const pvPower = cfg.P_pv * (irradiance / 1000) * p.pvEfficiency * GZ.efficiencyDirect;
      pvSeries[tick] = pvPower;
      totalPvGen += pvPower * 0.25;

      // Release matrix ports when charging is complete; count unmet energy if a connected EV must leave early.
      for (let i = connected.length - 1; i >= 0; i--) {
        const ev = connected[i];
        const done = ev.deliveredEnergy >= ev.energyNeed + (ev.v2gBorrowed || 0) - 0.001;
        const mustLeave = ev.leaveTick <= tick;
        if (done || mustLeave) {
          if (mustLeave && !done) {
            const gap = Math.max(0, ev.energyNeed + (ev.v2gBorrowed || 0) - (ev.deliveredEnergy || 0));
            unmetTotal += gap;
          }
          ev.closed = true;
          connected.splice(i, 1);
        }
      }
      for (let i = matrixQueue.length - 1; i >= 0; i--) {
        if (matrixQueue[i].leaveTick <= tick) {
          const ev = matrixQueue[i];
          const gap = Math.max(0, ev.energyNeed + (ev.v2gBorrowed || 0) - (ev.deliveredEnergy || 0));
          queueUnmet += gap;
          unmetTotal += gap;
          abandonedCount++;
          ev.closed = true;
          matrixQueue.splice(i, 1);
        }
      }

      // Admit new arrivals: free ports first, then queue
      const newArrivals = agents.filter(ev => !ev.closed && !ev._connected && ev.arriveTick <= tick && ev.leaveTick > tick);
      for (const ev of newArrivals) {
        if (connected.length < nMatrix) {
          connected.push(ev);
          ev._connected = true;
        } else {
          matrixQueue.push(ev);
          ev._connected = true;
        }
      }

      // Promote from queue to connected when ports free up
      while (matrixQueue.length > 0 && connected.length < nMatrix) {
        const ev = matrixQueue.shift();
        connected.push(ev);
      }

      const plugged = connected.filter(ev => ev.leaveTick > tick);
      const ready = plugged.filter(ev => tick >= ev.chargeReadyTick && ev.deliveredEnergy < ev.energyNeed + (ev.v2gBorrowed || 0) - 0.001);
      activePeak = Math.max(activePeak, plugged.length + matrixQueue.length);
      readyPeak = Math.max(readyPeak, ready.length);
      activeSeries[tick] = plugged.length + matrixQueue.length;

      // N_matrix 接口拥堵诊断
      if (matrixQueue.length > 0) {
        matrixQueueTicks++;
        matrixQueueVehicleTicks += matrixQueue.length;
        matrixQueuePeak = Math.max(matrixQueuePeak, matrixQueue.length);
      }

      // Power allocation: all vehicles request max feasible power first;
      // urgency controls who gets clipped first during soft limiting below
      ready.forEach(ev => {
        const remainingNeed =
          ev.energyNeed + (ev.v2gBorrowed || 0) - (ev.deliveredEnergy || 0);

        ev.currentPower = Math.min(
          ev.maxPower,
          Math.max(0, remainingNeed / 0.25)
        );
      });

      let totalDemand = ready.reduce((sum, ev) => sum + ev.currentPower, 0);

      // 记录"矩阵功率池约束之前"的原始柔性需求。
      // 后续 M3-A 的 P_matrix sizing 就基于它做分位数推荐。
      rawDemandSeries[tick] = totalDemand;
      pMatrixRawPeakKw = Math.max(pMatrixRawPeakKw, totalDemand);

      // P_matrix 功率池拥堵诊断：先记账
      if (Number.isFinite(pMatrixKw) && totalDemand > pMatrixKw) {
        const pMatrixGapKw = totalDemand - pMatrixKw;

        pMatrixLimitedTicks++;
        pMatrixLimitedEnergyKwh += pMatrixGapKw * 0.25;
        pMatrixMaxGapKw = Math.max(pMatrixMaxGapKw, pMatrixGapKw);
      }

      // P_matrix 限制：再执行比例压缩
      if (Number.isFinite(pMatrixKw) && totalDemand > pMatrixKw) {
        const ratio = pMatrixKw / Math.max(totalDemand, 1);

        ready.forEach(ev => {
          if (ev.currentPower <= 0) return;
          ev.currentPower *= ratio;
        });

        totalDemand = ready.reduce((sum, ev) => sum + ev.currentPower, 0);
      }

      const softLimit = cfg.transformerLimit * p.clipThreshold;
      const computeUrgency = (ev) => {
        const remainingNeed = ev.energyNeed + ev.v2gBorrowed - ev.deliveredEnergy;
        const remainingTime = Math.max(0.25, ev.leaveTick - tick); // ticks
        return remainingNeed / remainingTime; // kW equivalent
      };

      // Soft clipping: target low-urgency vehicles first
      if (p.useClipping && totalDemand > softLimit) {
        const flexible = ready
          .filter(ev => {
            const remainingNeed = ev.energyNeed + ev.v2gBorrowed - ev.deliveredEnergy;
            const minRemain = Math.ceil(remainingNeed / (Math.max(3.5, ev.currentPower) * 0.25));
            return (ev.leaveTick - tick - minRemain) > p.minClipSlackTicks;
          })
          .sort((a, b) => computeUrgency(a) - computeUrgency(b)); // low urgency first
        for (const ev of flexible) {
          if (totalDemand <= softLimit) break;
          const oldPower = ev.currentPower;
          ev.currentPower = Math.max(3.5, ev.currentPower * 0.5);
          totalDemand -= (oldPower - ev.currentPower);
          ev.clippedTicks++;
          clippedEvSet.add(ev.id);
        }
      }
      // Hard clipping: proportional cut for everyone if still over transformer limit
      if (p.useClipping && totalDemand > cfg.transformerLimit) {
        const ratio = cfg.transformerLimit / Math.max(totalDemand, 1);
        ready.forEach(ev => {
          if (ev.currentPower <= 0) return;
          ev.currentPower *= ratio;
          ev.clippedTicks++;
          clippedEvSet.add(ev.id);
        });
        totalDemand = ready.reduce((sum, ev) => sum + ev.currentPower, 0);
      }
      if (!p.useClipping && totalDemand > cfg.transformerLimit) overflowCount++;

      const essAvailableForV2G = Math.min(cfg.P_storage, Math.max(0, soc - cfg.E_storage * 0.05));
      const deficitPreV2G = Math.max(0, totalDemand - pvPower - essAvailableForV2G);
      let v2gPower = 0;
      if (p.useV2G && h >= 17 && h <= 21 && soc < cfg.E_storage * 0.08 && deficitPreV2G > 0) {
        const donors = plugged
          .filter(ev => ev.deliveredEnergy >= ev.energyNeed && ev.leaveTick - tick > 12 && ev.v2gBorrowed < p.maxV2gPerEv)
          .sort((a, b) => (b.leaveTick - tick) - (a.leaveTick - tick));
        for (const ev of donors) {
          const drawPower = Math.min(7, (p.maxV2gPerEv - ev.v2gBorrowed) / 0.25);
          if (drawPower <= 0) continue;
          ev.v2gBorrowed += drawPower * 0.25;
          v2gPower += drawPower;
          v2gEnergy += drawPower * 0.25;
          v2gEvSet.add(ev.id);
          if (v2gPower >= cfg.transformerLimit * 0.15) break;
        }
      }

      const loadEnergy = Math.max(0, totalDemand) * 0.25;
      const v2gSupportEnergy = v2gPower * 0.25;
      const standbyLoss = cfg.P_storage * 0.005 * 0.25;
      let availableEnergy = pvPower * 0.25 + v2gSupportEnergy - standbyLoss;
      if (availableEnergy < loadEnergy) {
        const discharge = Math.min(loadEnergy - availableEnergy, cfg.P_storage * 0.25, Math.max(0, soc - cfg.E_storage * 0.05));
        soc -= discharge;
        availableEnergy += discharge;
      }
      if (availableEnergy < loadEnergy) {
        const gridNeed = loadEnergy - availableEnergy;
        const gridBuy = Math.min(gridNeed, cfg.transformerLimit * 0.25);
        availableEnergy += gridBuy;
        const touPrice = p.gridTouPrice || GZ.gridTouPrice;
        const gridPrice = getGridTouPrice(h, touPrice);
        if (Math.abs(gridPrice - touPrice.valley) < 1e-9) eBuyValley += gridBuy;
        else if (Math.abs(gridPrice - touPrice.flat) < 1e-9) eBuyFlat += gridBuy;
        else eBuyPeak += gridBuy;
      }
      const actualDelivered = Math.max(0, Math.min(loadEnergy, availableEnergy));
      if (loadEnergy > 0 && actualDelivered > 0) {
        for (const ev of ready) {
          if (ev.currentPower <= 0) continue;
          const share = (ev.currentPower * 0.25 / loadEnergy) * actualDelivered;
          const before = ev.deliveredEnergy;
          ev.deliveredEnergy = Math.min(ev.energyNeed + ev.v2gBorrowed, ev.deliveredEnergy + share);
          deliveredEnergy += Math.max(0, ev.deliveredEnergy - before);
        }
      }
      if (availableEnergy > loadEnergy) {
        const surplus = availableEnergy - loadEnergy;
        const charge = Math.min(surplus, cfg.P_storage * 0.25, cfg.E_storage - soc);
        soc += charge;
        totalCurtailed += Math.max(0, surplus - charge);
      }

      for (const ev of plugged) {
        if (!ev.closed && ev.leaveTick <= tick + 1) {
          const gap = Math.max(0, ev.energyNeed + ev.v2gBorrowed - ev.deliveredEnergy);
          unmetTotal += gap;
          ev.closed = true;
        }
      }
      realPeak = Math.max(realPeak, totalDemand);
      demandSeries[tick] = totalDemand;
      limitSeries[tick] = cfg.transformerLimit;
      if (cfg.E_storage > 0) socMin = Math.min(socMin, soc / cfg.E_storage * 100);
      socSeries[tick] = cfg.E_storage > 0 ? soc / cfg.E_storage * 100 : 0;
    }

    agents.forEach(ev => {
      if (!ev.closed) unmetTotal += Math.max(0, ev.energyNeed + ev.v2gBorrowed - ev.deliveredEnergy);
    });
    const opexYear = cfg.baseCapexYuan * econ.opexRate +
      eBuyValley * econ.priceGridValley * 12 +
      eBuyFlat * (econ.priceGridFlat || 0.65) * 12 +
      eBuyPeak * econ.priceGridPeak * 12 +
      v2gEnergy * econ.v2gWearCost * 12;
    const deliveredYear = Math.max(1, deliveredEnergy * 12);
    const lcoe = (cfg.baseCapexYuan + opexYear * 20) / (deliveredYear * 20);
    return {
      mode: 'flex_matrix',

      realPeak,
      overflowCount,
      unmetTotal,

      // 既有接口损失指标
      queueUnmet,
      abandonedCount,

      // N_matrix 接入端口拥堵诊断
      matrixQueuePeak,
      matrixQueueTicks,
      matrixQueueVehicleTicks,

      // P_matrix 功率池拥堵诊断
      pMatrixLimitedTicks,
      pMatrixLimitedEnergyKwh,
      pMatrixMaxGapKw,
      pMatrixRawPeakKw,

      deliveredEnergy, eBuyValley, eBuyFlat, eBuyPeak,
      shiftedCount, avgDelayHours: shiftedCount > 0 ? delayTicksTotal / shiftedCount / 4 : 0,
      clippedCount: clippedEvSet.size, v2gCount: v2gEvSet.size, v2gEnergy,
      activePeak, readyPeak,
      socMin: Number.isFinite(socMin) ? socMin : 0,
      curtailmentRate: totalPvGen > 0 ? totalCurtailed / totalPvGen * 100 : 0,
      LCOE: lcoe, opexYear: opexYear / 10000,
      chartData: {
        demand: Array.from(demandSeries),
        rawDemand: Array.from(rawDemandSeries),
        active: Array.from(activeSeries),
        limit: Array.from(limitSeries),
        pv: Array.from(pvSeries),
        soc: Array.from(socSeries)
      }
    };
  }

function runTraditionalPileDispatch(payload) {
    const p = payload.params;
    const cfg = payload.config;
    const econ = payload.economics;
    const ticksPerDay = 96;
    const monthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const totalDays = monthDays[p.monthIndex], totalTicks = totalDays * ticksPerDay;
    const ledgerSeed = Number.isFinite(p.seed) ? p.seed : 20260513 + (p.monthIndex || 0);
    const random = seededRandom(ledgerSeed + 901);
    const ledger = generateAlignedMonthlyLedger(p, ledgerSeed).map(ev => {
      const minTicks = Math.ceil(ev.energyNeed / (Math.max(1, ev.power) * 0.25));
      const slackTicks = ev.leaveTick - ev.arriveTick - minTicks;
      const localTick = ev.arriveTick % ticksPerDay;
      const dayStart = ev.arriveTick - localTick;
      const priceElasticity = random();
      let chargeReadyTick = ev.arriveTick;
      let shifted = false;
      if (p.usePricing && ev.type === 'Teacher' && localTick >= 28 && localTick <= 40 && slackTicks > 16 && priceElasticity > p.priceShiftThreshold) {
        const targetTick = dayStart + 52 + Math.floor(random() * 12);
        if (targetTick < ev.leaveTick - minTicks) {
          chargeReadyTick = targetTick;
          shifted = true;
        }
      }
      return { ...ev, chargeReadyTick, shifted, priceElasticity, closed: false };
    }).sort((a, b) => a.chargeReadyTick - b.chargeReadyTick);
    const shiftedCount = ledger.filter(ev => ev.shifted).length;
    const delayTicksTotal = ledger.reduce((s, ev) => s + Math.max(0, ev.chargeReadyTick - ev.arriveTick), 0);

    let gStartIndex = 0;
    for (let m = 0; m < p.monthIndex; m++) gStartIndex += monthDays[m] * 24;
    const waitingQueue = [], chargingList = [];
    let nextPending = 0, queueUnmet = 0, unmetTotal = 0, abandonedCount = 0, deliveredEnergy = 0;
    let soc = cfg.E_storage * 0.2, socMin = 100, realPeak = 0, overflowCount = 0;
    let eBuyValley = 0, eBuyFlat = 0, eBuyPeak = 0, totalPvGen = 0, totalCurtailed = 0, queuedPeak = 0, chargingPeak = 0;
    const demandSeries = new Float32Array(totalTicks);
    const rawDemandSeries = new Float32Array(totalTicks);
    const activeSeries = new Float32Array(totalTicks);
    const socSeries = new Float32Array(totalTicks);
    const pvSeries = new Float32Array(totalTicks);
    const limitSeries = new Float32Array(totalTicks);

    for (let tick = 0; tick < totalTicks; tick++) {
      for (let i = chargingList.length - 1; i >= 0; i--) {
        const ev = chargingList[i];
        const done = ev.deliveredEnergy >= ev.energyNeed - 0.001;
        const mustLeave = tick >= ev.leaveTick;
        if (done || mustLeave) {
          chargingList.splice(i, 1);
          if (mustLeave && !done) unmetTotal += Math.max(0, ev.energyNeed - ev.deliveredEnergy);
          ev.closed = true;
        }
      }
      while (nextPending < ledger.length && ledger[nextPending].chargeReadyTick <= tick) {
        const ev = ledger[nextPending++];
        ev.waitTicks = 0;
        waitingQueue.push(ev);
      }
      let usedFast = chargingList.reduce((s, ev) => s + (ev.tag === 'FAST' ? 1 : 0), 0);
      let usedSlow = chargingList.length - usedFast;
      for (let i = 0; i < waitingQueue.length;) {
        const ev = waitingQueue[i];
        const fastSlot = ev.tag === 'FAST' && usedFast < cfg.n30;
        const slowSlot = ev.tag === 'SLOW' && usedSlow < cfg.n7;
        const slowFallback = ev.tag === 'FAST' && !ev.mustFast && usedSlow < cfg.n7;
        if (fastSlot || slowSlot || slowFallback) {
          waitingQueue.splice(i, 1);
          if (slowFallback && !fastSlot) {
            ev.tag = 'SLOW';
            ev.power = 7;
          }
          chargingList.push(ev);
          if (ev.tag === 'FAST') usedFast++; else usedSlow++;
        } else i++;
      }

      const h = Math.floor((tick % ticksPerDay) / 4);
      const subTick = tick % 4;
      const hourDataIdx = gStartIndex + Math.floor(tick / 4);
      const currentIrr = (p.gTiltData && p.gTiltData.length > hourDataIdx) ? parseFloat(p.gTiltData[hourDataIdx]) : (GZ.hourlyPvShape[h] * 1000 * 0.8);
      const nextIrr = (p.gTiltData && p.gTiltData.length > hourDataIdx + 1) ? parseFloat(p.gTiltData[hourDataIdx + 1]) : (GZ.hourlyPvShape[(h + 1) % 24] * 1000 * 0.8);
      const irradiance = currentIrr + (nextIrr - currentIrr) * (subTick / 4);
      const pvPower = cfg.P_pv * (irradiance / 1000) * p.pvEfficiency * GZ.efficiencyDirect;
      const loadPower = chargingList.reduce((s, ev) => s + ev.power, 0);
      const loadEnergy = loadPower * 0.25;
      pvSeries[tick] = pvPower;
      totalPvGen += pvPower * 0.25;
      rawDemandSeries[tick] = loadPower;
      realPeak = Math.max(realPeak, loadPower);
      if (loadPower > cfg.transformerLimit) overflowCount++;

      const standbyLoss = cfg.P_storage * 0.005 * 0.25;
      let availableEnergy = pvPower * 0.25 - standbyLoss;
      if (availableEnergy < loadEnergy) {
        const discharge = Math.min(loadEnergy - availableEnergy, cfg.P_storage * 0.25, Math.max(0, soc - cfg.E_storage * 0.05));
        soc -= discharge;
        availableEnergy += discharge;
      }
      if (availableEnergy < loadEnergy) {
        const gridNeed = loadEnergy - availableEnergy;
        const gridBuy = Math.min(gridNeed, cfg.transformerLimit * 0.25);
        availableEnergy += gridBuy;
        const touPrice = p.gridTouPrice || GZ.gridTouPrice;
        const gridPrice = getGridTouPrice(h, touPrice);
        if (Math.abs(gridPrice - touPrice.valley) < 1e-9) eBuyValley += gridBuy;
        else if (Math.abs(gridPrice - touPrice.flat) < 1e-9) eBuyFlat += gridBuy;
        else eBuyPeak += gridBuy;
      }
      const actualDelivered = Math.max(0, Math.min(loadEnergy, availableEnergy));
      if (loadEnergy > 0 && actualDelivered > 0) {
        for (const ev of chargingList) {
          const share = (ev.power * 0.25 / loadEnergy) * actualDelivered;
          const before = ev.deliveredEnergy;
          ev.deliveredEnergy = Math.min(ev.energyNeed, ev.deliveredEnergy + share);
          deliveredEnergy += Math.max(0, ev.deliveredEnergy - before);
        }
      }
      if (availableEnergy > loadEnergy) {
        const surplus = availableEnergy - loadEnergy;
        const charge = Math.min(surplus, cfg.P_storage * 0.25, cfg.E_storage - soc);
        soc += charge;
        totalCurtailed += Math.max(0, surplus - charge);
      }
      for (let i = waitingQueue.length - 1; i >= 0; i--) {
        const ev = waitingQueue[i];
        ev.waitTicks++;
        if (tick >= ev.leaveTick || ev.waitTicks > ev.maxWaitTicks) {
          waitingQueue.splice(i, 1);
          queueUnmet += Math.max(0, ev.energyNeed);
          unmetTotal += Math.max(0, ev.energyNeed);
          abandonedCount++;
        }
      }
      queuedPeak = Math.max(queuedPeak, waitingQueue.length);
      chargingPeak = Math.max(chargingPeak, chargingList.length);
      activeSeries[tick] = waitingQueue.length;
      demandSeries[tick] = Math.min(loadPower, cfg.transformerLimit);
      limitSeries[tick] = cfg.transformerLimit;
      if (cfg.E_storage > 0) socMin = Math.min(socMin, soc / cfg.E_storage * 100);
      socSeries[tick] = cfg.E_storage > 0 ? soc / cfg.E_storage * 100 : 0;
    }
    for (const ev of chargingList) unmetTotal += Math.max(0, ev.energyNeed - ev.deliveredEnergy);
    for (const ev of waitingQueue) {
      queueUnmet += Math.max(0, ev.energyNeed);
      unmetTotal += Math.max(0, ev.energyNeed);
      abandonedCount++;
    }
    const opexYear = cfg.baseCapexYuan * econ.opexRate +
      eBuyValley * econ.priceGridValley * 12 +
      eBuyFlat * (econ.priceGridFlat || 0.65) * 12 +
      eBuyPeak * econ.priceGridPeak * 12;
    const deliveredYear = Math.max(1, deliveredEnergy * 12);
    const lcoe = (cfg.baseCapexYuan + opexYear * 20) / (deliveredYear * 20);
    return {
      mode: 'traditional_pile',
      realPeak, overflowCount, unmetTotal, queueUnmet, abandonedCount, deliveredEnergy, eBuyValley, eBuyFlat, eBuyPeak,
      shiftedCount, avgDelayHours: shiftedCount > 0 ? delayTicksTotal / shiftedCount / 4 : 0,
      clippedCount: 0, v2gCount: 0, v2gEnergy: 0,
      activePeak: queuedPeak, readyPeak: chargingPeak,
      socMin: Number.isFinite(socMin) ? socMin : 0,
      curtailmentRate: totalPvGen > 0 ? totalCurtailed / totalPvGen * 100 : 0,
      LCOE: lcoe, opexYear: opexYear / 10000,
      chartData: {
        demand: Array.from(demandSeries),
        rawDemand: Array.from(rawDemandSeries),
        active: Array.from(activeSeries),
        limit: Array.from(limitSeries),
        pv: Array.from(pvSeries),
        soc: Array.from(socSeries)
      }
    };
  }

function summarizeDispatchResidual(result, baseline) {
    const base = baseline || {};
    const baselineUnmet = base.unmetTotal || 0;
    const baselineQueue = base.queueUnmet || 0;
    const baselinePeak = base.realPeak || 0;
    return {
      residualUnmet: result.unmetTotal || 0,
      residualQueueUnmet: result.queueUnmet || 0,
      residualOverflow: result.overflowCount || 0,
      residualSocRisk: result.socMin || 0,
      unmetReduction: Math.max(0, baselineUnmet - (result.unmetTotal || 0)),
      queueReduction: Math.max(0, baselineQueue - (result.queueUnmet || 0)),
      peakReduction: Math.max(0, baselinePeak - (result.realPeak || 0)),
      unmetReductionRate: baselineUnmet > 0 ? Math.max(0, baselineUnmet - (result.unmetTotal || 0)) / baselineUnmet : 0,
      queueReductionRate: baselineQueue > 0 ? Math.max(0, baselineQueue - (result.queueUnmet || 0)) / baselineQueue : 0,
      peakReductionRate: baselinePeak > 0 ? Math.max(0, baselinePeak - (result.realPeak || 0)) / baselinePeak : 0,
      needsHardwareReinforcement: (result.unmetTotal || 0) > 1 ||
        (result.queueUnmet || 0) > 1 ||
        (result.overflowCount || 0) > 0 ||
        (result.socMin || 100) < 8
    };
  }

function runDispatchAssessment(payload) {
    const basePayload = {
      ...payload,
      config: { ...payload.config },
      params: { ...payload.params },
      economics: { ...payload.economics }
    };

    const traditional = runTraditionalPileDispatch({
      ...basePayload,
      params: {
        ...basePayload.params,
        dispatchMode: "traditional_pile",
        usePricing: true,
        useClipping: false,
        useV2G: false
      }
    });

    traditional.residual = summarizeDispatchResidual(
      traditional,
      payload.baseline?.m2
    );

    return {
      hardwareSource: "m1_base",
      traditional,
      preferred: "traditional_pile",
      baseline: payload.baseline || null
    };
  }
function round(value, digits = 2) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function pickM2Baseline(m2Result) {
  if (m2Result?.raw) return m2Result.raw;
  return {
    unmetTotal: m2Result?.riskReport?.unmetTotalKwh || 0,
    queueUnmet: m2Result?.riskReport?.queueUnmetKwh || 0,
    realPeak: m2Result?.riskReport?.realPeakKw || 0,
    overflowCount: m2Result?.riskReport?.overflowCount || 0,
    socMin: m2Result?.riskReport?.socMinPct || 100,
    fixedReadyP95: m2Result?.occupancyReference?.fixedReadyP95 || 0,
    fixedReadyP99: m2Result?.occupancyReference?.fixedReadyP99 || 0,
    fixedReadyMax: m2Result?.occupancyReference?.fixedReadyMax || 0,
    monthlyAccessDemand: m2Result?.occupancyReference?.monthlyAccessDemand || 0,
    dailyAccessDemand: m2Result?.occupancyReference?.dailyAccessDemand || 0,
    recommendedMatrixByDailyAccess: m2Result?.occupancyReference?.recommendedMatrixByDailyAccess || 0,
    virtualFastP95: m2Result?.occupancyReference?.virtualFastP95 || 0,
    virtualFastP99: m2Result?.occupancyReference?.virtualFastP99 || 0,
    virtualSlowP95: m2Result?.occupancyReference?.virtualSlowP95 || 0,
    virtualSlowP99: m2Result?.occupancyReference?.virtualSlowP99 || 0,
    chargingPeak: m2Result?.riskReport?.chargingPeak || 0,
    queuedPeak: m2Result?.riskReport?.queuedPeak || 0,
    seed: 20260513,
  };
}

function normalizeM3Payload(context) {
  const input = context.input || {};
  const m1Input = input.m1 || {};
  const m2Input = input.m2 || {};
  const m3Input = input.m3 || {};
  const m1 = context.previousResults?.m1;
  const m2 = context.previousResults?.m2;

  if (!m1?.hardwarePlan) {
    throw new Error("M3 缺少 M1Result，无法读取基准硬件。");
  }
  if (!m2) {
    throw new Error("M3 缺少 M2Result，无法读取压力测试基线。");
  }
  if (!Array.isArray(m2Input.gTiltData) || m2Input.gTiltData.length < 8760) {
    throw new Error("M3 需要沿用 M2 的 8760 小时 TMY 气象数据。");
  }

  const climate = CITY_CLIMATE_DATA[m1Input.climateKey] || CITY_CLIMATE_DATA.guangzhou;
  const baselineM2 = pickM2Baseline(m2);
  const monthIndex = Number.isFinite(m2?.summary?.monthIndex)
    ? m2.summary.monthIndex
    : (baselineM2.seed != null ? Math.abs(baselineM2.seed - 20260513) % 12 : 0);

  return {
    config: {
      P_pv: Number(m1.hardwarePlan.pvKw || 0),
      E_storage: Number(m1.hardwarePlan.storageKwh || 0),
      P_storage: Number(m1.hardwarePlan.pcsKw || 0),
      n7: Number(m1.hardwarePlan.n7kw || 0),
      n30: Number(m1.hardwarePlan.n30kw || 0),
      transformerLimit: Number(m2.summary?.transformerLimitKw ?? m2Input.transformerLimitKw ?? 500),
      baseCapexYuan: Number(m1.economics?.capexWan || 0) * 10000
    },
    params: {
      monthIndex,
      seed: baselineM2.seed ?? (20260513 + monthIndex),
      gTiltData: m2Input.gTiltData,
      evCount: Number(m1Input.evCount ?? 100),
      teacherRatio: Number(m2Input.teacherRatio ?? m1Input.teacherRatio ?? 0.80),
      anxietyRatio: Number(m2Input.anxietyRatio ?? m1Input.anxietyRatio ?? 0.20),
      batteryCapMean: Number(m1Input.batteryCapMean ?? 65),
      initSocMean: Number(m1Input.initSocMean ?? 0.40),
      targetSocMean: Number(m1Input.targetSocMean ?? 0.95),
      sessionKwh: Number(m1Input.batteryCapMean ?? 65) * Math.max(0, Number(m1Input.targetSocMean ?? 0.95) - Number(m1Input.initSocMean ?? 0.40)),
      holidayRatio: Number(m1Input.holidayRatio ?? 0.10),
      pvEfficiency: Number(m1Input.pvEfficiency ?? 0.72),
      valleySocTarget: 0.30,
      usePricing: true,
      useClipping: false,
      useV2G: false,
      priceShiftThreshold: Number(m3Input.priceShiftThreshold ?? 0.55),
      clipThreshold: 1,
      minClipSlackTicks: 0,
      maxV2gPerEv: 0,
      gridTouPrice: climate?.gridTouPrice,
      climate
    },
    economics: {
      priceGridValley: climate?.gridTouPrice?.valley ?? 0.28,
      priceGridFlat: climate?.gridTouPrice?.flat ?? 0.65,
      priceGridPeak: climate?.gridTouPrice?.peak ?? 0.85,
      opexRate: Number(m3Input.opexRate ?? 0.015),
      v2gWearCost: 0
    },
    baseline: {
      m2: baselineM2,
      hardwareSource: "m1_base"
    }
  };
}

function summarizeRoute(result) {
  const residual = result?.residual || {};
  return {
    realPeakKw: round(result?.realPeak || 0, 1),
    overflowCount: result?.overflowCount || 0,
    unmetTotalKwh: round(result?.unmetTotal || 0, 1),
    queueUnmetKwh: round(result?.queueUnmet || 0, 1),
    abandonedCount: result?.abandonedCount || 0,
    socMinPct: round(result?.socMin || 0, 1),

    // 柔性矩阵接口拥堵诊断
    matrixQueuePeak: result?.matrixQueuePeak || 0,
    matrixQueueTicks: result?.matrixQueueTicks || 0,
    matrixQueueVehicleTicks: result?.matrixQueueVehicleTicks || 0,

    // 柔性矩阵功率池拥堵诊断
    pMatrixLimitedTicks: result?.pMatrixLimitedTicks || 0,
    pMatrixLimitedEnergyKwh: round(result?.pMatrixLimitedEnergyKwh || 0, 1),
    pMatrixMaxGapKw: round(result?.pMatrixMaxGapKw || 0, 1),
    pMatrixRawPeakKw: round(result?.pMatrixRawPeakKw || 0, 1),

    shiftedCount: result?.shiftedCount || 0,
    clippedCount: result?.clippedCount || 0,
    v2gEnergyKwh: round(result?.v2gEnergy || 0, 1),
    residual: {
      residualUnmetKwh: round(residual.residualUnmet || 0, 1),
      residualQueueUnmetKwh: round(residual.residualQueueUnmet || 0, 1),
      residualOverflowCount: residual.residualOverflow || 0,
      residualSocRiskPct: round(residual.residualSocRisk || 0, 1),
      unmetReductionKwh: round(residual.unmetReduction || 0, 1),
      queueReductionKwh: round(residual.queueReduction || 0, 1),
      peakReductionKw: round(residual.peakReduction || 0, 1),
      unmetReductionRate: round(residual.unmetReductionRate || 0, 4),
      queueReductionRate: round(residual.queueReductionRate || 0, 4),
      peakReductionRate: round(residual.peakReductionRate || 0, 4),
      needsHardwareReinforcement: Boolean(residual.needsHardwareReinforcement)
    }
  };
}

function buildRouteHandoff(routeSummary) {
  const residual = routeSummary.residual || {};
  return {
    needsHardwareReinforcement: Boolean(residual.needsHardwareReinforcement),
    residualUnmetKwh: residual.residualUnmetKwh,
    residualQueueUnmetKwh: residual.residualQueueUnmetKwh,
    residualOverflowCount: residual.residualOverflowCount,
    residualSocRiskPct: residual.residualSocRiskPct,
    note: residual.needsHardwareReinforcement
      ? "该路线软调度后仍存在残余风险，应交由 M4 生成加固方案。"
      : "该路线软调度已消化主要风险，M4 可保留 S0 对照方案。"
  };
}

function mapToM3Result(raw, payload, m2Result) {
  const traditionalSummary = summarizeRoute(raw.traditional);

  return {
    contract: "M3Result",
    summary: {
      title: "价格调度评估已完成",
      positioning: "M3 仅保留传统桩站价格调度路线，用分时价格引导弹性车辆错峰充电，评估软调度对压力风险的削减效果。"
    },
    baselineFromM2: {
      monthName: m2Result?.summary?.monthName || "--",
      realPeakKw: round(m2Result?.riskReport?.realPeakKw || 0, 1),
      unmetTotalKwh: round(m2Result?.riskReport?.unmetTotalKwh || 0, 1),
      queueUnmetKwh: round(m2Result?.riskReport?.queueUnmetKwh || 0, 1),
      abandonedCount: m2Result?.riskReport?.abandonedCount || 0
    },
    routeOptions: {
      traditional_pile: {
        key: "traditional_pile",
        label: "传统桩站价格调度",
        suitability: "适合保留既有固定桩位，通过分时价格引导弹性车辆错峰充电，降低高峰负荷与排队风险。",
        result: traditionalSummary,
        handoffToM4: buildRouteHandoff(traditionalSummary)
      }
    },
    raw,
    payloadSnapshot: {
      transformerLimitKw: payload.config.transformerLimit,
      monthIndex: payload.params.monthIndex,
      usePricing: true,
      useV2G: false,
      clipThreshold: payload.params.clipThreshold,
      priceShiftThreshold: payload.params.priceShiftThreshold
    }
  };
}

export function runM3DispatchDiagnosis(context) {
  const payload = normalizeM3Payload(context);
  const raw = runDispatchAssessment(payload);
  return mapToM3Result(raw, payload, context.previousResults.m2);
}

export function runM3SelectedRouteAnnualValidation(context) {
  const input = context.input || {};
  const m3Result = context.previousResults?.m3;

  if (!m3Result?.routeOptions?.traditional_pile) {
    throw new Error("M3-B 缺少 M3-A 价格调度结果，无法执行全年验证。");
  }

  const selectedRouteKey = "traditional_pile";
  const selectedRoute = m3Result.routeOptions.traditional_pile;

  const payload = normalizeM3Payload(context);

  payload.params.dispatchMode = "traditional_pile";
  payload.params.usePricing = true;
  payload.params.useClipping = false;
  payload.params.useV2G = false;

  const annualResult = runAnnualValidation({
    preferred: selectedRouteKey,
    config: payload.config,
    params: payload.params,
    economics: payload.economics
  });

  const annual = annualResult.annual || {};

  return {
    contract: "M3AnnualValidationResult",
    selectedRouteKey,
    selectedRouteLabel: selectedRoute.label,
    matrixConfig: null,
    annualValidation: {
      totalUnmetKwh: round(annual.totalUnmet || 0, 1),
      totalQueueUnmetKwh: round(annual.totalQueueUnmet || 0, 1),
      totalOverflowCount: annual.totalOverflow || 0,
      serviceRate: round(annual.serviceRate || 0, 4),

      totalMatrixQueueTicks: 0,
      totalMatrixQueueVehicleTicks: 0,
      maxMatrixQueuePeak: 0,
      totalPMatrixLimitedTicks: 0,
      totalPMatrixLimitedEnergyKwh: 0,
      maxPMatrixGapKw: 0,
      maxPMatrixRawPeakKw: 0,

      monthsWithOverflow: annual.monthsWithOverflow || 0,
      monthsWithSocRisk: annual.monthsWithSocRisk || 0,
      totalDeliveredKwh: round(annual.totalDelivered || 0, 1),
      totalGridBuyKwh: round(annual.totalGridBuy || 0, 1),
      totalV2gKwh: 0,
      worstSocPct: round(annual.worstSoc ?? 100, 1),
      worstMonth: annual.worstMonth ?? null,
      annualGridCostYuan: round(annual.annualGridCost || 0, 1),
      annualLcoeYuanPerKwh: round(annual.annualLCOE || 999, 3)
    },
    rawAnnual: annualResult
  };
}
