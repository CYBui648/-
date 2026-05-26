import { STAGES, STAGE_ORDER } from "../config/system-config.js";
import { dom } from "./dom.js";

const SCENARIOS = [
  { key: "offgrid_rule", label: "离网-规则运行", short: "C1", row: "离网", col: "规则运行" },
  { key: "offgrid_dispatch", label: "离网-优化调度", short: "C2", row: "离网", col: "优化调度" },
  { key: "grid_rule", label: "并网-规则运行", short: "C3", row: "并网", col: "规则运行" },
  { key: "grid_dispatch", label: "并网-优化调度", short: "C4", row: "并网", col: "优化调度" }
];

const chartInstances = new WeakMap();

function n(value, digits = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return number.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function pct(value, digits = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return `${n(number * 100, digits)}%`;
}

function setText(el, value) {
  if (el) el.textContent = value;
}

function getScenario(result, key) {
  return result?.scenarios?.[key] || null;
}

function getScenarioSummary(result, key) {
  return getScenario(result, key)?.summary || {};
}

function getScenarioChart(result, key) {
  const scenario = getScenario(result, key);
  return scenario?.chartData || scenario?.simulation?.chartData || scenario?.stressMonth?.chartData || null;
}

function statusLabel(status) {
  return {
    locked: "未解锁",
    ready: "可运行",
    running: "运行中",
    done: "已完成",
    error: "出错"
  }[status] || status;
}

function stageButtonText(key, status) {
  if (status === "running") return `正在运行 ${key.toUpperCase()}...`;
  if (status === "done") {
    return {
      m1: "重新生成 S0",
      m2: "重新评价四情景",
      m3: "重新优化 C1-C4"
    }[key];
  }
  return {
    m1: "运行 M1 生成 S0",
    m2: "运行 M2 四情景评价",
    m3: "运行 M3 情景化优化"
  }[key];
}

function resetChart(container, message = "暂无数据") {
  if (!container) return;
  const chart = chartInstances.get(container);
  if (chart) chart.dispose();
  chartInstances.delete(container);
  container.innerHTML = `<div class="insight-chart-empty">${message}</div>`;
}

function renderChart(container, option, emptyMessage) {
  if (!container) return;
  if (!window.echarts) {
    resetChart(container, "图表库未加载，数据表仍可查看。");
    return;
  }
  if (!option) {
    resetChart(container, emptyMessage);
    return;
  }
  container.innerHTML = "";
  const oldChart = chartInstances.get(container);
  if (oldChart) oldChart.dispose();
  const chart = window.echarts.init(container);
  chart.setOption(option);
  chartInstances.set(container, chart);
}

function lineOption(series, unit = "") {
  return {
    grid: { left: 42, right: 24, top: 28, bottom: 32 },
    tooltip: { trigger: "axis" },
    legend: { top: 0 },
    xAxis: { type: "category", data: series[0]?.data?.map((_, i) => i + 1) || [] },
    yAxis: { type: "value", name: unit },
    series: series.map((item) => ({ type: "line", showSymbol: false, smooth: true, ...item }))
  };
}

function barOption(labels, series, unit = "") {
  return {
    grid: { left: 48, right: 22, top: 34, bottom: 42 },
    tooltip: { trigger: "axis" },
    legend: { top: 0 },
    xAxis: { type: "category", data: labels },
    yAxis: { type: "value", name: unit },
    series: series.map((item) => ({ type: "bar", barMaxWidth: 32, ...item }))
  };
}

function tableHtml(headers, rows) {
  return `
    <table class="data-table">
      <thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody>
    </table>
  `;
}

function renderJsonResults(state) {
  STAGE_ORDER.forEach((key) => {
    const target = dom.results[key];
    const stage = state.stages[key];
    if (!target || !stage) return;
    if (stage.error) {
      target.textContent = `${key.toUpperCase()} 出错：${stage.error}`;
      return;
    }
    if (!stage.result) {
      target.textContent = stage.status === "locked" ? `${key.toUpperCase()} 尚未解锁。` : `${key.toUpperCase()} 尚未运行。`;
      return;
    }
    const slim = {
      contract: stage.result.contract,
      summary: stage.result.summary,
      hardwarePlan: stage.result.hardwarePlan,
      economics: stage.result.economics,
      offgridBaselineCheck: stage.result.offgridBaselineCheck,
      scenarios: stage.result.scenarios ? Object.fromEntries(
        Object.entries(stage.result.scenarios).map(([scenarioKey, value]) => [scenarioKey, { summary: value.summary }])
      ) : undefined,
      scenarioOptimums: stage.result.scenarioOptimums ? Object.fromEntries(
        Object.entries(stage.result.scenarioOptimums).map(([scenarioKey, value]) => [
          scenarioKey,
          {
            scenarioLabel: value.scenarioLabel,
            recommendedConfig: value.recommendedConfig ? {
              hardwarePlan: value.recommendedConfig.hardwarePlan,
              riskMetrics: value.recommendedConfig.riskMetrics,
              gridMetrics: value.recommendedConfig.gridMetrics,
              costMetrics: value.recommendedConfig.costMetrics
            } : null
          }
        ])
      ) : undefined,
      comparison: stage.result.comparison
    };
    target.textContent = JSON.stringify(slim, null, 2);
  });
}

function renderNavigation(state) {
  dom.stageTabs.forEach((tab) => {
    const key = tab.dataset.stage;
    const stage = state.stages[key];
    tab.classList.toggle("active", state.activeStage === key);
    tab.classList.toggle("locked", stage?.status === "locked");
    tab.disabled = stage?.status === "locked";
  });

  dom.stagePanels.forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === state.activeStage);
  });

  Object.entries(dom.buttons).forEach(([key, button]) => {
    const stage = state.stages[key];
    if (!button || !stage) return;
    button.disabled = stage.status === "locked" || stage.status === "running";
    button.textContent = stageButtonText(key, stage.status);
  });

  const activeMeta = STAGES[state.activeStage] || STAGES.m1;
  setText(dom.stageTitle, activeMeta.title);
  setText(dom.globalStatus, `${activeMeta.title} · ${statusLabel(state.stages[state.activeStage]?.status)}`);
}

