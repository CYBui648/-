const GZ = {
    panelEfficiency: 0.21, workdayDays: 250, holidayDays: 115,
    monthlyOccupancy: [0.5, 0.05, 1.0, 1.0, 1.0, 0.5, 0.05, 0.05, 1.0, 1.0, 1.0, 0.5],
    monthlyRainProb: [0.065, 0.15, 0.25, 0.40, 0.516, 0.667, 0.60, 0.60, 0.50, 0.30, 0.20, 0.10],
    monthlyHPS: [126.5, 114.2, 131.1, 126.9, 165.5, 160.2, 165.5, 165.5, 160.2, 141.4, 136.8, 126.5],
    rainOutputRange: [0.10, 0.30], efficiencyDirect: 0.92, electricityPrice: 0.65,
    gridTouPrice: { valley: 0.28, flat: 0.65, peak: 0.85 },
    hourlyPvShape: [0,0,0,0,0,0, 0.05, 0.2, 0.5, 0.8, 1.0, 0.95, 0.8, 0.5, 0.2, 0.05, 0,0,0,0,0,0,0,0]
  };

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MONTH_NAMES = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
const TICKS_PER_DAY = 96;
const DAYS_PER_YEAR = 365;
const TICKS_PER_YEAR = DAYS_PER_YEAR * TICKS_PER_DAY;

function getMonthIndexByDay(dayOfYear) {
  let remain = dayOfYear;
  for (let m = 0; m < MONTH_DAYS.length; m++) {
    if (remain < MONTH_DAYS[m]) return m;
    remain -= MONTH_DAYS[m];
  }
  return 11;
}

