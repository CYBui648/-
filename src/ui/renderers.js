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
      button.textContent = key === "m1" ? "重新运行 M1 真实规划" : `重新运行 ${key.toUpperCase()}`;
    } else {
      button.textContent = key === "m1" ? "运行 M1 真实规划" : `运行 ${key.toUpperCase()} 占位任务`;
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
        selectedRoute: state.input.m3.selectedRoute || null
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
    return;
  }

  const traditional = result.routeOptions.traditional_pile;
  const flexible = result.routeOptions.flex_matrix;
  const selectedRoute = selectedRouteKey ? result.routeOptions[selectedRouteKey] : null;

  el.title.textContent = result.summary.title;
  el.meta.textContent = selectedRoute
    ? `已选择：${selectedRoute.label}。M4 将沿该路线继续生成加固方案。`
    : "两条路线均已评估，请结合项目场地与实施条件选择进入 M4 的路线。";

  el.tradPeak.textContent = `${formatNumber(traditional.result.realPeakKw, 1)} kW`;
  el.tradUnmet.textContent = `${formatNumber(traditional.result.unmetTotalKwh, 1)} kWh`;
  el.tradQueue.textContent = `${formatNumber(traditional.result.queueUnmetKwh, 1)} kWh`;
  el.tradStatus.textContent = traditional.handoffToM4.needsHardwareReinforcement ? "需要" : "不需要";

  el.flexPeak.textContent = `${formatNumber(flexible.result.realPeakKw, 1)} kW`;
  el.flexUnmet.textContent = `${formatNumber(flexible.result.unmetTotalKwh, 1)} kWh`;
  el.flexNMatrix.textContent = String(flexible.matrixSizing.recommended);
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
    return;
  }

  const handoff = selectedRoute.handoffToM4;
  el.selectedRoute.textContent = selectedRoute.label;
  el.selectedNeed.textContent = handoff.needsHardwareReinforcement ? "是" : "否";
  el.selectedUnmet.textContent = `${formatNumber(handoff.residualUnmetKwh, 1)} kWh`;
  el.selectedOverflow.textContent = `${handoff.residualOverflowCount} 次`;
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

function renderM4Summary(state) {
  const result = state.stages.m4.result;
  const m3 = state.stages.m3.result;
  const selectedRouteKey = state.input.m3.selectedRoute;
  const el = dom.m4Summary;

  const selectedRoute = selectedRouteKey ? m3?.routeOptions?.[selectedRouteKey] : null;
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
    el.meta.textContent = selectedRoute
      ? "已选择技术路线，可以运行最终方案定型。"
      : "在 M3 选择路线后运行最终工程方案定型。";
    el.residualSeverity.textContent = "--";
    el.recommendMain.textContent = "--";
    el.recommendLow.textContent = "--";
    el.recommendSafe.textContent = "--";
    el.recommendScore.textContent = "--";
    el.recommendExplain.textContent = "运行后，这里会解释为什么推荐该方案。";
    el.scenarioTableBody.innerHTML = '<tr><td colspan="8">M4 尚未运行。</td></tr>';
    el.deltaPv.textContent = "-- kW";
    el.deltaStorage.textContent = "-- kWh";
    el.deltaPcs.textContent = "-- kW";
    el.deltaService.textContent = "--";
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
        <td><strong>${scenario.id}${mark}</strong><small>${scenario.title.replace(/^S\\d\\s*/, "")}</small></td>
        <td>${formatNumber(scenario.extraCapexWan || 0, 2)} 万</td>
        <td>${formatNumber(scenario.annualValidation?.totalUnmetKwh || 0, 1)} kWh</td>
        <td>${scenario.annualValidation?.totalOverflowCount || 0}</td>
        <td>${formatNumber((scenario.evaluationIndicators?.pvurProxy || 0) * 100, 1)}%</td>
        <td>${formatNumber(scenario.evaluationIndicators?.gffProxy || 0, 3)}</td>
        <td>${formatNumber(scenario.evaluationIndicators?.annualLcoeYuanPerKwh || 0, 3)}</td>
        <td>${score}</td>
      </tr>
    `;
  }).join("");

  if (recommended) {
    const d = recommended.deltas || {};
    el.deltaPv.textContent = `${formatNumber(d.deltaPvKw || 0, 1)} kW`;
    el.deltaStorage.textContent = `${formatNumber(d.deltaStorageKwh || 0, 1)} kWh`;
    el.deltaPcs.textContent = `${formatNumber(d.deltaPcsKw || 0, 1)} kW`;
    el.deltaService.textContent = summary.selectedRouteKey === "traditional_pile"
      ? `7kW +${d.deltaN7 || 0} / 30kW +${d.deltaN30 || 0}`
      : `N_matrix +${d.deltaMatrix || 0}`;
  }
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
