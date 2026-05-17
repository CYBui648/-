import { maxRiskLevel } from "./m4-risk-diagnosis.js";

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function safeNumber(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function ceilTo(value, step) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil(value / step) * step;
}

function applyPowerDeltaByLevel(baseDelta, level) {
  if (level === "low") return Math.max(0, ceilTo(baseDelta * 0.4, 25));
  if (level === "high") return Math.max(0, ceilTo(baseDelta * 0.9, 25));
  return Math.max(0, ceilTo(baseDelta * 0.65, 25)); // medium (default)
}

function applyEnergyDeltaByLevel(baseDelta, level) {
  if (level === "low") return Math.max(0, ceilTo(baseDelta * 0.4, 50));
  if (level === "high") return Math.max(0, ceilTo(baseDelta * 0.9, 50));
  return Math.max(0, ceilTo(baseDelta * 0.65, 50)); // medium
}

function applyServiceDeltaByLevel(baseDelta, level) {
  if (level === "low") return Math.max(1, Math.ceil(baseDelta * 0.35));
  if (level === "high") return Math.max(1, Math.ceil(baseDelta * 0.9));
  return Math.max(1, Math.ceil(baseDelta * 0.65)); // medium
}

export function buildScenarioPlans(base, diagnosis) {
  const pvBase = base.config.P_pv;
  const essBase = base.config.E_storage;
  const pcsBase = base.config.P_storage;
  const routeKey = base.selectedRouteKey;
  const residualUnmet = safeNumber(diagnosis.residualUnmetKwh, 0);
  const residualQueue = safeNumber(diagnosis.residualQueueUnmetKwh, 0);
  const transformerGap = safeNumber(diagnosis.transformerGapKw, 0);
  const powerRisk = diagnosis.powerRisk || {};
  const energyRisk = diagnosis.energyRisk || {};
  const serviceRisk = diagnosis.serviceRisk || {};
  const storageRisk = diagnosis.storageRisk || {};

  const powerDelta = ceilTo(Math.max(transformerGap * 0.9, pcsBase * 0.25, powerRisk.active ? 25 : 0), 25);
  const energyDelta = ceilTo(Math.max(residualUnmet * 0.05, essBase * 0.35, storageRisk.active ? 100 : 0, energyRisk.active ? 75 : 0), 50);
  const pvDelta = ceilTo(Math.max(residualUnmet * 0.02, energyRisk.active ? pvBase * 0.10 : 0), 25);

  // S3 只在真实接入拥堵时加桩/矩阵，不受 residualUnmet 误导
  const pileDelta = serviceRisk.active
    ? Math.max(1, Math.ceil(residualQueue / 600))
    : 0;
  const matrixDelta = serviceRisk.active
    ? Math.max(2, Math.ceil(residualQueue / 900))
    : 0;

  const serviceDelta = routeKey === "traditional_pile"
    ? {
        deltaN7: pileDelta,
        deltaN30: serviceRisk.active
          ? Math.max(0, Math.ceil(pileDelta / 2))
          : 0,
        deltaMatrix: 0
      }
    : {
        deltaN7: 0,
        deltaN30: 0,
        deltaMatrix: matrixDelta
      };

  // S4 纳入 storageRisk：SOC 风险也触发储能加固
  const s4Deltas = { deltaPvKw: 0, deltaStorageKwh: 0, deltaPcsKw: 0, deltaN7: 0, deltaN30: 0, deltaMatrix: 0 };

  if (powerRisk.active && powerRisk.level) {
    s4Deltas.deltaPcsKw = applyPowerDeltaByLevel(powerDelta, powerRisk.level);
  }
  if (
    (energyRisk.active && energyRisk.level) ||
    (storageRisk.active && storageRisk.level)
  ) {
    const combinedEnergyLevel = maxRiskLevel(energyRisk.level, storageRisk.level);
    s4Deltas.deltaStorageKwh = applyEnergyDeltaByLevel(energyDelta, combinedEnergyLevel);
    s4Deltas.deltaPvKw = energyRisk.active
      ? applyEnergyDeltaByLevel(pvDelta, combinedEnergyLevel)
      : 0;
  }
  if (serviceRisk.active && serviceRisk.level) {
    if (routeKey === "traditional_pile") {
      s4Deltas.deltaN7 = applyServiceDeltaByLevel(serviceDelta.deltaN7, serviceRisk.level);
      s4Deltas.deltaN30 = applyServiceDeltaByLevel(serviceDelta.deltaN30, serviceRisk.level);
    } else {
      s4Deltas.deltaMatrix = applyServiceDeltaByLevel(serviceDelta.deltaMatrix, serviceRisk.level);
    }
  }

  // 动态 intent 文案
  const s1Intent = powerRisk.active
    ? "针对并网功率越限或峰值功率瓶颈，优先增强 PCS / 功率支撑能力，压低运行边界风险。"
    : "当前功率边界风险不突出，本方案保留为功率侧专项加固备选。";

  const s2Intent =
    energyRisk.active && storageRisk.active
      ? "针对供电缺口与 SOC 安全边界双重风险，补充储能容量并辅以适度光伏增量。"
      : energyRisk.active
        ? "针对残余供电缺口，优先提升系统能量供给与日内搬移能力。"
        : storageRisk.active
          ? "针对最低 SOC 安全边界不足，优先补充储能韧性。"
          : "当前能量风险不突出，本方案保留为能量侧专项加固备选。";

  const s3Intent = serviceRisk.active
    ? (
        routeKey === "traditional_pile"
          ? "围绕传统桩站路线，补充固定桩位服务能力，缓解排队与接入拥堵。"
          : "围绕柔性调度路线，扩大矩阵接入能力，缓解排队与接入拥堵。"
      )
    : "当前接入型服务风险不突出，本方案不主动扩大充电接口。";

  // triggerBasis 解释每个方案"为什么生成"
  const s1TriggerBasis = [
    powerRisk.active ? `功率风险等级：${powerRisk.level}` : null,
    transformerGap > 0 ? `峰值超出变压器边界 ${round(transformerGap, 1)} kW` : null,
    diagnosis.residualOverflowCount > 0
      ? `残余越限次数 ${diagnosis.residualOverflowCount} 次`
      : null
  ].filter(Boolean);

  const s2TriggerBasis = [
    energyRisk.active ? `能量风险等级：${energyRisk.level}` : null,
    storageRisk.active ? `SOC 风险等级：${storageRisk.level}` : null,
    residualUnmet > 0 ? `残余未满足电量 ${round(residualUnmet, 1)} kWh` : null,
    diagnosis.residualSocMinPct < 8
      ? `最低 SOC ${diagnosis.residualSocMinPct}%`
      : null
  ].filter(Boolean);

  const s3TriggerBasis = [
    serviceRisk.active ? `接入型服务风险等级：${serviceRisk.level}` : null,
    residualQueue > 0 ? `残余排队损失 ${round(residualQueue, 1)} kWh` : null
  ].filter(Boolean);

  const s4TriggerBasis = [
    powerRisk.active ? `功率风险 ${powerRisk.level}` : null,
    energyRisk.active ? `能量风险 ${energyRisk.level}` : null,
    storageRisk.active ? `SOC 风险 ${storageRisk.level}` : null,
    serviceRisk.active ? `接入服务风险 ${serviceRisk.level}` : null
  ].filter(Boolean);

  return [
    {
      id: "S0",
      title: "S0 基准对照",
      intent: "不新增硬件，保留 M3 已选路线，作为所有加固方案的比较基线。",
      triggerBasis: ["作为基准对照方案，不针对残余风险新增硬件。"],
      deltas: { deltaPvKw: 0, deltaStorageKwh: 0, deltaPcsKw: 0, deltaN7: 0, deltaN30: 0, deltaMatrix: 0 }
    },
    {
      id: "S1",
      title: "S1 功率瓶颈加固",
      intent: s1Intent,
      triggerBasis: s1TriggerBasis.length > 0 ? s1TriggerBasis : ["无显著功率风险，保留为备选。"],
      deltas: { deltaPvKw: 0, deltaStorageKwh: 0, deltaPcsKw: powerDelta, deltaN7: 0, deltaN30: 0, deltaMatrix: 0 }
    },
    {
      id: "S2",
      title: "S2 储能韧性加固",
      intent: s2Intent,
      triggerBasis: s2TriggerBasis.length > 0 ? s2TriggerBasis : ["无显著能量/SOC 风险，保留为备选。"],
      deltas: { deltaPvKw: pvDelta, deltaStorageKwh: energyDelta, deltaPcsKw: Math.min(powerDelta, 25), deltaN7: 0, deltaN30: 0, deltaMatrix: 0 }
    },
    {
      id: "S3",
      title: "S3 服务能力加固",
      intent: s3Intent,
      triggerBasis: s3TriggerBasis.length > 0 ? s3TriggerBasis : ["无显著接入拥堵，不扩大充电接口。"],
      deltas: { deltaPvKw: 0, deltaStorageKwh: 0, deltaPcsKw: 0, ...serviceDelta }
    },
    {
      id: "S4",
      title: "S4 综合平衡方案",
      intent: "按实际残余风险等级自适应组合功率、能量/SOC 与服务增量，避免一刀切中档配置。",
      triggerBasis: s4TriggerBasis.length > 0 ? s4TriggerBasis : ["无显著残余风险，保持基准配置。"],
      deltas: s4Deltas
    }
  ];
}
