import { STAGES, STAGE_ORDER } from "../config/system-config.js";

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

  }
}