function renderTopSummary(state) {
  const doneStages = STAGE_ORDER.filter((key) => state.stages[key]?.status === "done");
  const m1 = state.stages.m1.result;
  const m2 = state.stages.m2.result;
  const m3 = state.stages.m3.result;
  const offgridRule = getScenarioSummary(m2, "offgrid_rule");
  const bestKey = m3?.comparison?.recommendedForEngineering || m3?.comparison?.lowestTotalCostScenario;

  setText(dom.kpis.status, state.stages[state.activeStage]?.status === "running" ? "运行中" : "就绪");
  setText(dom.kpis.stage, state.activeStage.toUpperCase());
  setText(dom.kpis.unlock, doneStages.length ? `已完成 ${doneStages.join(" / ").toUpperCase()}` : "仅 M1");
  setText(dom.kpis.worker, state.workerStatus || "idle");
  setText(dom.kpis.capex, m1?.economics?.capexWan != null ? `${n(m1.economics.capexWan, 1)} 万` : "--");
  setText(dom.kpis.unmet, offgridRule.unservedEnergyKwh != null ? `${n(offgridRule.unservedEnergyKwh, 1)} kWh` : "--");
  setText(dom.kpis.serviceRate, offgridRule.serviceRate != null ? pct(offgridRule.serviceRate, 1) : "--");

  if (m3) {
    const label = SCENARIOS.find((item) => item.key === bestKey)?.label || "四情景优化已完成";
    setText(dom.report.headline, `推荐关注：${label}`);
    setText(dom.report.subtitle, "M3 已给出 C1-C4 四套情景最优配置，可用于论文结果页的横向比较。");
    setText(dom.report.action, "查看 M3");
    setText(dom.report.actionNote, "比较四套方案");
    setText(dom.report.riskMonths, label);
  } else if (m2) {
    setText(dom.report.headline, "S0 四情景运行评价已完成");
    setText(dom.report.subtitle, "M2 已暴露离网缺口、并网购电与调度价值，下一步进入 M3 分情景优化。");
    setText(dom.report.action, "运行 M3");
    setText(dom.report.actionNote, "生成 C1-C4");
    setText(dom.report.riskMonths, offgridRule.unservedEnergyKwh > 0 ? "离网缺口" : "待比较");
  } else if (m1) {
    setText(dom.report.headline, "S0 离网基准配置已生成");
    setText(dom.report.subtitle, "M1 已完成标准周设计需求与基础硬件配置，下一步用压力月事件流进行四情景评价。");
    setText(dom.report.action, "运行 M2");
    setText(dom.report.actionNote, "评价 S0");
    setText(dom.report.riskMonths, "待 M2 识别");
  } else {
    setText(dom.report.headline, "等待 M1 生成 S0 基准配置");
    setText(dom.report.subtitle, "完成三阶段计算后，这里会汇总基准配置、四情景风险与最终情景化推荐。");
    setText(dom.report.action, "运行 M1");
    setText(dom.report.actionNote, "生成 S0");
    setText(dom.report.riskMonths, "--");
  }
  setText(dom.report.capex, m1?.economics?.capexWan != null ? n(m1.economics.capexWan, 1) : "--");
  setText(dom.report.service, offgridRule.serviceRate != null ? pct(offgridRule.serviceRate, 1) : "--");
}

