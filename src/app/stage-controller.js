import { STAGES, STAGE_ORDER } from "../config/system-config.js";

const M3_ROUTE_KEYS = new Set(["traditional_pile", "flex_matrix"]);

export class StageController {
  constructor({ state, workerClient, render }) {
    this.state = state;
    this.workerClient = workerClient;
    this.render = render;
  }

  getState() {
    return this.state;
  }

  switchStage(stageKey) {
    const stage = this.state.stages[stageKey];
    if (!stage || stage.status === "locked") return;
    this.state.activeStage = stageKey;
    this.render(this.state);
  }

  async runStage(stageKey) {
    const stage = this.state.stages[stageKey];
    const config = STAGES[stageKey];

    if (!stage || !config || stage.status === "locked") return;

    this.invalidateDownstream(stageKey);

    stage.status = "running";
    stage.error = null;
    this.render(this.state);

    try {
      const context = this.buildStageContext(stageKey);
      const result = await this.workerClient.run(config.jobType, context);
      stage.status = "done";
      stage.result = result;
      this.unlockNextStage(stageKey);
      this.render(this.state);
    } catch (error) {
      stage.status = "error";
      stage.error = error.message || "未知错误";
      this.render(this.state);
    }
  }

  async selectM3Route(routeKey) {
    const m3Stage = this.state.stages.m3;
    if (m3Stage.status !== "done" || !m3Stage.result) return;
    if (!M3_ROUTE_KEYS.has(routeKey)) return;
    if (m3Stage.annualValidationStatus === "running") return;

    this.state.input.m3.selectedRoute = routeKey;

    // M4 必须等 M3-B 所选路线全年验证完成后才解锁
    const m4Stage = this.state.stages.m4;
    m4Stage.status = "locked";
    m4Stage.result = null;
    m4Stage.error = null;

    // 清掉旧的 M3-B 验证结果
    m3Stage.result.selectedAnnualValidation = null;
    m3Stage.annualValidationStatus = "running";
    m3Stage.annualValidationError = null;

    this.render(this.state);

    try {
      const context = this.buildStageContext("m3");

      const annualResult = await this.workerClient.run(
        "M3_VALIDATE_SELECTED_ROUTE",
        context
      );

      m3Stage.result.selectedAnnualValidation = annualResult;
      m3Stage.annualValidationStatus = "done";
      m3Stage.annualValidationError = null;

      // M3-B 成功 → M4 解锁
      m4Stage.status = "ready";
      m4Stage.result = null;
      m4Stage.error = null;

      this.render(this.state);
    } catch (error) {
      m3Stage.annualValidationStatus = "error";
      m3Stage.annualValidationError = error.message || "M3-B 所选路线全年验证失败";

      // 验证失败不解锁 M4
      m4Stage.status = "locked";
      m4Stage.result = null;
      m4Stage.error = null;

      this.render(this.state);
    }
  }

  buildStageContext(stageKey) {
    return {
      stageKey,
      input: this.state.input,
      previousResults: {
        m1: this.state.stages.m1.result,
        m2: this.state.stages.m2.result,
        m3: this.state.stages.m3.result
      }
    };
  }

  unlockNextStage(stageKey) {
    // M3 是技术路线选择节点。
    // M4 必须等用户明确选择“传统桩站”或“柔性调度”后再解锁。
    if (stageKey === "m3") return;

    const currentIndex = STAGE_ORDER.indexOf(stageKey);
    const nextKey = STAGE_ORDER[currentIndex + 1];
    if (!nextKey) return;

    const nextStage = this.state.stages[nextKey];
    if (nextStage.status === "locked") {
      nextStage.status = "ready";
    }
  }

  invalidateDownstream(stageKey) {
    const currentIndex = STAGE_ORDER.indexOf(stageKey);
    if (currentIndex < 0) return;

    for (let i = currentIndex + 1; i < STAGE_ORDER.length; i++) {
      const key = STAGE_ORDER[i];
      const stage = this.state.stages[key];
      stage.status = "locked";
      stage.result = null;
      stage.error = null;
    }

    // 只要重跑 M1 / M2 / M3，进入 M4 的技术路线选择就需要重新确认。
    if (currentIndex <= STAGE_ORDER.indexOf("m3")) {
      this.state.input.m3.selectedRoute = null;

      const m3Stage = this.state.stages.m3;
      if (m3Stage) {
        m3Stage.annualValidationStatus = null;
        m3Stage.annualValidationError = null;

        if (m3Stage.result) {
          m3Stage.result.selectedAnnualValidation = null;
        }
      }
    }
  }
}
