export const STAGES = {
  m1: {
    key: "m1",
    index: 1,
    title: "M1 基准规划",
    jobType: "M1_PLAN"
  },
  m2: {
    key: "m2",
    index: 2,
    title: "M2 压力测试",
    jobType: "M2_STRESS_TEST"
  },
  m3: {
    key: "m3",
    index: 3,
    title: "M3 调度诊断",
    jobType: "M3_DISPATCH_DIAGNOSIS"
  },
  m4: {
    key: "m4",
    index: 4,
    title: "M4 方案定型",
    jobType: "M4_FINALIZE_PLAN"
  }
};

export const STAGE_ORDER = ["m1", "m2", "m3", "m4"];

export const DEFAULT_PROJECT_INPUT = {
  projectName: "公共机构停车场光储充评估",
  m1: {
    climateKey: "guangzhou",
    evCount: 100,
    teacherRatio: 0.80,
    batteryCapMean: 65,
    initSocMean: 0.40,
    targetSocMean: 0.95,
    slaFast: 0.95,
    slaSlow: 0.85,
    renewableTarget: 0.50,
    backupDays: 0,
    holidayRatio: 0.10,
    pvEfficiency: 0.72,
    pvPrice: 1.50,
    pvRate: 15,
    storBasePrice: 1.00,
    storRate: 12,
    cost7kw: 0.30,
    cost30kw: 2.50,
    ems: 10,
    roofArea: 10000,
    evRatio: 3,
    anxietyRatio: 0.20,
    mileage: 30,
    consumption: 15
  },
  m2: {
    monthMode: "auto",
    monthIndex: 0,
    transformerLimitKw: 500,
    teacherRatio: 0.80,
    anxietyRatio: 0.20,
    gTiltData: null,
    gTiltStatus: "尚未加载 TMY CSV"
  },
  m3: {
    useV2G: true,
    priceShiftThreshold: 0.55,
    clipThreshold: 0.90,
    minClipSlackHours: 2,
    maxV2gPerEvKwh: 8,
    v2gWearCostYuanPerKwh: 0.15,
    opexRate: 0.015,
    selectedRoute: null
  },
  m4: {
    scenarioCapexWeight: 0.18,
    scenarioRiskWeight: 0.44,
    scenarioGridWeight: 0.16,
    scenarioPvWeight: 0.10,
    scenarioLcoeWeight: 0.12
  }
};