function renderM1(state) {
  const result = state.stages.m1.result;
  const el = dom.m1Summary;
  if (!result) {
    setText(el.title, "尚未生成 S0");
    setText(el.meta, "M1 输出是基准配置，不代表最终推荐方案。");
    ["pv", "storage", "pcs", "piles", "capex", "dailyKwh"].forEach((key) => setText(el[key], "--"));
    resetChart(el.powerChart, "运行 M1 后展示标准周 EV 负荷与 PV。");
    resetChart(el.occupancyChart, "运行 M1 后展示快慢充占用需求。");
    resetChart(el.capexChart, "运行 M1 后展示投资构成。");
    if (el.checkTable) el.checkTable.innerHTML = `<div class="empty-note">运行 M1 后展示 S0 自洽性校验。</div>`;
    return;
  }

  const plan = result.hardwarePlan || {};
  const economics = result.economics || {};
  const demand = result.demandProfile || {};
  const check = result.offgridBaselineCheck || {};
  const chart = result.chartData || {};
  setText(el.title, "S0 离网基准配置已生成");
  setText(el.meta, `${result.summary?.city || "--"} · 标准周日均需求 ${n(demand.totalDailyKwh, 1)} kWh/day · S0 将传递给 M2`);
  setText(el.pv, n(plan.pvKw, 1));
  setText(el.storage, n(plan.storageKwh, 1));
  setText(el.pcs, n(plan.pcsKw, 1));
  setText(el.piles, `${plan.n7kw || 0} / ${plan.n30kw || 0}`);
  setText(el.capex, n(economics.capexWan, 1));
  setText(el.dailyKwh, n(demand.totalDailyKwh, 1));

  renderChart(el.powerChart, lineOption([
    { name: "EV 负荷", data: chart.ev || [] },
    { name: "PV 出力", data: chart.pv || [] },
    { name: "SOC", data: chart.soc || [] }
  ], "kW / %"), "运行 M1 后展示标准周 EV 负荷与 PV。");

  renderChart(el.occupancyChart, lineOption([
    { name: "快充占用", data: chart.fastOcc || [] },
    { name: "慢充占用", data: chart.slowOcc || [] }
  ], "个"), "运行 M1 后展示快慢充占用需求。");

  renderChart(el.capexChart, {
    tooltip: { trigger: "item" },
    series: [{
      type: "pie",
      radius: ["42%", "70%"],
      data: [
        { name: "PV", value: economics.pvCapexWan || 0 },
        { name: "储能", value: (economics.storageEnergyCapexWan || 0) + (economics.storagePowerCapexWan || 0) },
        { name: "充电桩", value: economics.chargerCapexWan || 0 },
        { name: "EMS", value: economics.emsCapexWan || 0 }
      ]
    }]
  }, "运行 M1 后展示投资构成。");

  el.checkTable.innerHTML = tableHtml(
    ["指标", "结果", "状态"],
    [
      ["典型情景未满足电量", `${n(check.unservedKwh, 1)} kWh`, check.unservedKwh <= 1 ? "通过" : "提示"],
      ["供能满足率", pct(check.serviceRate, 2), check.serviceRate >= 0.99 ? "通过" : "风险"],
      ["最低 SOC", `${n(check.socMinPct, 1)}%`, check.socMinPct >= 8 ? "通过" : "风险"],
      ["弃光率", `${n(check.curtailmentRatePct, 1)}%`, "参考"],
      ["PV 自供电量", `${n(check.pvDirectToLoadKwh, 1)} kWh`, "参考"]
    ]
  );
}

