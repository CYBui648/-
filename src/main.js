import { createInitialState } from "./app/app-state.js";
import { WorkerClient } from "./app/worker-client.js";
import { StageController } from "./app/stage-controller.js";
import { dom } from "./ui/dom.js";
import { renderApp } from "./ui/renderers.js";
import { bindM1Inputs, hydrateM1Inputs } from "./ui/m1-inputs.js";
import { bindM2Inputs, hydrateM2Inputs } from "./ui/m2-inputs.js";
import { bindM3Inputs, hydrateM3Inputs } from "./ui/m3-inputs.js";
import { bindM3RouteSelection } from "./ui/m3-route-selection.js";

const state = createInitialState();

const workerClient = new WorkerClient(
  new URL("./worker/solver.worker.js", import.meta.url),
  (status) => {
    state.workerStatus = status;
    renderApp(state);
  }
);

const controller = new StageController({
  state,
  workerClient,
  render: renderApp
});

dom.stageTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    controller.switchStage(tab.dataset.stage);
  });
});

Object.entries(dom.buttons).forEach(([key, button]) => {
  button.addEventListener("click", () => {
    controller.runStage(key);
  });
});

hydrateM1Inputs(state);
hydrateM2Inputs(state);
hydrateM3Inputs(state);
bindM1Inputs(state, renderApp);
bindM2Inputs(state, renderApp);
bindM3Inputs(state, renderApp);
bindM3RouteSelection(controller);
renderApp(state);

window.mgsV2 = {
  state,
  controller
};
