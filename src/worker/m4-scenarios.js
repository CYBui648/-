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

function buildAdaptivePMatrixCandidates(matrixPowerGapKw) {
  const diagnosedGap = safeNumber(matrixPowerGapKw, 0);
  const anchorGapKw = diagnosedGap > 0 ? diagnosedGap : 50;

  const stepKw =
    anchorGapKw <= 40
      ? 5
      : anchorGapKw <= 120
        ? 10
        : 25;

  const rawCandidates = [0.5, 1.0, 1.5].map((factor) =>
    ceilToStep(anchorGapKw * factor, stepKw)
  );

  const candidates = uniqueSortedPositive(rawCandidates);

  while (candidates.length < 3) {
    const last = candidates[candidates.length - 1] || stepKw;
    candidates.push(last + stepKw);
  }

  return candidates.slice(0, 3);
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
  const matrixPowerRisk = diagnosis.matrixPowerRisk || {};
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
    deltaMatrix: 0,
    deltaPMatrixKw: 0
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
          matrixPowerRisk.active
            ? `矩阵功率池受限风险等级：${matrixPowerRisk.level}`
            : null,

          diagnosis.stressMatrixQueueVehicleTicks > 0
            ? `压力月矩阵接口排队车时 ${diagnosis.stressMatrixQueueVehicleTicks}`
            : null,
          diagnosis.annualMatrixQueueVehicleTicks > 0
            ? `全年矩阵接口排队车时 ${diagnosis.annualMatrixQueueVehicleTicks}`
            : null,

          diagnosis.stressPMatrixLimitedEnergyKwh > 0
            ? `压力月 P_matrix 受限能量 ${round(diagnosis.stressPMatrixLimitedEnergyKwh, 1)} kWh`
            : null,
          diagnosis.annualPMatrixLimitedEnergyKwh > 0
            ? `全年 P_matrix 受限能量 ${round(diagnosis.annualPMatrixLimitedEnergyKwh, 1)} kWh`
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
    const hasPortRisk = accessPortRisk.active === true;
    const hasPowerPoolRisk = matrixPowerRisk.active === true;

    if (hasPortRisk || hasPowerPoolRisk) {
      const matrixCandidatesByLevel = {
        low: [
          { deltaMatrix: 2 },
          { deltaMatrix: 4 },
          { deltaMatrix: 6 }
        ],
        medium: [
          { deltaMatrix: 4 },
          { deltaMatrix: 6 },
          { deltaMatrix: 8 }
        ],
        high: [
          { deltaMatrix: 6 },
          { deltaMatrix: 10 },
          { deltaMatrix: 14 }
        ]
      };

      const matrixCandidates =
        hasPortRisk
          ? (
              matrixCandidatesByLevel[accessPortRisk.level] ||
              matrixCandidatesByLevel.medium
            )
          : [
              { deltaMatrix: 0 },
              { deltaMatrix: 0 },
              { deltaMatrix: 0 }
            ];

      const matrixPowerGapKw = Math.max(
        safeNumber(diagnosis.stressPMatrixMaxGapKw, 0),
        safeNumber(diagnosis.annualPMatrixMaxGapKw, 0)
      );

      const pMatrixCandidates =
        hasPowerPoolRisk
          ? buildAdaptivePMatrixCandidates(matrixPowerGapKw)
          : [0, 0, 0];

      for (let index = 0; index < 3; index += 1) {
        const deltaMatrix =
          safeNumber(matrixCandidates[index]?.deltaMatrix, 0);

        const deltaPMatrixKw =
          safeNumber(pMatrixCandidates[index], 0);

        const labelParts = [];

        if (deltaMatrix > 0) {
          labelParts.push(`N_matrix +${deltaMatrix}`);
        }

        if (deltaPMatrixKw > 0) {
          labelParts.push(`P_matrix +${deltaPMatrixKw} kW`);
        }

        const label =
          labelParts.length > 0
            ? labelParts.join(" / ")
            : "未触发";

        scenarios.push(
          makeScenario({
            id: `S3-${index + 1}`,
            family: "S3",
            title: "S3 柔性矩阵服务能力加固",
            variantLabel: label,
            intent:
              "围绕柔性矩阵路线，联合测试接口端口扩容与矩阵功率池扩容，对接入拥堵与功率池受限风险的修复效果。",
            triggerBasis: [
              ...s3TriggerBasis,
              `候选档位：${label}`
            ],
            deltas: {
              deltaMatrix,
              deltaPMatrixKw
            }
          })
        );
      }
    } else {
      scenarios.push(
        makeScenario({
          id: "S3-0",
          family: "S3",
          title: "S3 柔性矩阵服务能力加固",
          variantLabel: "未触发",
          intent:
            "当前矩阵接口拥堵风险与功率池受限风险均不突出，本轮不主动生成柔性矩阵服务侧扩容候选。",
          triggerBasis: ["无显著矩阵服务侧风险，保留为说明性占位方案。"],
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
    deltaMatrix: 0,
    deltaPMatrixKw: 0
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
      merged.deltaPMatrixKw += safeNumber(d.deltaPMatrixKw, 0);
    });

    return merged;
  };

  const collectMeaningfulCandidates = (family) => {
    return safeList.filter((scenario) =>
      scenario.family === family &&
      scenario.familyEffectiveness?.isMeaningful === true
    );
  };

  const pickLowInvestmentCandidate = (candidates) => {
    if (!candidates.length) return null;

    return [...candidates].sort((a, b) => {
      const capexDiff =
        safeNumber(a.extraCapexWan, Infinity) -
        safeNumber(b.extraCapexWan, Infinity);

      if (capexDiff !== 0) return capexDiff;

      return (
        safeNumber(b.familyEffectiveness?.primaryReductionRate, 0) -
        safeNumber(a.familyEffectiveness?.primaryReductionRate, 0)
      );
    })[0];
  };

  const pickBalancedCandidate = (candidates) => {
    if (!candidates.length) return null;

    return [...candidates].sort((a, b) => {
      const scoreDiff =
        safeNumber(b.recommendation?.totalScore, 0) -
        safeNumber(a.recommendation?.totalScore, 0);

      if (scoreDiff !== 0) return scoreDiff;

      return (
        safeNumber(b.familyEffectiveness?.primaryReductionRate, 0) -
        safeNumber(a.familyEffectiveness?.primaryReductionRate, 0)
      );
    })[0];
  };

  const pickHighProtectionCandidate = (candidates) => {
    if (!candidates.length) return null;

    return [...candidates].sort((a, b) => {
      const rateDiff =
        safeNumber(b.familyEffectiveness?.primaryReductionRate, 0) -
        safeNumber(a.familyEffectiveness?.primaryReductionRate, 0);

      if (rateDiff !== 0) return rateDiff;

      return (
        safeNumber(a.extraCapexWan, Infinity) -
        safeNumber(b.extraCapexWan, Infinity)
      );
    })[0];
  };

  const familyCandidatePools = {
    S1: collectMeaningfulCandidates("S1"),
    S2: collectMeaningfulCandidates("S2"),
    S3: collectMeaningfulCandidates("S3")
  };

  const activeFamilies = Object.entries(familyCandidatePools)
    .filter(([, candidates]) => candidates.length > 0)
    .map(([family]) => family);

  // 至少两类专项风险都形成有效改善，才生成综合工程候选族
  if (activeFamilies.length < 2) {
    return [];
  }

  const profileSpecs = [
    {
      profileKey: "low",
      variantLabel: "低投资综合改善型",
      intent:
        "在同时回应多个已验证有效的主导风险方向前提下，优先控制新增投资，形成低成本的综合改进候选。",
      picker: pickLowInvestmentCandidate
    },
    {
      profileKey: "balanced",
      variantLabel: "均衡综合推荐型",
      intent:
        "在多个主导风险的联合改善、投资水平与综合评分之间寻求折中，形成当前更均衡的工程候选。",
      picker: pickBalancedCandidate
    },
    {
      profileKey: "high",
      variantLabel: "高保障综合改善型",
      intent:
        "在同时回应多个已验证有效的主导风险方向前提下，优先追求更强的专项风险改善能力，形成高保障候选。",
      picker: pickHighProtectionCandidate
    }
  ];

  const compositeDrafts = profileSpecs
    .map((profile) => {
      const components = activeFamilies
        .map((family) =>
          profile.picker(familyCandidatePools[family])
        )
        .filter(Boolean);

      if (components.length !== activeFamilies.length) {
        return null;
      }

      const mergedDeltas = mergeDeltas(components);
      const componentScenarioIds = components.map((scenario) => scenario.id);
      const componentFamilies = components.map((scenario) => scenario.family);

      return {
        family: "S4",
        title: "S4 综合平衡方案",
        variantLabel: profile.variantLabel,
        intent: profile.intent,
        triggerBasis: [
          `综合覆盖方向：${componentFamilies.join(" + ")}`,
          `组合来源：${componentScenarioIds.join(" + ")}`,
          "生成规则：当前 S4 不再只做两两专项拼装，而是对所有已验证有效的主导风险方向进行同风格综合组合。",
          ...components
            .map((scenario) => scenario.familyEffectiveness?.note || null)
            .filter(Boolean)
        ],
        deltas: mergedDeltas,
        compositeMeta: {
          profileKey: profile.profileKey,
          componentScenarioIds,
          componentFamilies
        }
      };
    })
    .filter(Boolean);

  // 若低投资 / 均衡 / 高保障恰好选出完全一致的硬件组合，则去重
  const uniqueDrafts = [];
  const seenDeltaSignatures = new Set();

  compositeDrafts.forEach((draft) => {
    const d = draft.deltas || {};
    const signature = [
      safeNumber(d.deltaPvKw, 0),
      safeNumber(d.deltaStorageKwh, 0),
      safeNumber(d.deltaPcsKw, 0),
      safeNumber(d.deltaTransformerKw, 0),
      safeNumber(d.deltaN7, 0),
      safeNumber(d.deltaN30, 0),
      safeNumber(d.deltaMatrix, 0),
      safeNumber(d.deltaPMatrixKw, 0)
    ].join("|");

    if (seenDeltaSignatures.has(signature)) return;

    seenDeltaSignatures.add(signature);
    uniqueDrafts.push(draft);
  });

  return uniqueDrafts.map((draft, index) => ({
    id: `S4-${index + 1}`,
    ...draft
  }));
}