function scenarioCard(result, scenario) {
  const summary = getScenarioSummary(result, scenario.key);
  const isGrid = scenario.key.startsWith("grid_");
  const metrics = isGrid
    ? [
      ["购电量", `${n(summary.gridImportKwh, 1)} kWh`],
      ["峰值功率", `${n(summary.peakLoadKw, 1)} kW`],
      ["购电成本", `${n(summary.gridCostYuan, 1)} 元`],
      ["电网依赖", pct(summary.gridDependencyRate, 1)]
    ]
    : [
      ["未满足电量", `${n(summary.unservedEnergyKwh, 1)} kWh`],
      ["服务满足率", pct(summary.serviceRate, 1)],
      ["最低 SOC", `${n(summary.socMinPct, 1)}%`],
      ["缺口时长", `${n(summary.deficitHours || summary.blackoutHours || 0, 1)} h`]
    ];
  return `
    <article class="scenario-card ${scenario.key}">
      <div class="scenario-head"><span>${scenario.row}</span><strong>${scenario.label}</strong><small>${scenario.col}</small></div>
      <div class="scenario-metrics">${metrics.map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join("")}</div>
    </article>
  `;
}

function renderM2(state) {
  const result = state.stages.m2.result;
  const m1 = state.stages.m1.result;
  const el = dom.m2Summary;
  if (m1) {
    const plan = m1.hardwarePlan || {};
    const economics = m1.economics || {};
    el.s0Summary.innerHTML = `
      <div><span>PV</span><strong>${n(plan.pvKw, 1)} kW</strong></div>
      <div><span>储能</span><strong>${n(plan.storageKwh, 1)} kWh</strong></div>
      <div><span>PCS</span><strong>${n(plan.pcsKw, 1)} kW</strong></div>
      <div><span>慢/快充</span><strong>${plan.n7kw || 0} / ${plan.n30kw || 0}</strong></div>
      <div><span>S0 投资</span><strong>${n(economics.capexWan, 1)} 万元</strong></div>
    `;
  } else {
    el.s0Summary.innerHTML = `<div class="empty-note">请先运行 M1 生成 S0。</div>`;
  }

  if (!result) {
    setText(el.title, "等待 M2 运行");
    setText(el.meta, "完成后显示四情景矩阵、SOC 曲线与调度/并网价值。");
    el.scenarioMatrix.innerHTML = SCENARIOS.map((scenario) => scenarioCard(null, scenario)).join("");
    el.comparisonTable.innerHTML = `<div class="empty-note">运行 M2 后展示核心指标对比。</div>`;
    el.valueCards.innerHTML = `<div class="empty-note">运行 M2 后展示调度价值与电网接入价值。</div>`;
    resetChart(el.socChart, "运行 M2 后展示四情景 SOC 曲线。");
    resetChart(el.unservedChart, "运行 M2 后展示离网缺口对比。");
    resetChart(el.gridChart, "运行 M2 后展示并网购电对比。");
    return;
  }

  setText(el.title, "S0 四情景运行评价已完成");
  setText(el.meta, `${result.summary?.monthName || "压力月"} · ${result.summary?.scenarioCount || 4} 个情景 · M2 不做硬件优化`);
  el.scenarioMatrix.innerHTML = SCENARIOS.map((scenario) => scenarioCard(result, scenario)).join("");

  const rows = [
    ["未满足电量", ...SCENARIOS.map((s) => `${n(getScenarioSummary(result, s.key).unservedEnergyKwh, 1)} kWh`)],
    ["服务满足率", ...SCENARIOS.map((s) => pct(getScenarioSummary(result, s.key).serviceRate, 1))],
    ["最低 SOC", ...SCENARIOS.map((s) => `${n(getScenarioSummary(result, s.key).socMinPct, 1)}%`)],
    ["购电量", ...SCENARIOS.map((s) => s.key.startsWith("grid_") ? `${n(getScenarioSummary(result, s.key).gridImportKwh, 1)} kWh` : "--")],
    ["购电成本", ...SCENARIOS.map((s) => s.key.startsWith("grid_") ? `${n(getScenarioSummary(result, s.key).gridCostYuan, 1)} 元` : "--")],
    ["电网依赖率", ...SCENARIOS.map((s) => s.key.startsWith("grid_") ? pct(getScenarioSummary(result, s.key).gridDependencyRate, 1) : "--")]
  ];
  el.comparisonTable.innerHTML = tableHtml(["指标", ...SCENARIOS.map((s) => s.label)], rows);

  renderChart(el.socChart, lineOption(SCENARIOS.map((scenario) => ({
    name: scenario.label,
    data: getScenarioChart(result, scenario.key)?.soc || []
  })), "%"), "运行 M2 后展示四情景 SOC 曲线。");

  renderChart(el.unservedChart, barOption(["离网-规则", "离网-调度"], [{
    name: "未满足电量",
    data: [
      getScenarioSummary(result, "offgrid_rule").unservedEnergyKwh || 0,
      getScenarioSummary(result, "offgrid_dispatch").unservedEnergyKwh || 0
    ]
  }], "kWh"), "运行 M2 后展示离网缺口对比。");

  renderChart(el.gridChart, barOption(["并网-规则", "并网-调度"], [
    {
      name: "购电量",
      data: [
        getScenarioSummary(result, "grid_rule").gridImportKwh || 0,
        getScenarioSummary(result, "grid_dispatch").gridImportKwh || 0
      ]
    },
    {
      name: "购电成本",
      data: [
        getScenarioSummary(result, "grid_rule").gridCostYuan || 0,
        getScenarioSummary(result, "grid_dispatch").gridCostYuan || 0
      ]
    }
  ]), "kWh / 元", "运行 M2 后展示并网购电对比。");

  const comparison = result.comparison || {};
  el.valueCards.innerHTML = `
    <div class="value-card"><span>离网调度价值</span><strong>缺口降低 ${n(comparison.dispatchGainOffgrid?.unservedReductionKwh, 1)} kWh</strong><small>服务率提升 ${pct(comparison.dispatchGainOffgrid?.serviceRateGain || 0, 2)}</small></div>
    <div class="value-card"><span>并网调度价值</span><strong>购电成本降低 ${n(comparison.dispatchGainGrid?.gridCostReductionYuan, 1)} 元</strong><small>购电量降低 ${n(comparison.dispatchGainGrid?.gridImportReductionKwh, 1)} kWh</small></div>
    <div class="value-card"><span>电网接入价值</span><strong>缺口降低 ${n(comparison.gridAccessGain?.unservedReductionKwh, 1)} kWh</strong><small>服务率提升 ${pct(comparison.gridAccessGain?.serviceRateGain || 0, 2)}</small></div>
  `;
}