function getMonthStartDay(monthIndex) {
  let start = 0;
  for (let m = 0; m < monthIndex; m++) start += MONTH_DAYS[m];
  return start;
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

function generateAlignedAnnualLedger(p, seed) {
    const random = seededRandom(seed || 20260513);
    const randomRange = (min, max) => min + random() * (max - min);
    const randNormalLocal = (mean, stdDev) => {
      const u = 1 - random(), v = random();
      return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v) * stdDev + mean;
    };
    const totalDays = DAYS_PER_YEAR;
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
      const monthIndex = getMonthIndexByDay(day);
      const monthlyOccupancy = p.climate?.monthlyOccupancy?.[monthIndex] ?? 1;
      const dayFactor = clamp(
        (isWeekend ? (p.holidayRatio || 0.1) : 1) * monthlyOccupancy,
        0,
        1
      );
      const dayStart = day * TICKS_PER_DAY;

      fixedFleet.forEach(car => {
        if (random() > dayFactor) return;
        car.soc = clamp(car.soc - (car.dailyEnergy / car.capacity), 0.03, 1.00);
        if (car.soc > car.chargeThreshold) return;
        const targetSoc = clamp(randNormalLocal(car.targetSocBase, 0.035), 0.80, 1.00);
        const energyNeed = Math.max(car.dailyEnergy, car.capacity * Math.max(0, targetSoc - car.soc));
        const arriveHour = clamp(randNormalLocal(8.4, 0.55), 7, 10);
        const dwellHours = clamp(randNormalLocal(8.5, 0.75), 6, 10);
        const arriveTick = dayStart + clamp(Math.floor(arriveHour * 4), 0, TICKS_PER_DAY - 1);
        const leaveTick = Math.min((day + 1) * TICKS_PER_DAY, arriveTick + Math.max(2, Math.ceil(dwellHours * 4)));
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
          targetSoc,
          car,
          socWrittenBack: false
        });
        // SOC 回写移至车辆实际离场时按交付结果执行
      });

      const visitorCountToday = Math.round(baseVisitorCount * dayFactor);
      for (let i = 0; i < visitorCountToday; i++) {
        const capacity = randomRange(50, 95);
        const initSoc = randomRange(0.20, 0.70);
        const targetSoc = clamp(randNormalLocal(0.78, 0.08), 0.60, 0.92);
        const arriveHour = clamp(randNormalLocal(random() < 0.55 ? 10.8 : 14.5, 1.15), 8.5, 17);
        const dwellHours = clamp(randNormalLocal(2.4, 0.9), 0.75, 5);
        const arriveTick = dayStart + clamp(Math.floor(arriveHour * 4), 0, TICKS_PER_DAY - 1);
        const leaveTick = Math.min((day + 1) * TICKS_PER_DAY, arriveTick + Math.max(2, Math.ceil(dwellHours * 4)));
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

function writeBackFixedCarSoc(ev) {
  if (!ev?.car || ev.socWrittenBack) return;

  const delivered = Math.max(0, ev.deliveredEnergy || 0);
  const capacity = Math.max(1, ev.car.capacity || 1);

  ev.car.soc = clamp(
    (ev.initSoc || 0) + delivered / capacity,
    0.03,
    ev.targetSoc ?? 1.0
  );

  ev.socWrittenBack = true;
}

function createAnnualDemandState(p, seed) {
  const random = seededRandom(seed || 20260513);
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
  let eventId = 0;

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

  function finalizeEvent(ev) {
    if (ev.energyNeed <= 0) return null;
    const dwellTicks = Math.max(1, ev.leaveTick - ev.arriveTick);
    const minChargeTicks = Math.ceil(ev.energyNeed / (Math.max(1, ev.power) * 0.25));
    const usefulWaitTicks = Math.max(1, dwellTicks - minChargeTicks);
    const maxWaitTicks = ev.type === 'Teacher'
      ? (ev.isAnxious ? Math.max(8, Math.floor(usefulWaitTicks * 0.5)) : usefulWaitTicks)
      : (ev.isAnxious ? Math.max(4, Math.min(8, usefulWaitTicks)) : Math.max(4, Math.min(12, usefulWaitTicks)));
    return {
      ...ev,
      id: ev.id || `D${ev.day + 1}_EV${++eventId}`,
      preferredTag: ev.tag,
      chargeReadyTick: ev.arriveTick,
      deliveredEnergy: 0,
      waitTicks: 0,
      maxWaitTicks,
      status: 'PENDING'
    };
  }

  function generateDayEvents(day) {
    const events = [];
    const isWeekend = day % 7 === 5 || day % 7 === 6;
    const monthIndex = getMonthIndexByDay(day);
    const monthlyOccupancy = p.climate?.monthlyOccupancy?.[monthIndex] ?? 1;
    const dayFactor = clamp((isWeekend ? (p.holidayRatio || 0.1) : 1) * monthlyOccupancy, 0, 1);
    const dayStart = day * TICKS_PER_DAY;

    fixedFleet.forEach(car => {
      // 每天先消耗日常出行电量，使全年 SOC 轨迹真正连续演化
      car.soc = clamp(car.soc - car.dailyEnergy / car.capacity, 0.03, 1.00);

      // 今天是否来到站点
      if (random() > dayFactor) return;

      // SOC 低于阈值才生成充电事件
      if (car.soc > car.chargeThreshold) return;

      const targetSoc = clamp(randNormalLocal(car.targetSocBase, 0.035), 0.80, 1.00);
      const energyNeed = Math.max(car.dailyEnergy, car.capacity * Math.max(0, targetSoc - car.soc));
      const arriveHour = clamp(randNormalLocal(8.4, 0.55), 7, 10);
      const dwellHours = clamp(randNormalLocal(8.5, 0.75), 6, 10);
      const arriveTick = dayStart + clamp(Math.floor(arriveHour * 4), 0, TICKS_PER_DAY - 1);
      const leaveTick = Math.min((day + 1) * TICKS_PER_DAY, arriveTick + Math.max(2, Math.ceil(dwellHours * 4)));
      const isAnxious = random() < anxietyRatio;
      const mustFast = energyNeed / 7 > Math.max(0.5, dwellHours);
      const tag = (mustFast || (isAnxious && random() < 0.35)) ? 'FAST' : 'SLOW';
      const ev = finalizeEvent({
        id: `F${car.id}_D${day + 1}`, day, type: 'Teacher', tag, mustFast,
        arriveTick, leaveTick, energyNeed,
        power: tag === 'FAST' ? 30 : 7, isAnxious,
        initSoc: car.soc, targetSoc, car, socWrittenBack: false
      });
      if (ev) events.push(ev);
    });

    const visitorCountToday = Math.round(baseVisitorCount * dayFactor);
    for (let i = 0; i < visitorCountToday; i++) {
      const capacity = randomRange(50, 95);
      const initSoc = randomRange(0.20, 0.70);
      const targetSoc = clamp(randNormalLocal(0.78, 0.08), 0.60, 0.92);
      const arriveHour = clamp(randNormalLocal(random() < 0.55 ? 10.8 : 14.5, 1.15), 8.5, 17);
      const dwellHours = clamp(randNormalLocal(2.4, 0.9), 0.75, 5);
      const arriveTick = dayStart + clamp(Math.floor(arriveHour * 4), 0, TICKS_PER_DAY - 1);
      const leaveTick = Math.min((day + 1) * TICKS_PER_DAY, arriveTick + Math.max(2, Math.ceil(dwellHours * 4)));
      const wantsCharge = initSoc < 0.45 || random() < 0.35;
      const energyNeed = wantsCharge ? Math.max(0, capacity * (targetSoc - initSoc)) : 0;
      const mustFast = dwellHours < energyNeed / 7;
      const tag = (mustFast || random() < 0.55) ? 'FAST' : 'SLOW';
      const ev = finalizeEvent({
        day, type: 'Visitor', tag, mustFast, arriveTick, leaveTick, energyNeed,
        power: tag === 'FAST' ? 30 : 7, isAnxious: true, initSoc, targetSoc
      });
      if (ev) events.push(ev);
    }
    return events.sort((a, b) => a.arriveTick - b.arriveTick);
  }

  return { fixedFleet, generateDayEvents };
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
      clippedCount: 0,
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

function runTraditionalPileAnnualDispatch(payload) {
    const p = payload.params;
    const cfg = payload.config;
    const econ = payload.economics;
    const totalDays = DAYS_PER_YEAR;
    const totalTicks = TICKS_PER_YEAR;
    const ledgerSeed = Number.isFinite(p.seed) ? p.seed : 20260513;
    const demandState = createAnnualDemandState(p, ledgerSeed);
    const random = seededRandom(ledgerSeed + 901);
    const ledger = [];
    let shiftedCount = 0;
    let delayTicksTotal = 0;

    const prepareTraditionalAnnualEvent = (ev) => {
      const minTicks = Math.ceil(ev.energyNeed / (Math.max(1, ev.power) * 0.25));
      const slackTicks = ev.leaveTick - ev.arriveTick - minTicks;
      const localTick = ev.arriveTick % TICKS_PER_DAY;
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
      if (shifted) {
        shiftedCount++;
        delayTicksTotal += Math.max(0, chargeReadyTick - ev.arriveTick);
      }
      return { ...ev, chargeReadyTick, shifted, priceElasticity, closed: false };
    };

    // Monthly stats buckets
    const monthly = MONTH_DAYS.map((days, month) => ({
      month,
      monthName: MONTH_NAMES[month],
      days,
      realPeak: 0,
      unmetTotal: 0,
      overflowCount: 0,
      socMin: 100,
      deliveredEnergy: 0,
      queueUnmet: 0,
      abandonedCount: 0,
      curtailmentEnergy: 0,
      pvGenEnergy: 0,
      shiftedCount: 0,
      clippedCount: 0,
      eBuyPeak: 0,
      eBuyFlat: 0,
      eBuyValley: 0
    }));

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
      const dayOfYear = Math.floor(tick / TICKS_PER_DAY);
      const currentMonth = getMonthIndexByDay(dayOfYear);
      const monthStat = monthly[currentMonth];

      // 1. Clean chargingList (completed or departed)
      for (let i = chargingList.length - 1; i >= 0; i--) {
        const ev = chargingList[i];
        const done = ev.deliveredEnergy >= ev.energyNeed - 0.001;
        const mustLeave = tick >= ev.leaveTick;
        if (done || mustLeave) {
          chargingList.splice(i, 1);
          if (mustLeave && !done) {
            const gap = Math.max(0, ev.energyNeed - ev.deliveredEnergy);
            unmetTotal += gap;
            monthStat.unmetTotal += gap;
          }
          ev.closed = true;
          writeBackFixedCarSoc(ev);
        }
      }

      // 2. Clean waitingQueue (timeout or departed) — moved before daily generation
      //    so yesterday's abandoned cars have their SOC written back first
      for (let i = waitingQueue.length - 1; i >= 0; i--) {
        const ev = waitingQueue[i];
        ev.waitTicks++;
        if (tick >= ev.leaveTick || ev.waitTicks > ev.maxWaitTicks) {
          waitingQueue.splice(i, 1);
          const gap = Math.max(0, ev.energyNeed);
          queueUnmet += gap;
          unmetTotal += gap;
          abandonedCount++;
          monthStat.queueUnmet += gap;
          monthStat.unmetTotal += gap;
          monthStat.abandonedCount++;
          writeBackFixedCarSoc(ev);
        }
      }

      // 3. Daily dynamic event injection — generate today's events based on real-time car SOC
      if (tick % TICKS_PER_DAY === 0) {
        const dayEvents = demandState.generateDayEvents(dayOfYear);
        const preparedEvents = dayEvents
          .map((ev) => {
            const prepared = prepareTraditionalAnnualEvent(ev);
            if (prepared.shifted) {
              monthly[currentMonth].shiftedCount++;
            }
            return prepared;
          })
          .sort((a, b) => a.chargeReadyTick - b.chargeReadyTick);
        ledger.push(...preparedEvents);
      }

      // 4. Push pending events into waitingQueue
      while (nextPending < ledger.length && ledger[nextPending].chargeReadyTick <= tick) {
        const ev = ledger[nextPending++];
        ev.waitTicks = 0;
        waitingQueue.push(ev);
      }

      // 5. Slot assignment
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

      // 6. Energy supply
      const h = Math.floor((tick % TICKS_PER_DAY) / 4);
      const subTick = tick % 4;
      const hourDataIdx = Math.floor(tick / 4);
      const currentIrr = (p.gTiltData && p.gTiltData.length > hourDataIdx) ? parseFloat(p.gTiltData[hourDataIdx]) : (GZ.hourlyPvShape[h] * 1000 * 0.8);
      const nextIrr = (p.gTiltData && p.gTiltData.length > hourDataIdx + 1) ? parseFloat(p.gTiltData[hourDataIdx + 1]) : (GZ.hourlyPvShape[(h + 1) % 24] * 1000 * 0.8);
      const irradiance = currentIrr + (nextIrr - currentIrr) * (subTick / 4);
      const pvPower = cfg.P_pv * (irradiance / 1000) * p.pvEfficiency * GZ.efficiencyDirect;
      const loadPower = chargingList.reduce((s, ev) => s + ev.power, 0);
      const loadEnergy = loadPower * 0.25;
      pvSeries[tick] = pvPower;
      totalPvGen += pvPower * 0.25;
      monthStat.pvGenEnergy += pvPower * 0.25;
      rawDemandSeries[tick] = loadPower;
      realPeak = Math.max(realPeak, loadPower);
      monthStat.realPeak = Math.max(monthStat.realPeak, loadPower);
      if (loadPower > cfg.transformerLimit) { overflowCount++; monthStat.overflowCount++; }

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
        if (Math.abs(gridPrice - touPrice.valley) < 1e-9) { eBuyValley += gridBuy; monthStat.eBuyValley += gridBuy; }
        else if (Math.abs(gridPrice - touPrice.flat) < 1e-9) { eBuyFlat += gridBuy; monthStat.eBuyFlat += gridBuy; }
        else { eBuyPeak += gridBuy; monthStat.eBuyPeak += gridBuy; }
      }
      const actualDelivered = Math.max(0, Math.min(loadEnergy, availableEnergy));
      if (loadEnergy > 0 && actualDelivered > 0) {
        for (const ev of chargingList) {
          const share = (ev.power * 0.25 / loadEnergy) * actualDelivered;
          const before = ev.deliveredEnergy;
          ev.deliveredEnergy = Math.min(ev.energyNeed, ev.deliveredEnergy + share);
          const deliveredInc = Math.max(0, ev.deliveredEnergy - before);
          deliveredEnergy += deliveredInc;
          monthStat.deliveredEnergy += deliveredInc;
        }
      }
      if (availableEnergy > loadEnergy) {
        const surplus = availableEnergy - loadEnergy;
        const charge = Math.min(surplus, cfg.P_storage * 0.25, cfg.E_storage - soc);
        soc += charge;
        const curtailed = Math.max(0, surplus - charge);
        totalCurtailed += curtailed;
        monthStat.curtailmentEnergy += curtailed;
      }

      queuedPeak = Math.max(queuedPeak, waitingQueue.length);
      chargingPeak = Math.max(chargingPeak, chargingList.length);
      activeSeries[tick] = waitingQueue.length;
      demandSeries[tick] = Math.min(loadPower, cfg.transformerLimit);
      limitSeries[tick] = cfg.transformerLimit;
      const socPct = cfg.E_storage > 0 ? soc / cfg.E_storage * 100 : 0;
      if (cfg.E_storage > 0) { socMin = Math.min(socMin, socPct); monthStat.socMin = Math.min(monthStat.socMin, socPct); }
      socSeries[tick] = socPct;
    }
    const finalMonth = 11;
    for (const ev of chargingList) {
      const gap = Math.max(0, ev.energyNeed - ev.deliveredEnergy);
      unmetTotal += gap;
      monthly[finalMonth].unmetTotal += gap;
      writeBackFixedCarSoc(ev);
    }
    for (const ev of waitingQueue) {
      const gap = Math.max(0, ev.energyNeed);
      queueUnmet += gap;
      unmetTotal += gap;
      abandonedCount++;
      monthly[finalMonth].queueUnmet += gap;
      monthly[finalMonth].unmetTotal += gap;
      monthly[finalMonth].abandonedCount++;
      writeBackFixedCarSoc(ev);
    }

    // Build monthly results
    const monthlyResults = monthly.map((ms, m) => ({
      month: m,
      monthName: ms.monthName,
      days: ms.days,
      realPeak: ms.realPeak,
      unmetTotal: ms.unmetTotal,
      overflowCount: ms.overflowCount,
      socMin: ms.socMin,
      deliveredEnergy: ms.deliveredEnergy,
      queueUnmet: ms.queueUnmet,
      abandonedCount: ms.abandonedCount,
      curtailmentEnergy: ms.curtailmentEnergy,
      pvGenEnergy: ms.pvGenEnergy,
      curtailmentRate: ms.pvGenEnergy > 0 ? ms.curtailmentEnergy / ms.pvGenEnergy * 100 : 0,
      LCOE: 0,
      shiftedCount: ms.shiftedCount,
      clippedCount: ms.clippedCount,
      eBuyPeak: ms.eBuyPeak,
      eBuyFlat: ms.eBuyFlat,
      eBuyValley: ms.eBuyValley
    }));

    // Build annual summary from monthly results
    const annualDelivered = monthlyResults.reduce((s, r) => s + r.deliveredEnergy, 0);
    const annualGridValley = monthlyResults.reduce((s, r) => s + r.eBuyValley, 0);
    const annualGridFlat = monthlyResults.reduce((s, r) => s + r.eBuyFlat, 0);
    const annualGridPeak = monthlyResults.reduce((s, r) => s + r.eBuyPeak, 0);
    const annualGridCost = annualGridValley * (econ.priceGridValley || 0.28) +
      annualGridFlat * (econ.priceGridFlat || 0.65) +
      annualGridPeak * (econ.priceGridPeak || 0.85);
    const annualTotalUnmet = monthlyResults.reduce((s, r) => s + r.unmetTotal, 0);
    const annualDeliveredTotal = Math.max(1, annualDelivered);
    const annualOpex = cfg.baseCapexYuan * (econ.opexRate || 0.015);
    const annualLCOE = annualDeliveredTotal > 0
      ? ((cfg.baseCapexYuan || 0) / 20 + annualOpex + annualGridCost) / annualDeliveredTotal
      : 999;
    const annualDemand = annualDeliveredTotal + annualTotalUnmet;

    const annual = {
      totalUnmet: annualTotalUnmet,
      totalQueueUnmet: monthlyResults.reduce((s, r) => s + r.queueUnmet, 0),
      totalOverflow: monthlyResults.reduce((s, r) => s + r.overflowCount, 0),
      totalDelivered: annualDeliveredTotal,
      totalGridBuy: annualGridValley + annualGridFlat + annualGridPeak,
      totalGridPeak: annualGridPeak,
      totalGridFlat: annualGridFlat,
      totalGridValley: annualGridValley,
      totalPvGen: monthlyResults.reduce((s, r) => s + r.pvGenEnergy, 0),
      totalCurtailed: monthlyResults.reduce((s, r) => s + (r.curtailmentEnergy || 0), 0),
      totalShifted: monthlyResults.reduce((s, r) => s + r.shiftedCount, 0),
      totalClipped: monthlyResults.reduce((s, r) => s + r.clippedCount, 0),
      totalAbandoned: monthlyResults.reduce((s, r) => s + r.abandonedCount, 0),
      totalDemand: annualDemand,
      serviceRate: annualDemand > 0 ? annualDeliveredTotal / annualDemand : 0,
      maxPeak: Math.max(...monthlyResults.map(r => r.realPeak), 0),
      worstSoc: Math.min(...monthlyResults.map(r => r.socMin), 100),
      worstMonth: monthlyResults.reduce((worst, r, i) => r.socMin < monthlyResults[worst].socMin ? i : worst, 0),
      monthsWithOverflow: monthlyResults.filter(r => r.overflowCount > 0).length,
      monthsWithSocRisk: monthlyResults.filter(r => r.socMin < 8).length,
      monthsFailed: monthlyResults.reduce((arr, r, i) => { if (r.socMin < 8) arr.push(i); return arr; }, []),
      monthsWarning: monthlyResults.reduce((arr, r, i) => { if (r.overflowCount > 0) arr.push(i); return arr; }, []),
      annualOpex,
      annualGridCost,
      annualLCOE
    };

    return {
      monthly: monthlyResults,
      annual,
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
  const result = runTraditionalPileAnnualDispatch(payload);

  return {
    preferred: "traditional_pile",
    monthly: result.monthly,
    annual: result.annual,
    chartData: result.chartData || null
  };
}
export {
  clamp,
  percentile,
  seededRandom,
  getGridTouPrice,
  generateMonthlyLedger,
  generateAlignedMonthlyLedger,
  generateAlignedAnnualLedger,
  runTraditionalPileDispatch,
  runTraditionalPileAnnualDispatch,
  runAnnualValidation
};
