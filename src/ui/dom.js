export const dom = {
  stageTabs: [...document.querySelectorAll("[data-stage]")],
  stagePanels: [...document.querySelectorAll("[data-panel]")],
  stageTitle: document.getElementById("active-stage-title"),
  globalStatus: document.getElementById("global-status"),
  kpis: {
    status: document.getElementById("kpi-status"),
    stage: document.getElementById("kpi-stage"),
    unlock: document.getElementById("kpi-unlock"),
    worker: document.getElementById("kpi-worker"),
    capex: document.getElementById("kpi-capex"),
    unmet: document.getElementById("kpi-unmet"),
    serviceRate: document.getElementById("kpi-service-rate")
  },
  report: {
    headline: document.getElementById("report-headline"),
    subtitle: document.getElementById("report-subtitle"),
    action: document.getElementById("report-action"),
    actionNote: document.getElementById("report-action-note"),
    capex: document.getElementById("report-capex"),
    service: document.getElementById("report-service"),
    riskMonths: document.getElementById("report-risk-months")
  },
  buttons: {
    m1: document.getElementById("run-m1"),
    m2: document.getElementById("run-m2"),
    m3: document.getElementById("run-m3")
  },
  results: {
    m1: document.getElementById("result-m1"),
    m2: document.getElementById("result-m2"),
    m3: document.getElementById("result-m3")
  },
  m1Inputs: [...document.querySelectorAll("[data-m1-input]")],
  m2Inputs: [...document.querySelectorAll("[data-m2-input]")],
  m3Inputs: [...document.querySelectorAll("[data-m3-input]")],
  m2CsvFile: document.getElementById("m2-csv-file"),
  m2CsvStatus: document.getElementById("m2-csv-status"),
  m1Summary: {
    title: document.getElementById("m1-summary-title"),
    meta: document.getElementById("m1-summary-meta"),
    pv: document.getElementById("m1-pv"),
    storage: document.getElementById("m1-storage"),
    pcs: document.getElementById("m1-pcs"),
    piles: document.getElementById("m1-piles"),
    capex: document.getElementById("m1-capex"),
    dailyKwh: document.getElementById("m1-daily-kwh"),
    capexChart: document.getElementById("m1-capex-echart"),
    powerChart: document.getElementById("m1-power-echart"),
    occupancyChart: document.getElementById("m1-occupancy-chart"),
    checkTable: document.getElementById("m1-check-table")
  },
  m2Summary: {
    title: document.getElementById("m2-summary-title"),
    meta: document.getElementById("m2-summary-meta"),
    s0Summary: document.getElementById("m2-s0-summary"),
    scenarioMatrix: document.getElementById("m2-scenario-matrix"),
    comparisonTable: document.getElementById("m2-comparison-table"),
    socChart: document.getElementById("m2-soc-chart"),
    unservedChart: document.getElementById("m2-unserved-chart"),
    gridChart: document.getElementById("m2-grid-chart"),
    valueCards: document.getElementById("m2-value-cards")
  },
  m3Summary: {
    title: document.getElementById("m3-summary-title"),
    meta: document.getElementById("m3-summary-meta"),
    riskSummary: document.getElementById("m3-risk-summary"),
    optimumCards: document.getElementById("m3-optimum-cards"),
    comparisonTable: document.getElementById("m3-comparison-table"),
    capexChart: document.getElementById("m3-capex-chart"),
    capacityChart: document.getElementById("m3-capacity-chart"),
    costChart: document.getElementById("m3-cost-chart"),
    recommendation: document.getElementById("m3-recommendation")
  }
};
