import { STAGES, STAGE_ORDER } from "../config/system-config.js";
import { dom } from "./dom.js";

function getStageStatusLabel(status) {
  return {
    locked: "未解锁",
    ready: "待运行",
    running: "运行中",
    done: "已完成",
    error: "出错"
  }[status] || status;
}

function getUnlockedSummary(state) {
  return STAGE_ORDER
    .filter((key) => state.stages[key].status !== "locked")
    .map((key) => STAGES[key].title)
    .join(" / ");
}

function formatNumber(value, digits = 1) {
  if (!Number.isFinite(value)) return "--";
  return value.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function formatPercent(value, digits = 1) {
  if (!Number.isFinite(value)) return "--";
  return (value * 100).toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

const MONTH_LABELS = [
  "1月", "2月", "3月", "4月", "5月", "6月",
  "7月", "8月", "9月", "10月", "11月", "12月"
];

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function resetAnnualChart(container, emptyText = "暂无数据") {
  if (!container) return;
  container.innerHTML = `<div class="annual-chart-empty">${emptyText}</div>`;
}

function renderAnnualBarChart(container, values, options = {}) {
  if (!container) return;

  const {
    maxValue = Math.max(...values, 1),
    formatter = (v) => String(v),
    dangerJudge = () => false,
    inverse = false
  } = options;

  if (!Array.isArray(values) || values.length === 0) {
    resetAnnualChart(container);
    return;
  }

  container.innerHTML = values.map((value, index) => {
    const rawRatio = maxValue > 0 ? value / maxValue : 0;
    const ratio = inverse ? 1 - clamp01(rawRatio) : clamp01(rawRatio);
    const heightPct = Math.max(6, ratio * 100);
    const danger = dangerJudge(value, index);

    return `
      <div class="annual-bar-item ${danger ? "danger" : ""}">
        <div class="annual-bar-value">${formatter(value)}</div>
        <div class="annual-bar-track">
          <div class="annual-bar-fill" style="height:${heightPct}%"></div>
        </div>
        <div class="annual-bar-label">${MONTH_LABELS[index] || `${index + 1}月`}</div>
      </div>
    `;
  }).join("");
}

function monthLabel(index) {
  return MONTH_LABELS[index] || `${index + 1}月`;
}

function getTopRiskMonths(monthlyUnmet, monthlyService, monthlyOverflow, monthlySoc) {
  const maxUnmet = Math.max(...monthlyUnmet, 1);
  const maxOverflow = Math.max(...monthlyOverflow, 1);

  return monthlyUnmet
    .map((unmet, index) => {
      const service = monthlyService[index] ?? 1;
      const overflow = monthlyOverflow[index] ?? 0;
      const soc = monthlySoc[index] ?? 100;

      const unmetScore = unmet > 0 ? unmet / maxUnmet : 0;
      const serviceScore = service < 0.95 ? (0.95 - service) / 0.95 : 0;
      const overflowScore = overflow > 0 ? overflow / maxOverflow : 0;
      const socScore = soc < 8 ? (8 - soc) / 8 : 0;

      const score =
        unmetScore * 0.40 +
        serviceScore * 0.30 +
        overflowScore * 0.15 +
        socScore * 0.15;

      return { index, label: monthLabel(index), score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

function getAnnualMainRisk(annual) {
  const totalUnmet = Number(annual?.totalUnmetKwh || 0);
  const serviceRate = Number(annual?.serviceRate || 0);
  const overflowMonths = Number(annual?.monthsWithOverflow || 0);
  const socRiskMonths = Number(annual?.monthsWithSocRisk || 0);

  if (totalUnmet > 0 && serviceRate < 0.95) return "服务缺口偏高";
  if (socRiskMonths > 0) return "储能韧性不足";
  if (overflowMonths > 0) return "配电越限仍存在";
  if (totalUnmet > 0) return "仍有交付缺口";
  return "无显著年度残余风险";
}

function getAnnualJudgement(annual) {
  const totalUnmet = Number(annual?.totalUnmetKwh || 0);
  const serviceRate = Number(annual?.serviceRate || 0);
  const overflowMonths = Number(annual?.monthsWithOverflow || 0);
  const socRiskMonths = Number(annual?.monthsWithSocRisk || 0);

  if (totalUnmet <= 0 && serviceRate >= 0.99 && overflowMonths === 0 && socRiskMonths === 0) {
    return "全年表现基本稳健";
  }
  return "仍需进入 M4 加固";
}

function getM4FocusText(annual) {
  const totalUnmet = Number(annual?.totalUnmetKwh || 0);
  const serviceRate = Number(annual?.serviceRate || 0);
  const overflowMonths = Number(annual?.monthsWithOverflow || 0);
  const socRiskMonths = Number(annual?.monthsWithSocRisk || 0);

  if (socRiskMonths > 0 && totalUnmet > 0) return "优先补储能韧性与服务交付";
  if (overflowMonths > 0) return "优先压降功率越限风险";
  if (serviceRate < 0.95 || totalUnmet > 0) return "优先修复全年服务缺口";
  return "重点比较工程代价与稳健性";
}

function renderTabs(state) {
  dom.stageTabs.forEach((tab) => {
    const stageKey = tab.dataset.stage;
    const stage = state.stages[stageKey];
    tab.classList.toggle("active", state.activeStage === stageKey);
    tab.classList.toggle("locked", stage.status === "locked");
  });
}

function renderPanels(state) {
  dom.stagePanels.forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === state.activeStage);
  });
}

function renderButtons(state) {
  Object.entries(dom.buttons).forEach(([key, button]) => {
    const stage = state.stages[key];
    button.disabled = stage.status === "locked" || stage.status === "running";

    if (stage.status === "running") {
      button.textContent = "计算中...";
    } else if (stage.status === "done") {
      button.textContent =
        key === "m1" ? "重新运行 M1 真实规划" :
        key === "m2" ? "重新运行 M2 压力测试" :
        key === "m3" ? "重新运行 M3 双路线评估" :
        key === "m4" ? "重新运行 M4 最终方案定型" :
        `重新运行 ${key.toUpperCase()}`;
    } else {
      button.textContent =
        key === "m1" ? "运行 M1 真实规划" :
        key === "m2" ? "运行 M2 压力测试" :
        key === "m3" ? "运行 M3 双路线评估" :
        key === "m4" ? "运行 M4 最终方案定型" :
        `运行 ${key.toUpperCase()}`;
    }
  });
}

function renderRawResults(state) {
  Object.entries(dom.results).forEach(([key, resultEl]) => {
    const stage = state.stages[key];

    if (stage.error) {
      resultEl.textContent = `${key.toUpperCase()} 出错：${stage.error}`;
      return;
    }

    if (!stage.result) {
      resultEl.textContent =
        stage.status === "locked"
          ? `${key.toUpperCase()} 尚未解锁。`
          : `尚未运行 ${key.toUpperCase()}。`;
      return;
    }

    let safeResult = stage.result;
    if (key === "m1") {
      safeResult = {
        contract: stage.result.contract,
        summary: stage.result.summary,
        hardwarePlan: stage.result.hardwarePlan,
        economics: stage.result.economics,
        energyPerformance: stage.result.energyPerformance,
        demandProfile: stage.result.demandProfile
      };
    } else if (key === "m2") {
      safeResult = {
        contract: stage.result.contract,
        summary: stage.result.summary,
        hardwareSnapshot: stage.result.hardwareSnapshot,
        riskReport: stage.result.riskReport,
        energyLedger: stage.result.energyLedger,
        occupancyReference: stage.result.occupancyReference,
        handoffToM3: stage.result.handoffToM3
      };
    } else if (key === "m3") {
      safeResult = {
        contract: stage.result.contract,
        summary: stage.result.summary,
        baselineFromM2: stage.result.baselineFromM2,
        routeOptions: stage.result.routeOptions,
        selectedRoute: state.input.m3.selectedRoute || null,
        selectedAnnualValidation: stage.result.selectedAnnualValidation || null
      };
    } else if (key === "m4") {
      safeResult = {
        contract: stage.result.contract,
        summary: stage.result.summary,
        residualDiagnosis: stage.result.residualDiagnosis,
        recommendation: stage.result.recommendation,
        scenarios: stage.result.scenarios.map((s) => ({
          id: s.id,
          title: s.title,
          extraCapexWan: s.extraCapexWan,
          stressMonth: s.stressMonth,
          annualValidation: s.annualValidation,
          evaluationIndicators: s.evaluationIndicators,
          recommendation: s.recommendation
        }))
      };
    }

    resultEl.textContent = JSON.stringify(safeResult, null, 2);
  });
}

function renderM1Summary(state) {
  const result = state.stages.m1.result;
  const el = dom.m1Summary;

  if (!result) {
    el.title.textContent = "尚未运行真实规划。";
    el.meta.textContent = "运行后，这里会显示城市、气候区与新能源目标。";
    return;
  }

  const { summary, hardwarePlan, economics, energyPerformance, demandProfile } = result;
  el.title.textContent = summary.title;
  el.meta.textContent = `${summary.city} · ${summary.climateZone} · 新能源目标 ${formatPercent(summary.renewableTarget, 0)}%`;

  el.pv.textContent = formatNumber(hardwarePlan.pvKw, 1);
  el.storage.textContent = formatNumber(hardwarePlan.storageKwh, 1);
  el.pcs.textContent = formatNumber(hardwarePlan.pcsKw, 1);
  el.capex.textContent = formatNumber(economics.capexWan, 2);
  el.piles.textContent = `${hardwarePlan.n7kw} / ${hardwarePlan.n30kw}`;
  el.renewable.textContent = formatPercent(energyPerformance.renewableShare, 1);
  el.dailyKwh.textContent = formatNumber(demandProfile.totalDailyKwh, 1);
  el.lcoe.textContent = formatNumber(economics.lcoeYuanPerKwh, 3);

  el.peak.textContent = `${formatNumber(demandProfile.peakLoadKw, 1)} kW`;
  el.avgNeed.textContent = `${formatNumber(demandProfile.averageSessionNeedKwh, 1)} kWh`;
  el.curtailment.textContent = `${formatNumber(energyPerformance.curtailmentRatePct, 1)}%`;
  el.gridAnnual.textContent = `${formatNumber(energyPerformance.gridBuyAnnualKwh, 1)} kWh`;
}

function renderM2Summary(state) {
  const result = state.stages.m2.result;
  const m1 = state.stages.m1.result;
  const el = dom.m2Summary;

  if (m1?.hardwarePlan) {
    el.inheritPv.textContent = `${formatNumber(m1.hardwarePlan.pvKw, 1)} kW`;
    el.inheritStorage.textContent = `${formatNumber(m1.hardwarePlan.storageKwh, 1)} kWh`;
    el.inheritPcs.textContent = `${formatNumber(m1.hardwarePlan.pcsKw, 1)} kW`;
    el.inheritPiles.textContent = `${m1.hardwarePlan.n7kw} / ${m1.hardwarePlan.n30kw}`;
  } else {
    el.inheritPv.textContent = "-- kW";
    el.inheritStorage.textContent = "-- kWh";
    el.inheritPcs.textContent = "-- kW";
    el.inheritPiles.textContent = "--";
  }

  if (!result) {
    el.title.textContent = "M2 尚未运行。";
    el.meta.textContent = state.input.m2.gTiltData
      ? "气象数据已就绪，可以运行真实月压力测试。"
      : "上传气象 CSV 后，运行真实月压力测试。";
    return;
  }

  const { summary, riskReport, energyLedger, handoffToM3, occupancyReference } = result;
  el.title.textContent = summary.title;
  el.meta.textContent = `${summary.monthName} · 变压器红线 ${formatNumber(summary.transformerLimitKw, 0)} kW · 利用率 ${formatNumber(summary.transformerUtilPct, 1)}%`;
  el.realPeak.textContent = formatNumber(riskReport.realPeakKw, 1);
  el.overflow.textContent = String(riskReport.overflowCount);
  el.unmet.textContent = formatNumber(riskReport.unmetTotalKwh, 1);
  el.abandoned.textContent = String(riskReport.abandonedCount);
  el.socMin.textContent = formatNumber(riskReport.socMinPct, 1);
  el.transUtil.textContent = formatNumber(summary.transformerUtilPct, 1);
  el.gridCost.textContent = formatNumber(energyLedger.gridCostYuan, 1);
  el.curtailment.textContent = formatNumber(energyLedger.curtailmentRatePct, 2);

  el.riskPeak.textContent = handoffToM3.hasPeakRisk ? "有" : "无";
  el.riskService.textContent = handoffToM3.hasServiceRisk ? "有" : "无";
  el.riskStorage.textContent = handoffToM3.hasStorageRisk ? "有" : "无";
  el.fixedP99.textContent = String(occupancyReference.fixedReadyP99);
}

function renderM3Summary(state) {
  const result = state.stages.m3.result;
  const m2 = state.stages.m2.result;
  const selectedRouteKey = state.input.m3.selectedRoute;
  const el = dom.m3Summary;

  const resetAnnualSummary = () => {
    el.annualMeta.textContent = "选择技术路线后，将自动执行全年 365 天连续调度验证。";
    el.annualUnmet.textContent = "-- kWh";
    el.annualService.textContent = "--%";
    el.annualOverflowMonths.textContent = "--";
    el.annualSocMonths.textContent = "--";

    el.annualConclusionText.textContent =
      "完成所选路线全年验证后，这里将自动提炼年度判断与进入 M4 的依据。";
    el.annualJudgement.textContent = "--";
    el.annualMainRisk.textContent = "--";
    el.annualFocusMonths.textContent = "--";
    el.annualM4Focus.textContent = "--";

    el.annualChartMeta.textContent = "完成所选路线全年验证后，这里将展示 12 个月风险分布。";
    resetAnnualChart(el.annualUnmetChart);
    resetAnnualChart(el.annualServiceChart);
    resetAnnualChart(el.annualOverflowChart);
    resetAnnualChart(el.annualSocChart);
  };

  if (m2?.riskReport) {
    el.baselineMonth.textContent = m2.summary?.monthName || "--";
    el.baselinePeak.textContent = `${formatNumber(m2.riskReport.realPeakKw, 1)} kW`;
    el.baselineUnmet.textContent = `${formatNumber(m2.riskReport.unmetTotalKwh, 1)} kWh`;
    el.baselineQueue.textContent = `${formatNumber(m2.riskReport.queueUnmetKwh, 1)} kWh`;
  } else {
    el.baselineMonth.textContent = "--";
    el.baselinePeak.textContent = "-- kW";
    el.baselineUnmet.textContent = "-- kWh";
    el.baselineQueue.textContent = "-- kWh";
  }

  dom.m3RouteButtons.forEach((button) => {
    button.disabled = !result;
  });

  if (!result) {
    el.title.textContent = "M3 尚未运行。";
    el.meta.textContent = m2 ? "M2 已完成，可以运行双路线评估。" : "M2 完成后，运行双路线评估。";
    el.tradPeak.textContent = "-- kW";
    el.tradUnmet.textContent = "-- kWh";
    el.tradQueue.textContent = "-- kWh";
    el.tradStatus.textContent = "--";
    el.flexPeak.textContent = "-- kW";
    el.flexUnmet.textContent = "-- kWh";
    el.flexNMatrix.textContent = "--";
    el.flexStatus.textContent = "--";
    el.tradSelected.textContent = "未选择";
    el.flexSelected.textContent = "未选择";
    el.selectedRoute.textContent = "尚未选择";
    el.selectedNeed.textContent = "--";
    el.selectedUnmet.textContent = "-- kWh";
    el.selectedOverflow.textContent = "-- 次";
    el.tradCard?.classList.remove("selected");
    el.flexCard?.classList.remove("selected");
    resetAnnualSummary();
    return;
  }

  const traditional = result.routeOptions.traditional_pile;
  const flexible = result.routeOptions.flex_matrix;
  const selectedRoute = selectedRouteKey ? result.routeOptions[selectedRouteKey] : null;

  el.title.textContent = result.summary.title;
  el.meta.textContent = selectedRoute
    ? `已选择：${selectedRoute.label}。系统将先完成该路线全年连续验证，再进入 M4 工程方案定型。`
    : "两条路线均已评估，请结合项目场地与实施条件选择进入 M3-B 全年验证。";

  el.tradPeak.textContent = `${formatNumber(traditional.result.realPeakKw, 1)} kW`;
  el.tradUnmet.textContent = `${formatNumber(traditional.result.unmetTotalKwh, 1)} kWh`;
  el.tradQueue.textContent = `${formatNumber(traditional.result.queueUnmetKwh, 1)} kWh`;
  el.tradStatus.textContent = traditional.handoffToM4.needsHardwareReinforcement ? "需要" : "不需要";

  el.flexPeak.textContent = `${formatNumber(flexible.result.realPeakKw, 1)} kW`;
  el.flexUnmet.textContent = `${formatNumber(flexible.result.unmetTotalKwh, 1)} kWh`;
  el.flexNMatrix.textContent = flexible.matrixSizing.dailyAccessDemand
    ? `${flexible.matrixSizing.recommended}（日均 ${formatNumber(flexible.matrixSizing.dailyAccessDemand, 1)}）`
    : String(flexible.matrixSizing.recommended);
  el.flexStatus.textContent = flexible.handoffToM4.needsHardwareReinforcement ? "需要" : "不需要";

  const tradSelected = selectedRouteKey === "traditional_pile";
  const flexSelected = selectedRouteKey === "flex_matrix";
  el.tradSelected.textContent = tradSelected ? "已选择" : "未选择";
  el.flexSelected.textContent = flexSelected ? "已选择" : "未选择";
  el.tradCard?.classList.toggle("selected", tradSelected);
  el.flexCard?.classList.toggle("selected", flexSelected);

  if (!selectedRoute) {
    el.selectedRoute.textContent = "尚未选择";
    el.selectedNeed.textContent = "--";
    el.selectedUnmet.textContent = "-- kWh";
    el.selectedOverflow.textContent = "-- 次";
    resetAnnualSummary();
    return;
  }

  const handoff = selectedRoute.handoffToM4;
  el.selectedRoute.textContent = selectedRoute.label;
  el.selectedNeed.textContent = handoff.needsHardwareReinforcement ? "是" : "否";
  el.selectedUnmet.textContent = `${formatNumber(handoff.residualUnmetKwh, 1)} kWh`;
  el.selectedOverflow.textContent = `${handoff.residualOverflowCount} 次`;

  // M3-B 所选路线全年连续验证摘要
  const annualStatus = state.stages.m3.annualValidationStatus;
  const annualError = state.stages.m3.annualValidationError;
  const annualResult = result.selectedAnnualValidation;
  const annual = annualResult?.annualValidation;

  if (annualStatus === "running") {
    el.annualMeta.textContent = `${selectedRoute.label} 已选择，正在执行全年 365 天连续调度验证……`;
    el.annualUnmet.textContent = "-- kWh";
    el.annualService.textContent = "--%";
    el.annualOverflowMonths.textContent = "--";
    el.annualSocMonths.textContent = "--";

    el.annualConclusionText.textContent = "全年连续验证正在执行，结论将在年度结果返回后生成。";
    el.annualJudgement.textContent = "验证中";
    el.annualMainRisk.textContent = "--";
    el.annualFocusMonths.textContent = "--";
    el.annualM4Focus.textContent = "--";

    el.annualChartMeta.textContent = "正在执行全年验证，月度风险画像将在结果返回后生成。";
    resetAnnualChart(el.annualUnmetChart, "验证中");
    resetAnnualChart(el.annualServiceChart, "验证中");
    resetAnnualChart(el.annualOverflowChart, "验证中");
    resetAnnualChart(el.annualSocChart, "验证中");
    return;
  }

  if (annualStatus === "error") {
    el.annualMeta.textContent = `全年验证失败：${annualError || "未知错误"}`;
    el.annualUnmet.textContent = "-- kWh";
    el.annualService.textContent = "--%";
    el.annualOverflowMonths.textContent = "--";
    el.annualSocMonths.textContent = "--";

    el.annualConclusionText.textContent = "全年连续验证失败，暂无法形成年度结论。";
    el.annualJudgement.textContent = "验证失败";
    el.annualMainRisk.textContent = "--";
    el.annualFocusMonths.textContent = "--";
    el.annualM4Focus.textContent = "--";

    el.annualChartMeta.textContent = "全年验证失败，暂无法生成月度风险画像。";
    resetAnnualChart(el.annualUnmetChart, "验证失败");
    resetAnnualChart(el.annualServiceChart, "验证失败");
    resetAnnualChart(el.annualOverflowChart, "验证失败");
    resetAnnualChart(el.annualSocChart, "验证失败");
    return;
  }

  if (!annual) {
    el.annualMeta.textContent = `${selectedRoute.label} 已选择，等待执行全年连续验证。`;
    el.annualUnmet.textContent = "-- kWh";
    el.annualService.textContent = "--%";
    el.annualOverflowMonths.textContent = "--";
    el.annualSocMonths.textContent = "--";

    el.annualConclusionText.textContent = "已完成路线选择，等待年度验证结果后形成结论。";
    el.annualJudgement.textContent = "等待验证";
    el.annualMainRisk.textContent = "--";
    el.annualFocusMonths.textContent = "--";
    el.annualM4Focus.textContent = "--";

    el.annualChartMeta.textContent = "全年验证结果返回后，这里将展示 12 个月风险分布。";
    resetAnnualChart(el.annualUnmetChart);
    resetAnnualChart(el.annualServiceChart);
    resetAnnualChart(el.annualOverflowChart);
    resetAnnualChart(el.annualSocChart);
    return;
  }

  el.annualMeta.textContent = `${annualResult.selectedRouteLabel || selectedRoute.label} 全年连续验证已完成，M4 已可继续沿该路线进行工程方案定型。`;
  el.annualUnmet.textContent = `${formatNumber(annual.totalUnmetKwh || 0, 1)} kWh`;
  el.annualService.textContent = `${formatPercent(annual.serviceRate || 0, 1)}%`;
  el.annualOverflowMonths.textContent = String(annual.monthsWithOverflow || 0);
  el.annualSocMonths.textContent = String(annual.monthsWithSocRisk || 0);

  // 绘制月度风险画像
  const monthly = annualResult.rawAnnual?.monthly || [];

  if (!monthly.length) {
    el.annualChartMeta.textContent = "全年验证已完成，但未返回月度明细，暂无法绘制月度图表。";
    resetAnnualChart(el.annualUnmetChart);
    resetAnnualChart(el.annualServiceChart);
    resetAnnualChart(el.annualOverflowChart);
    resetAnnualChart(el.annualSocChart);
    return;
  }

  el.annualChartMeta.textContent =
    `${annualResult.selectedRouteLabel || selectedRoute.label} 的全年结果已拆分为 12 个月画像，可用于定位残余风险集中月份。`;

  const monthlyUnmet = monthly.map((m) => Number(m.unmetTotal || 0));
  const monthlyService = monthly.map((m) => {
    const delivered = Number(m.deliveredEnergy || 0);
    const unmet = Number(m.unmetTotal || 0);
    const demand = delivered + unmet;
    return demand > 0 ? delivered / demand : 0;
  });
  const monthlyOverflow = monthly.map((m) => Number(m.overflowCount || 0));
  const monthlySoc = monthly.map((m) => Number(m.socMin ?? 100));

  // 生成年度结论
  const topRiskMonths = getTopRiskMonths(monthlyUnmet, monthlyService, monthlyOverflow, monthlySoc);
  const topRiskMonthText = topRiskMonths.length
    ? topRiskMonths.map((item) => item.label).join(" / ")
    : "无明显集中月份";

  const annualJudgement = getAnnualJudgement(annual);
  const annualMainRisk = getAnnualMainRisk(annual);
  const annualM4Focus = getM4FocusText(annual);

  el.annualJudgement.textContent = annualJudgement;
  el.annualMainRisk.textContent = annualMainRisk;
  el.annualFocusMonths.textContent = topRiskMonthText;
  el.annualM4Focus.textContent = annualM4Focus;

  el.annualConclusionText.textContent =
    annualJudgement === "全年表现基本稳健"
      ? `${annualResult.selectedRouteLabel || selectedRoute.label} 在全年连续验证中未暴露显著结构性风险，可进入 M4 进行最终方案对照与工程定型。`
      : `${annualResult.selectedRouteLabel || selectedRoute.label} 在全年连续验证中仍暴露 ${annualMainRisk}，风险主要集中于 ${topRiskMonthText}，因此需要继续进入 M4 做工程加固定型。`;

  // 绘制月度风险画像
  renderAnnualBarChart(el.annualUnmetChart, monthlyUnmet, {
    maxValue: Math.max(...monthlyUnmet, 1),
    formatter: (v) => `${formatNumber(v, 0)}`,
    dangerJudge: (v) => v > 0
  });

  renderAnnualBarChart(el.annualServiceChart, monthlyService, {
    maxValue: 1,
    formatter: (v) => `${formatPercent(v, 0)}%`,
    dangerJudge: (v) => v < 0.95
  });

  renderAnnualBarChart(el.annualOverflowChart, monthlyOverflow, {
    maxValue: Math.max(...monthlyOverflow, 1),
    formatter: (v) => `${Math.round(v)}`,
    dangerJudge: (v) => v > 0
  });

  renderAnnualBarChart(el.annualSocChart, monthlySoc, {
    maxValue: 100,
    formatter: (v) => `${formatNumber(v, 0)}%`,
    dangerJudge: (v) => v < 8
  });
}


function riskLabel(risk) {
  if (!risk || !risk.active || !risk.level) return "无";
  const map = { low: "低", medium: "中", high: "高" };
  return map[risk.level] || risk.level;
}

function riskDiagnosisText(diagnosis) {
  const parts = [];
  const power = diagnosis.powerRisk || {};
  const energy = diagnosis.energyRisk || {};
  const service = diagnosis.serviceRisk || {};
  const delivery = diagnosis.deliveryServiceRisk || {};
  const storage = diagnosis.storageRisk || {};

  if (power.active) parts.push(`功率:${riskLabel(power)}`);
  if (energy.active) parts.push(`能量:${riskLabel(energy)}`);
  if (service.active) parts.push(`接入:${riskLabel(service)}`);
  if (delivery.active) parts.push(`供电:${riskLabel(delivery)}`);
  if (storage.active) parts.push(`储能:${riskLabel(storage)}`);

  if (!parts.length) return "无显著残余风险";
  return parts.join(" ");
}

function renderM4HandoffBridge(el, selectedRoute, selectedAnnualResult, selectedAnnual, selectedMonthly) {
  if (!selectedRoute) {
    el.handoffSummary.textContent =
      "尚未选择 M3 技术路线。完成 M3-A 并选择路线后，M4 才会获得明确承接对象。";
    el.handoffRoute.textContent = "--";
    el.handoffJudgement.textContent = "--";
    el.handoffMainRisk.textContent = "--";
    el.handoffFocusMonths.textContent = "--";
    el.handoffTask.textContent = "等待技术路线选择。";
    return;
  }

  el.handoffRoute.textContent = selectedRoute.label;

  if (!selectedAnnual) {
    el.handoffSummary.textContent =
      `${selectedRoute.label} 已选定，但 M3-B 全年连续验证尚未完成。`;
    el.handoffJudgement.textContent = "等待全年验证";
    el.handoffMainRisk.textContent = "--";
    el.handoffFocusMonths.textContent = "--";
    el.handoffTask.textContent = "待 M3-B 返回全年风险结论后，再进入最终工程定型。";
    return;
  }

  const annualJudgement = getAnnualJudgement(selectedAnnual);
  const annualMainRisk = getAnnualMainRisk(selectedAnnual);
  const annualM4Focus = getM4FocusText(selectedAnnual);

  let focusMonthsText = "无明显集中月份";

  if (selectedMonthly.length) {
    const monthlyUnmet = selectedMonthly.map((m) => Number(m.unmetTotal || 0));
    const monthlyService = selectedMonthly.map((m) => {
      const delivered = Number(m.deliveredEnergy || 0);
      const unmet = Number(m.unmetTotal || 0);
      const demand = delivered + unmet;
      return demand > 0 ? delivered / demand : 0;
    });
    const monthlyOverflow = selectedMonthly.map((m) => Number(m.overflowCount || 0));
    const monthlySoc = selectedMonthly.map((m) => Number(m.socMin ?? 100));

    const topRiskMonths = getTopRiskMonths(monthlyUnmet, monthlyService, monthlyOverflow, monthlySoc);
    focusMonthsText = topRiskMonths.length
      ? topRiskMonths.map((item) => item.label).join(" / ")
      : "无明显集中月份";
  }

  el.handoffJudgement.textContent = annualJudgement;
  el.handoffMainRisk.textContent = annualMainRisk;
  el.handoffFocusMonths.textContent = focusMonthsText;

  el.handoffSummary.textContent =
    annualJudgement === "全年表现基本稳健"
      ? `${selectedAnnualResult?.selectedRouteLabel || selectedRoute.label} 已完成全年验证，当前未暴露显著结构性年度风险。M4 将进一步完成方案对照与最终工程定型。`
      : `${selectedAnnualResult?.selectedRouteLabel || selectedRoute.label} 的全年验证表明仍存在 ${annualMainRisk}，风险主要集中于 ${focusMonthsText}。M4 将据此生成并比较最终工程方案。`;

  el.handoffTask.textContent = annualM4Focus;
}

function getM4ScenarioOptionLabel(scenario, recommendation) {
  const isRecommended =
    scenario.id === recommendation?.recommendedScenarioId;

  const recommendationMark = isRecommended ? " ★ 综合推荐" : "";
  const title = scenario.variantLabel || scenario.title || "候选方案";

  return `${scenario.id}｜${title}${recommendationMark}`;
}

function renderM4ScenarioDeltaCards(el, scenario, routeKey) {
  if (!scenario) {
    el.deltaPv.textContent = "-- kW";
    el.deltaStorage.textContent = "-- kWh";
    el.deltaPcs.textContent = "-- kW";
    el.deltaTransformer.textContent = "-- kW";
    el.deltaService.textContent = "--";
    return;
  }

  const d = scenario.deltas || {};

  el.deltaPv.textContent =
    `${formatNumber(d.deltaPvKw || 0, 1)} kW`;

  el.deltaStorage.textContent =
    `${formatNumber(d.deltaStorageKwh || 0, 1)} kWh`;

  el.deltaPcs.textContent =
    `${formatNumber(d.deltaPcsKw || 0, 1)} kW`;

  el.deltaTransformer.textContent =
    `${formatNumber(d.deltaTransformerKw || 0, 1)} kW`;

  el.deltaService.textContent =
    routeKey === "traditional_pile"
      ? `7kW +${d.deltaN7 || 0} / 30kW +${d.deltaN30 || 0}`
      : (() => {
          const deltaMatrix = d.deltaMatrix || 0;
          const deltaPMatrixKw = d.deltaPMatrixKw || 0;

          const parts = [];

          if (deltaMatrix > 0) {
            parts.push(`N_matrix +${deltaMatrix}`);
          }

          if (deltaPMatrixKw > 0) {
            parts.push(`P_matrix +${deltaPMatrixKw} kW`);
          }

          return parts.length > 0
            ? parts.join(" / ")
            : "N_matrix +0 / P_matrix +0 kW";
        })();
}

function renderM4Summary(state) {
  const result = state.stages.m4.result;
  const m3 = state.stages.m3.result;
  const selectedRouteKey = state.input.m3.selectedRoute;
  const el = dom.m4Summary;

  const selectedRoute = selectedRouteKey ? m3?.routeOptions?.[selectedRouteKey] : null;
  const selectedAnnualResult = m3?.selectedAnnualValidation || null;
  const selectedAnnual = selectedAnnualResult?.annualValidation || null;
  const selectedMonthly = selectedAnnualResult?.rawAnnual?.monthly || [];

  renderM4HandoffBridge(el, selectedRoute, selectedAnnualResult, selectedAnnual, selectedMonthly);

  if (selectedRoute) {
    el.selectedRoute.textContent = selectedRoute.label;
    el.residualUnmet.textContent = `${formatNumber(selectedRoute.handoffToM4?.residualUnmetKwh || 0, 1)} kWh`;
    el.residualQueue.textContent = `${formatNumber(selectedRoute.handoffToM4?.residualQueueUnmetKwh || 0, 1)} kWh`;
  } else {
    el.selectedRoute.textContent = "--";
    el.residualUnmet.textContent = "-- kWh";
    el.residualQueue.textContent = "-- kWh";
  }

  if (!result) {
    el.title.textContent = "M4 尚未运行。";
    el.meta.textContent = selectedAnnual
      ? "已承接 M3-B 全年验证结论，可以运行最终工程方案定型。"
      : selectedRoute
        ? "已选择技术路线，待 M3-B 全年验证完成后进入最终工程方案定型。"
        : "在 M3 选择路线并完成 M3-B 年度验证后运行最终工程方案定型。";
    el.residualSeverity.textContent = "--";
    el.recommendMain.textContent = "--";
    el.recommendLow.textContent = "--";
    el.recommendSafe.textContent = "--";
    el.recommendScore.textContent = "--";
    el.recommendExplain.textContent = "运行后，这里会解释为什么推荐该方案。";
    el.scenarioTableBody.innerHTML =
      '<tr><td colspan="8">M4 尚未运行。</td></tr>';

    if (el.scenarioSelect) {
      el.scenarioSelect.innerHTML =
        '<option value="">M4 尚未运行</option>';
      el.scenarioSelect.disabled = true;
      el.scenarioSelect.onchange = null;
    }

    renderM4ScenarioDeltaCards(el, null, selectedRouteKey);

    return;
  }

  const summary = result.summary || {};
  const diagnosis = result.residualDiagnosis || {};
  const recommendation = result.recommendation || {};
  const scenarios = result.scenarios || [];
  const recommended = scenarios.find((s) => s.id === recommendation.recommendedScenarioId) || scenarios[0];

  el.title.textContent = summary.title || "最终工程方案定型已完成";
  el.meta.textContent = `${summary.selectedRouteLabel || "--"} · 共评估 ${summary.scenarioCount || scenarios.length} 套方案` +
    (recommendation.feasibleCount != null ? ` · 硬可行 ${recommendation.feasibleCount} 套` : "");
  el.residualSeverity.textContent = `${diagnosis.severity || "--"} / ${formatNumber(diagnosis.severityScore || 0, 1)} · ${riskDiagnosisText(diagnosis)}`;
  el.recommendMain.textContent = recommendation.isFallbackRecommendation
    ? `${recommendation.recommendedScenarioId || "--"} (相对最优)`
    : recommendation.recommendedScenarioId || "--";
  el.recommendLow.textContent = recommendation.lowInvestmentScenarioId || "--";
  el.recommendSafe.textContent = recommendation.highProtectionScenarioId || "--";
  el.recommendScore.textContent = recommended?.recommendation?.totalScore != null
    ? `${formatNumber(recommended.recommendation.totalScore, 1)} 分`
    : "--";
  el.recommendExplain.textContent = recommendation.explanation || "暂无推荐解释。";

  el.scenarioTableBody.innerHTML = scenarios.map((scenario) => {
    const score = scenario.recommendation?.totalScore != null
      ? formatNumber(scenario.recommendation.totalScore, 1)
      : "--";
    const mark = scenario.id === recommendation.recommendedScenarioId ? " ★" : "";
    return `
      <tr class="${scenario.id === recommendation.recommendedScenarioId ? "recommended-row" : ""}">
        <td><strong>${scenario.id}${mark}</strong><small>${scenario.title.replace(/^S\d\s*/, "")}</small></td>
        <td>${formatNumber(scenario.extraCapexWan || 0, 2)} 万</td>
        <td>${formatNumber(scenario.annualValidation?.totalUnmetKwh || 0, 1)} kWh</td>
        <td>${scenario.annualValidation?.totalOverflowCount || 0}</td>
        <td>${formatNumber((scenario.evaluationIndicators?.pvur || 0) * 100, 1)}%</td>
        <td>${formatNumber(scenario.evaluationIndicators?.gff || 0, 3)}</td>
        <td>${formatNumber(scenario.evaluationIndicators?.annualLcoeYuanPerKwh || 0, 3)}</td>
        <td>${score}</td>
      </tr>
    `;
  }).join("");

  const defaultScenarioId =
    recommendation.recommendedScenarioId ||
    recommended?.id ||
    scenarios[0]?.id ||
    "";

  const previousSelectedScenarioId =
    el.scenarioSelect?.value || "";

  const selectedScenarioId =
    scenarios.some((scenario) => scenario.id === previousSelectedScenarioId)
      ? previousSelectedScenarioId
      : defaultScenarioId;

  if (el.scenarioSelect) {
    el.scenarioSelect.innerHTML = scenarios.map((scenario) => {
      const selected =
        scenario.id === selectedScenarioId ? " selected" : "";

      return `
        <option value="${scenario.id}"${selected}>
          ${getM4ScenarioOptionLabel(scenario, recommendation)}
        </option>
      `;
    }).join("");

    el.scenarioSelect.disabled = scenarios.length === 0;

    el.scenarioSelect.onchange = () => {
      const scenario =
        scenarios.find((item) => item.id === el.scenarioSelect.value) ||
        recommended ||
        scenarios[0] ||
        null;

      renderM4ScenarioDeltaCards(
        el,
        scenario,
        summary.selectedRouteKey
      );
    };
  }

  const selectedScenario =
    scenarios.find((scenario) => scenario.id === selectedScenarioId) ||
    recommended ||
    scenarios[0] ||
    null;

  renderM4ScenarioDeltaCards(
    el,
    selectedScenario,
    summary.selectedRouteKey
  );
}

export function renderApp(state) {
  const activeMeta = STAGES[state.activeStage];
  dom.stageTitle.textContent = activeMeta.title;
  dom.globalStatus.textContent = `${activeMeta.title} · ${getStageStatusLabel(state.stages[state.activeStage].status)}`;
  dom.summaryState.textContent = "状态中心已接管";
  dom.summaryWorker.textContent = state.workerStatus === "busy" ? "计算中" : state.workerStatus === "error" ? "异常" : "等待任务";
  dom.summaryUnlock.textContent = getUnlockedSummary(state);

  renderTabs(state);
  renderPanels(state);
  renderButtons(state);
  renderRawResults(state);
  renderM1Summary(state);
  renderM2Summary(state);
  renderM3Summary(state);
  renderM4Summary(state);
}