function getOptimum(result, key) {
  return result?.scenarioOptimums?.[key]?.recommendedConfig || null;
}

function optimumCard(result, scenario) {
  const item = getOptimum(result, scenario.key);
  const plan = item?.hardwarePlan || {};
  const risk = item?.riskMetrics || {};
  const grid = item?.gridMetrics || {};
  const cost = item?.costMetrics || {};
  return `
    <article class="scenario-card optimum ${scenario.key}">
      <div class="scenario-head"><span>${scenario.short}</span><strong>${scenario.label}</strong><small>情景最优配置</small></div>
      <div class="scenario-metrics">
        <div><span>PV</span><strong>${n(plan.pvKw, 1)} kW</strong></div>
        <div><span>储能</span><strong>${n(plan.storageKwh, 1)} kWh</strong></div>
        <div><span>PCS</span><strong>${n(plan.pcsKw, 1)} kW</strong></div>
        <div><span>追加投资</span><strong>${n(cost.extraCapexWan, 1)} 万元</strong></div>
        <div><span>未满足电量</span><strong>${n(risk.unservedEnergyKwh, 1)} kWh</strong></div>
        <div><span>电网依赖</span><strong>${scenario.key.startsWith("grid_") ? pct(grid.gridDependencyRate, 1) : "--"}</strong></div>
      </div>
    </article>
  `;
}

