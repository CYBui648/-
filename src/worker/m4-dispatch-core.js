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
    let v2gEnergy = 0, eBuyValley = 0, eBuyFlat = 0, eBuyPeak = 0, deliveredEnergy = 0, totalPvGen = 0, totalCurtailed = 0;
    let activePeak = 0, readyPeak = 0;
    const demandSeries = new Float32Array(totalTicks);
    const rawDemandSeries = new Float32Array(totalTicks);
    const activeSeries = new Float32Array(totalTicks);
    const socSeries = new Float32Array(totalTicks);
    const pvSeries = new Float32Array(totalTicks);
    const limitSeries = new Float32Array(totalTicks);

    // N_matrix port constraint for flexible matrix
    const nMatrix = p.nMatrix || (cfg.n7 + cfg.n30);
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

      // Remove departed vehicles from connected and queue
      for (let i = connected.length - 1; i >= 0; i--) {
        if (connected[i].leaveTick <= tick) connected.splice(i, 1);
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

      // Power allocation: all vehicles request max feasible power first;
      // urgency controls who gets clipped first during soft limiting below
      ready.forEach(ev => {
        const remainingNeed = ev.energyNeed + (ev.v2gBorrowed || 0) - (ev.deliveredEnergy || 0);
        ev.currentPower = Math.min(ev.maxPower, Math.max(0, remainingNeed / 0.25));
      });
      let totalDemand = ready.reduce((sum, ev) => sum + ev.currentPower, 0);
      rawDemandSeries[tick] = totalDemand;

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
      realPeak, overflowCount, unmetTotal, queueUnmet, abandonedCount, deliveredEnergy, eBuyValley, eBuyFlat, eBuyPeak,
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

function runAnnualValidation(payload) {
    const monthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const preferred = payload.preferred; // 'flex_matrix' or 'traditional_pile'
    const monthlyResults = [];
    const annual = {
      totalUnmet: 0, totalQueueUnmet: 0, totalOverflow: 0,
      totalDelivered: 0, totalDemand: 0, totalGridBuy: 0, totalGridPeak: 0, totalGridFlat: 0, totalGridValley: 0,
      totalV2g: 0, totalCurtailed: 0, totalPvGen: 0, totalAbandoned: 0,
      maxPeak: 0, worstSoc: 100, worstMonth: -1,
      monthsWithOverflow: 0, monthsWithSocRisk: 0,
      monthsFailed: [], monthsWarning: [],
      totalOpex: 0, totalShifted: 0, totalClipped: 0
    };

    for (let m = 0; m < 12; m++) {
      const monthPayload = {
        ...payload,
        params: {
          ...payload.params,
          monthIndex: m,
          seed: (payload.params.seed || 20260513) + m,
          dispatchMode: preferred
        }
      };
      const result = preferred === 'flex_matrix'
        ? runFlexibleMatrixDispatch(monthPayload)
        : runTraditionalPileDispatch(monthPayload);

      monthlyResults.push({
        month: m,
        monthName: ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'][m],
        days: monthDays[m],
        realPeak: result.realPeak || 0,
        unmetTotal: result.unmetTotal || 0,
        overflowCount: result.overflowCount || 0,
        socMin: result.socMin || 100,
        deliveredEnergy: result.deliveredEnergy || 0,
        queueUnmet: result.queueUnmet || 0,
        abandonedCount: result.abandonedCount || 0,
        curtailmentRate: result.curtailmentRate || 0,
        LCOE: result.LCOE || 0,
        shiftedCount: result.shiftedCount || 0,
        clippedCount: result.clippedCount || 0,
        v2gEnergy: result.v2gEnergy || 0,
        eBuyPeak: result.eBuyPeak || 0,
        eBuyFlat: result.eBuyFlat || 0,
        eBuyValley: result.eBuyValley || 0
      });

      const r = result;
      annual.totalUnmet += r.unmetTotal || 0;
      annual.totalQueueUnmet += r.queueUnmet || 0;
      annual.totalOverflow += r.overflowCount || 0;
      annual.totalDelivered += r.deliveredEnergy || 0;
      annual.totalGridBuy += (r.eBuyPeak || 0) + (r.eBuyFlat || 0) + (r.eBuyValley || 0);
      annual.totalGridPeak += r.eBuyPeak || 0;
      annual.totalGridFlat += r.eBuyFlat || 0;
      annual.totalGridValley += r.eBuyValley || 0;
      annual.totalV2g += r.v2gEnergy || 0;
      annual.totalCurtailed += monthDays[m] * 24 * (r.curtailmentRate || 0) / 100;
      annual.totalPvGen += r.chartData?.pv?.reduce((a, b) => a + b, 0) || 0;
      annual.totalShifted += r.shiftedCount || 0;
      annual.totalClipped += r.clippedCount || 0;
      annual.totalAbandoned += r.abandonedCount || 0;
      annual.totalDemand += (r.deliveredEnergy || 0) + (r.unmetTotal || 0); // demand = delivered + unmet
      annual.maxPeak = Math.max(annual.maxPeak, r.realPeak || 0);
      annual.worstSoc = Math.min(annual.worstSoc, r.socMin || 100);
      if (r.socMin < annual.worstSoc) { annual.worstSoc = r.socMin; annual.worstMonth = m; }
      if ((r.overflowCount || 0) > 0) {
        annual.monthsWithOverflow++;
        annual.monthsWarning.push(m);
      }
      if ((r.socMin || 100) < 8) {
        annual.monthsWithSocRisk++;
        annual.monthsFailed.push(m);
      }
      const monthOpex = (payload.config.baseCapexYuan || 0) * (payload.economics?.opexRate || 0.015) / 12;
      annual.totalOpex += monthOpex;
    }

    const annualDelivered = annual.totalDelivered;
    const annualGridCost = annual.totalGridValley * (payload.economics?.priceGridValley || 0.28) +
      annual.totalGridFlat * (payload.economics?.priceGridFlat || 0.65) +
      annual.totalGridPeak * (payload.economics?.priceGridPeak || 0.85);
    const annualLCOE = annualDelivered > 0
      ? ((payload.config.baseCapexYuan || 0) / 20 + annual.totalOpex + annualGridCost) / annualDelivered
      : 999;

    return {
      preferred,
      monthly: monthlyResults,
      annual: {
        totalUnmet: annual.totalUnmet,
        totalQueueUnmet: annual.totalQueueUnmet,
        totalOverflow: annual.totalOverflow,
        totalDelivered: annual.totalDelivered,
        totalGridBuy: annual.totalGridBuy,
        totalGridPeak: annual.totalGridPeak,
        totalGridFlat: annual.totalGridFlat,
        totalGridValley: annual.totalGridValley,
        totalV2g: annual.totalV2g,
        totalPvGen: annual.totalPvGen,
        totalShifted: annual.totalShifted,
        totalClipped: annual.totalClipped,
        totalAbandoned: annual.totalAbandoned,
        totalDemand: annual.totalDemand,
        serviceRate: annual.totalDemand > 0 ? annual.totalDelivered / annual.totalDemand : 0,
        maxPeak: annual.maxPeak,
        worstSoc: annual.worstSoc,
        worstMonth: annual.worstMonth,
        monthsWithOverflow: annual.monthsWithOverflow,
        monthsWithSocRisk: annual.monthsWithSocRisk,
        monthsFailed: annual.monthsFailed,
        monthsWarning: annual.monthsWarning,
        annualOpex: annual.totalOpex,
        annualGridCost: annualGridCost,
        annualLCOE: annualLCOE
      }
    };
  }
export {
  clamp,
  percentile,
  seededRandom,
  getGridTouPrice,
  generateMonthlyLedger,
  generateAlignedMonthlyLedger,
  runFlexibleMatrixDispatch,
  runTraditionalPileDispatch,
  runAnnualValidation
};
