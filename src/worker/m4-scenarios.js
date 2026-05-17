import { maxRiskLevel } from "./m4-risk-diagnosis.js";

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function safeNumber(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function ceilToStep(value, step) {
  const safeValue = safeNumber(value, 0);
  const safeStep = Math.max(1, safeNumber(step, 1));
  return Math.ceil(safeValue / safeStep) * safeStep;
}

function uniqueSortedPositive(values) {
  return [...new Set(
    values
      .map((value) => safeNumber(value, 0))
      .filter((value) => value > 0)
  )].sort((a, b) => a - b);
}

function buildAdaptiveTransformerCandidates(transformerGapKw) {
  const diagnosedGap = safeNumber(transformerGapKw, 0);

  const anchorGapKw = diagnosedGap > 0 ? diagnosedGap : 25;

  const stepKw =
    anchorGapKw <= 40
      ? 5
      : anchorGapKw <= 120
        ? 10
        : 25;

  const rawCandidates = [0.4, 0.7, 1.0, 1.3].map((factor) =>
    ceilToStep(anchorGapKw * factor, stepKw)
  );

  const candidates = uniqueSortedPositive(rawCandidates);

  while (candidates.length < 4) {
    const last = candidates[candidates.length - 1] || stepKw;
    candidates.push(last + stepKw);
  }

  return candidates;
}

export function buildScenarioPlans(base, diagnosis) {
  const routeKey = base.selectedRouteKey;

  const residualUnmet = safeNumber(diagnosis.residualUnmetKwh, 0);
  const residualQueue = safeNumber(diagnosis.residualQueueUnmetKwh, 0);
  const transformerGap = safeNumber(diagnosis.transformerGapKw, 0);

  const powerRisk = diagnosis.powerRisk || {};
  const energyRisk = diagnosis.energyRisk || {};
  const storageRisk = diagnosis.storageRisk || {};
  const accessPortRisk = diagnosis.accessPortRisk || {};
  const deliveryServiceRisk = diagnosis.deliveryServiceRisk || {};

  const annualTotalUnmet =
    safeNumber(diagnosis.annualTotalUnmetKwh, 0);
  const annualTotalQueueUnmet =
    safeNumber(diagnosis.annualTotalQueueUnmetKwh, 0);
  const annualTotalOverflow =
    safeNumber(diagnosis.annualTotalOverflowCount, 0);
  const annualMonthsWithOverflow =
    safeNumber(diagnosis.annualMonthsWithOverflow, 0);
  const annualMonthsWithSocRisk =
    safeNumber(diagnosis.annualMonthsWithSocRisk, 0);

  const zeroDeltas = () => ({
    deltaPvKw: 0,
    deltaStorageKwh: 0,
    deltaPcsKw: 0,
    deltaTransformerKw: 0,
    deltaN7: 0,
    deltaN30: 0,
    deltaMatrix: 0
  });

  const makeScenario = ({
    id,
    family,
    title,
    variantLabel,
    intent,
    triggerBasis,
    deltas
  }) => ({
    id,
    family,
    title,
    variantLabel,
    intent,
    triggerBasis,
    deltas: { ...zeroDeltas(), ...(deltas || {}) }
  });

  const combinedEnergyLevel =
    maxRiskLevel(energyRisk.level, storageRisk.level);

  // ============================================================
  // 1. 各方案族的统一解释口径
  // ============================================================

  const s1TriggerBasis = [
    powerRisk.active ? `功率风险等级：${powerRisk.level}` : null,
    transformerGap > 0
      ? `压力月峰值超出变压器边界 ${round(transformerGap, 1)} kW`
      : null,
    diagnosis.residualOverflowCount > 0
      ? `压力月残余越限 ${diagnosis.residualOverflowCount} 次`
      : null,
    annualTotalOverflow > 0
      ? `全年累计越限 ${annualTotalOverflow} 次`
      : null,
    annualMonthsWithOverflow > 0
      ? `全年越限月份 ${annualMonthsWithOverflow} 个`
      : null
  ].filter(Boolean);

  const s2TriggerBasis = [
    energyRisk.active ? `能量风险等级：${energyRisk.level}` : null,
    storageRisk.active ? `SOC 风险等级：${storageRisk.level}` : null,
    residualUnmet > 0
      ? `压力月残余未满足电量 ${round(residualUnmet, 1)} kWh`
      : null,
    annualTotalUnmet > 0
      ? `全年累计未满足电量 ${round(annualTotalUnmet, 1)} kWh`
      : null,
    diagnosis.residualSocMinPct < 8
      ? `压力月最低 SOC ${diagnosis.residualSocMinPct}%`
      : null,
    annualMonthsWithSocRisk > 0
      ? `全年 SOC 风险月份 ${annualMonthsWithSocRisk} 个`
      : null
  ].filter(Boolean);

  const s3TriggerBasis =
    routeKey === "traditional_pile"
      ? [
          deliveryServiceRisk.active
            ? `接入服务风险等级：${deliveryServiceRisk.level}`
            : null,
          residualQueue > 0
            ? `压力月排队损失 ${round(residualQueue, 1)} kWh`
            : null,
          annualTotalQueueUnmet > 0
            ? `全年累计排队损失 ${round(annualTotalQueueUnmet, 1)} kWh`
            : null
        ].filter(Boolean)
      : [
          accessPortRisk.active
            ? `矩阵接口拥堵风险等级：${accessPortRisk.level}`
            : null,
          residualQueue > 0
            ? `压力月排队损失 ${round(residualQueue, 1)} kWh`
            : null,
          annualTotalQueueUnmet > 0
            ? `全年累计排队损失 ${round(annualTotalQueueUnmet, 1)} kWh`
            : null
        ].filter(Boolean);

  // ============================================================
  // 2. 基准方案 S0
  // ============================================================

  const scenarios = [
    makeScenario({
      id: "S0",
      family: "S0",
      title: "S0 基准对照",
      variantLabel: "基准",
      intent: "不新增硬件，保留 M3 已选路线，作为所有加固候选的比较基线。",
      triggerBasis: ["作为基准对照方案，不针对残余风险新增硬件。"],
      deltas: zeroDeltas()
    })
  ];

  // ============================================================
  // 3. S1：功率瓶颈加固候选族
  // ============================================================

  if (powerRisk.active) {
    const transformerCandidates =
      buildAdaptiveTransformerCandidates(transformerGap);

    transformerCandidates.forEach((deltaTransformerKw, index) => {
      scenarios.push(
        makeScenario({
          id: `S1-${index + 1}`,
          family: "S1",
          title: "S1 接入功率边界加固",
          variantLabel: `接入容量 +${deltaTransformerKw} kW`,
          intent:
            "针对并网功率越限与接入边界不足，测试不同变压器 / 接入容量扩容档位对越限风险的修复效果。",
          triggerBasis: [
            ...s1TriggerBasis,
            `候选档位：接入容量增量 ${deltaTransformerKw} kW`
          ],
          deltas: {
            deltaTransformerKw
          }
        })
      );
    });
  } else {
    scenarios.push(
      makeScenario({
        id: "S1-0",
        family: "S1",
        title: "S1 接入功率边界加固",
        variantLabel: "未触发",
        intent: "当前功率边界风险不突出，本轮不主动生成接入容量扩容搜索候选。",
        triggerBasis: ["无显著功率风险，保留为说明性占位方案。"],
        deltas: zeroDeltas()
      })
    );
  }

  // ============================================================
  // 4. S2：能量 / 储能韧性候选族
  // ============================================================

  if (energyRisk.active || storageRisk.active) {
    const s2CandidatesByLevel = {
      low: [
        { deltaStorageKwh: 100, deltaPvKw: 0, deltaPcsKw: 0, label: "储能 +100 kWh" },
        { deltaStorageKwh: 150, deltaPvKw: 25, deltaPcsKw: 0, label: "储能 +150 kWh / 光伏 +25 kW" }
      ],
      medium: [
        { deltaStorageKwh: 150, deltaPvKw: 0, deltaPcsKw: 0, label: "储能 +150 kWh" },
        { deltaStorageKwh: 250, deltaPvKw: 25, deltaPcsKw: 0, label: "储能 +250 kWh / 光伏 +25 kW" },
        { deltaStorageKwh: 300, deltaPvKw: 50, deltaPcsKw: 25, label: "储能 +300 kWh / 光伏 +50 kW / PCS +25 kW" }
      ],
      high: [
        { deltaStorageKwh: 200, deltaPvKw: 0, deltaPcsKw: 0, label: "储能 +200 kWh" },
        { deltaStorageKwh: 300, deltaPvKw: 50, deltaPcsKw: 0, label: "储能 +300 kWh / 光伏 +50 kW" },
        { deltaStorageKwh: 400, deltaPvKw: 75, deltaPcsKw: 25, label: "储能 +400 kWh / 光伏 +75 kW / PCS +25 kW" }
      ]
    };

    const s2Candidates =
      s2CandidatesByLevel[combinedEnergyLevel] ||
      s2CandidatesByLevel.medium;

    s2Candidates.forEach((candidate, index) => {
      scenarios.push(
        makeScenario({
          id: `S2-${index + 1}`,
          family: "S2",
          title: "S2 储能韧性加固",
          variantLabel: candidate.label,
          intent: "围绕能量缺口与 SOC 韧性风险，测试不同储能、光伏及少量 PCS 组合的修复能力。",
          triggerBasis: [
            ...s2TriggerBasis,
            `候选档位：${candidate.label}`
          ],
          deltas: {
            deltaStorageKwh: candidate.deltaStorageKwh,
            deltaPvKw: candidate.deltaPvKw,
            deltaPcsKw: candidate.deltaPcsKw
          }
        })
      );
    });
  } else {
    scenarios.push(
      makeScenario({
        id: "S2-0",
        family: "S2",
        title: "S2 储能韧性加固",
        variantLabel: "未触发",
        intent: "当前能量与 SOC 风险不突出，本轮不主动生成储能加固搜索候选。",
        triggerBasis: ["无显著能量/SOC 风险，保留为说明性占位方案。"],
        deltas: zeroDeltas()
      })
    );
  }

  // ============================================================
  // 5. S3：服务能力加固候选族
  // ============================================================

  if (routeKey === "traditional_pile") {
    if (deliveryServiceRisk.active) {
      const serviceCandidatesByLevel = {
        low: [
          { deltaN7: 2, deltaN30: 1, label: "7kW +2 / 30kW +1" },
          { deltaN7: 4, deltaN30: 2, label: "7kW +4 / 30kW +2" }
        ],
        medium: [
          { deltaN7: 2, deltaN30: 1, label: "7kW +2 / 30kW +1" },
          { deltaN7: 4, deltaN30: 2, label: "7kW +4 / 30kW +2" },
          { deltaN7: 6, deltaN30: 3, label: "7kW +6 / 30kW +3" }
        ],
        high: [
          { deltaN7: 4, deltaN30: 2, label: "7kW +4 / 30kW +2" },
          { deltaN7: 8, deltaN30: 4, label: "7kW +8 / 30kW +4" },
          { deltaN7: 12, deltaN30: 6, label: "7kW +12 / 30kW +6" }
        ]
      };

      const serviceCandidates =
        serviceCandidatesByLevel[deliveryServiceRisk.level] ||
        serviceCandidatesByLevel.medium;

      serviceCandidates.forEach((candidate, index) => {
        scenarios.push(
          makeScenario({
            id: `S3-${index + 1}`,
            family: "S3",
            title: "S3 服务能力加固",
            variantLabel: candidate.label,
            intent: "围绕传统桩站路线，测试有限固定桩扩容阶梯对排队损失与服务交付风险的改善效果。",
            triggerBasis: [
              ...s3TriggerBasis,
              `候选档位：${candidate.label}`
            ],
            deltas: {
              deltaN7: candidate.deltaN7,
              deltaN30: candidate.deltaN30
            }
          })
        );
      });
    } else {
      scenarios.push(
        makeScenario({
          id: "S3-0",
          family: "S3",
          title: "S3 服务能力加固",
          variantLabel: "未触发",
          intent: "当前传统桩服务风险不突出，本轮不主动生成固定桩扩容搜索候选。",
          triggerBasis: ["无显著传统桩接入服务风险，保留为说明性占位方案。"],
          deltas: zeroDeltas()
        })
      );
    }
  } else {
    if (accessPortRisk.active) {
      const matrixCandidatesByLevel = {
        low: [
          { deltaMatrix: 2, label: "N_matrix +2" },
          { deltaMatrix: 4, label: "N_matrix +4" }
        ],
        medium: [
          { deltaMatrix: 4, label: "N_matrix +4" },
          { deltaMatrix: 6, label: "N_matrix +6" },
          { deltaMatrix: 8, label: "N_matrix +8" }
        ],
        high: [
          { deltaMatrix: 6, label: "N_matrix +6" },
          { deltaMatrix: 10, label: "N_matrix +10" },
          { deltaMatrix: 14, label: "N_matrix +14" }
        ]
      };

      const matrixCandidates =
        matrixCandidatesByLevel[accessPortRisk.level] ||
        matrixCandidatesByLevel.medium;

      matrixCandidates.forEach((candidate, index) => {
        scenarios.push(
          makeScenario({
            id: `S3-${index + 1}`,
            family: "S3",
            title: "S3 服务能力加固",
            variantLabel: candidate.label,
            intent: "围绕柔性矩阵路线，测试不同接口扩容档位对矩阵端口拥堵风险的修复效果。",
            triggerBasis: [
              ...s3TriggerBasis,
              `候选档位：${candidate.label}`
            ],
            deltas: {
              deltaMatrix: candidate.deltaMatrix
            }
          })
        );
      });
    } else {
      scenarios.push(
        makeScenario({
          id: "S3-0",
          family: "S3",
          title: "S3 服务能力加固",
          variantLabel: "未触发",
          intent: "当前矩阵接口拥堵风险不突出，本轮不主动生成 N_matrix 扩容搜索候选。",
          triggerBasis: ["无显著矩阵接口拥堵风险，保留为说明性占位方案。"],
          deltas: zeroDeltas()
        })
      );
    }
  }

  return scenarios;
}

export function buildCompositeScenarioPlans(
  scoredSpecialized,
  diagnosis,
  routeKey
) {
  const safeList = Array.isArray(scoredSpecialized)
    ? scoredSpecialized
    : [];

  const zeroDeltas = () => ({
    deltaPvKw: 0,
    deltaStorageKwh: 0,
    deltaPcsKw: 0,
    deltaTransformerKw: 0,
    deltaN7: 0,
    deltaN30: 0,
    deltaMatrix: 0
  });

  const mergeDeltas = (scenarios) => {
    const merged = zeroDeltas();

    scenarios.forEach((scenario) => {
      const d = scenario?.deltas || {};
      merged.deltaPvKw += safeNumber(d.deltaPvKw, 0);
      merged.deltaStorageKwh += safeNumber(d.deltaStorageKwh, 0);
      merged.deltaPcsKw += safeNumber(d.deltaPcsKw, 0);
      merged.deltaTransformerKw += safeNumber(d.deltaTransformerKw, 0);
      merged.deltaN7 += safeNumber(d.deltaN7, 0);
      merged.deltaN30 += safeNumber(d.deltaN30, 0);
      merged.deltaMatrix += safeNumber(d.deltaMatrix, 0);
    });

    return merged;
  };

  const selectRepresentative = (family) => {
    const candidates = safeList.filter((scenario) =>
      scenario.family === family &&
      scenario.familyEffectiveness?.isMeaningful === true
    );

    if (!candidates.length) return null;

    const bestRate = Math.max(
      ...candidates.map((scenario) =>
        safeNumber(
          scenario.familyEffectiveness?.primaryReductionRate,
          -Infinity
        )
      )
    );

    const nearBest = candidates.filter((scenario) => {
      const rate = safeNumber(
        scenario.familyEffectiveness?.primaryReductionRate,
        -Infinity
      );

      return bestRate - rate <= 0.05;
    });

    return [...nearBest].sort((a, b) =>
      safeNumber(b.recommendation?.totalScore, 0) -
      safeNumber(a.recommendation?.totalScore, 0)
    )[0] || candidates[0];
  };

  const selectS1CompositePool = () => {
    const candidates = safeList.filter((scenario) =>
      scenario.family === "S1" &&
      scenario.familyEffectiveness?.isMeaningful === true
    );

    if (!candidates.length) return [];

    const sorted = [...candidates].sort((a, b) =>
      safeNumber(a.deltas?.deltaTransformerKw, 0) -
      safeNumber(b.deltas?.deltaTransformerKw, 0)
    );

    if (sorted.length <= 3) {
      return sorted;
    }

    const first = sorted[0];
    const middle = sorted[Math.floor((sorted.length - 1) / 2)];
    const last = sorted[sorted.length - 1];

    return [first, middle, last].filter(
      (scenario, index, array) =>
        array.findIndex((item) => item.id === scenario.id) === index
    );
  };

  const representativeS1 = selectRepresentative("S1");
  const representativeS2 = selectRepresentative("S2");
  const representativeS3 = selectRepresentative("S3");

  const s1CompositePool = selectS1CompositePool();

  const reps = {
    S1: representativeS1,
    S2: representativeS2,
    S3: representativeS3
  };

  const activeFamilies = Object.entries(reps)
    .filter(([, scenario]) => Boolean(scenario))
    .map(([family]) => family);

  // 至少需要两类专项风险都形成有效候选，才生成综合方案
  if (activeFamilies.length < 2) {
    return [];
  }

  const pairSpecs = [];

  if (representativeS1 && representativeS2) {
    pairSpecs.push([representativeS1, representativeS2]);
  }

  if (s1CompositePool.length > 0 && representativeS3) {
    s1CompositePool.forEach((s1Scenario) => {
      pairSpecs.push([s1Scenario, representativeS3]);
    });
  }

  if (representativeS2 && representativeS3) {
    pairSpecs.push([representativeS2, representativeS3]);
  }

  return pairSpecs.map((pair, index) => {
    const [a, b] = pair;
    const mergedDeltas = mergeDeltas(pair);

    return {
      id: `S4-${index + 1}`,
      family: "S4",
      title: "S4 综合平衡方案",
      variantLabel: `${a.id} + ${b.id}`,
      intent:
        "将两个已通过专项复验、且对主导风险形成有效改善的加固方向进行组合，检验联合加固是否带来更均衡的工程结果。",
      triggerBasis: [
        `组合来源：${a.id} + ${b.id}`,
        "组合规则：仅组合已被仿真判定为有效改善的专项候选。",
        a.familyEffectiveness?.note || null,
        b.familyEffectiveness?.note || null
      ].filter(Boolean),
      deltas: mergedDeltas,
      compositeMeta: {
        componentScenarioIds: [a.id, b.id],
        componentFamilies: [a.family, b.family]
      }
    };
  });
}