function renderM3(state) {
  const result = state.stages.m3.result;
  const m2 = state.stages.m2.result;
  const el = dom.m3Summary;
  if (m2) {
    el.riskSummary.innerHTML = SCENARIOS.map((scenario) => {
      const summary = getScenarioSummary(m2, scenario.key);
      const main = scenario.key.startsWith("grid_")
        ? `购电 ${n(summary.gridImportKwh, 1)} kWh，成本 ${n(summary.gridCostYuan, 1)} 元`
        : `缺口 ${n(summary.unservedEnergyKwh, 1)} kWh，最低 SOC ${n(summary.socMinPct, 1)}%`;
      return `<div><span>${scenario.label}</span><strong>${main}</strong></div>`;
    }).join("");
  } else {
    el.riskSummary.innerHTML = `<div class="empty-note">请先运行 M2 形成四情景风险摘要。</div>`;
  }

  if (!result) {
    setText(el.title, "等待 M3 运行");
    setText(el.meta, "完成后输出四套情景最优配置与工程推荐。");
    el.optimumCards.innerHTML = SCENARIOS.map((scenario) => optimumCard(null, scenario)).join("");
    el.comparisonTable.innerHTML = `<div class="empty-note">运行 M3 后展示 C1-C4 横向比较。</div>`;
    el.recommendation.innerHTML = `<div class="empty-note">运行 M3 后生成离网、并网与综合工程推荐。</div>`;
    resetChart(el.capexChart, "运行 M3 后展示投资成本对比。");
    resetChart(el.capacityChart, "运行 M3 后展示设备容量对比。");
    resetChart(el.costChart, "运行 M3 后展示综合成本对比。");
    return;
  }

  setText(el.title, "C1-C4 四情景配置优化已完成");
  setText(el.meta, `候选配置 ${result.candidateCount || result.summary?.candidateCount || 0} 组 · 四情景分别筛选最优`);
  el.optimumCards.innerHTML = SCENARIOS.map((scenario) => optimumCard(result, scenario)).join("");

  const rows = [
    ["PV 容量", ...SCENARIOS.map((s) => `${n(getOptimum(result, s.key)?.hardwarePlan?.pvKw, 1)} kW`)],
    ["储能容量", ...SCENARIOS.map((s) => `${n(getOptimum(result, s.key)?.hardwarePlan?.storageKwh, 1)} kWh`)],
    ["PCS 功率", ...SCENARIOS.map((s) => `${n(getOptimum(result, s.key)?.hardwarePlan?.pcsKw, 1)} kW`)],
    ["追加投资", ...SCENARIOS.map((s) => `${n(getOptimum(result, s.key)?.costMetrics?.extraCapexWan, 1)} 万元`)],
    ["综合成本", ...SCENARIOS.map((s) => `${n(getOptimum(result, s.key)?.costMetrics?.totalCostProxyWan, 1)} 万元`)],
    ["未满足电量", ...SCENARIOS.map((s) => `${n(getOptimum(result, s.key)?.riskMetrics?.unservedEnergyKwh, 1)} kWh`)],
    ["服务满足率", ...SCENARIOS.map((s) => pct(getOptimum(result, s.key)?.riskMetrics?.serviceRate, 1))],
    ["电网依赖率", ...SCENARIOS.map((s) => s.key.startsWith("grid_") ? pct(getOptimum(result, s.key)?.gridMetrics?.gridDependencyRate, 1) : "--")]
  ];
  el.comparisonTable.innerHTML = tableHtml(["指标", ...SCENARIOS.map((s) => `${s.short} ${s.label}`)], rows);

  const labels = SCENARIOS.map((scenario) => scenario.short);
  renderChart(el.capexChart, barOption(labels, [{
    name: "追加投资",
    data: SCENARIOS.map((scenario) => getOptimum(result, scenario.key)?.costMetrics?.extraCapexWan || 0)
  }], "万元"), "运行 M3 后展示投资成本对比。");

  renderChart(el.capacityChart, barOption(labels, [
    { name: "PV", data: SCENARIOS.map((scenario) => getOptimum(result, scenario.key)?.hardwarePlan?.pvKw || 0) },
    { name: "储能", data: SCENARIOS.map((scenario) => getOptimum(result, scenario.key)?.hardwarePlan?.storageKwh || 0) },
    { name: "PCS", data: SCENARIOS.map((scenario) => getOptimum(result, scenario.key)?.hardwarePlan?.pcsKw || 0) }
  ], "kW / kWh"), "运行 M3 后展示设备容量对比。");

  renderChart(el.costChart, barOption(labels, [{
    name: "综合成本",
    data: SCENARIOS.map((scenario) => getOptimum(result, scenario.key)?.costMetrics?.totalCostProxyWan || 0)
  }], "万元"), "运行 M3 后展示综合成本对比。");

  const comparison = result.comparison || {};
  const engineeringKey = comparison.recommendedForEngineering || comparison.lowestTotalCostScenario || "grid_dispatch";
  const engineering = SCENARIOS.find((scenario) => scenario.key === engineeringKey);
  el.recommendation.innerHTML = `
    <div class="recommendation-row"><span>离网优先</span><strong>C2 离网-优化调度</strong><small>相比 C1，关注硬件冗余节省与缺口控制。</small></div>
    <div class="recommendation-row"><span>并网优先</span><strong>C4 并网-优化调度</strong><small>相比 C3，关注购电成本与峰值功率下降。</small></div>
    <div class="recommendation-row primary"><span>综合工程</span><strong>${engineering?.short || "--"} ${engineering?.label || "--"}</strong><small>由综合成本、可靠性和电网依赖共同排序得到。</small></div>
    <div class="recommendation-row"><span>调度价值</span><strong>离网节省 ${n(comparison.dispatchValueOffgrid?.capexSavingWan, 1)} 万元</strong><small>并网综合成本节省 ${n(comparison.dispatchValueGrid?.totalCostSavingWan, 1)} 万元。</small></div>
  `;
}

export function renderApp(state) {
  renderNavigation(state);
  renderTopSummary(state);
  renderM1(state);
  renderM2(state);
  renderM3(state);
  renderJsonResults(state);
}
