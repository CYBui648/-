import { dom } from "./dom.js";

function parseInputValue(input) {
  if (input.tagName === "SELECT") return input.value;
  const parsed = Number(input.value);
  return Number.isFinite(parsed) ? parsed : input.value;
}

export function hydrateM1Inputs(state) {
  dom.m1Inputs.forEach((input) => {
    const key = input.dataset.m1Input;
    const value = state.input.m1[key];
    if (value !== undefined && value !== null) {
      input.value = value;
    }
  });
}

export function bindM1Inputs(state, onChange) {
  dom.m1Inputs.forEach((input) => {
    input.addEventListener("input", () => {
      const key = input.dataset.m1Input;
      state.input.m1[key] = parseInputValue(input);
      onChange(state);
    });
    input.addEventListener("change", () => {
      const key = input.dataset.m1Input;
      state.input.m1[key] = parseInputValue(input);
      onChange(state);
    });
  });
}
