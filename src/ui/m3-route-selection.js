import { dom } from "./dom.js";

export function bindM3RouteSelection(controller) {
  dom.m3RouteButtons.forEach((button) => {
    button.addEventListener("click", () => {
      controller.selectM3Route(button.dataset.m3Route);
    });
  });
}
