import { dom } from "./dom.js";

function parseInputValue(input) {
  if (input.type === "checkbox") return Boolean(input.checked);
  const parsed = Number(input.value);
  return Number.isFinite(parsed) ? parsed : input.value;
}

export function hydrateM3Inputs(state) {
  dom.m3Inputs.forEach((input) => {
    const key = input.dataset.m3Input;
    const value = state.input.m3[key];
    if (input.type === "checkbox") input.checked = Boolean(value);
    else if (value !== undefined && value !== null) input.value = value;
  });
}

export function bindM3Inputs(state, onChange) {
  dom.m3Inputs.forEach((input) => {
    const sync = () => {
      const key = input.dataset.m3Input;
      state.input.m3[key] = parseInputValue(input);
      onChange(state);
    };
    input.addEventListener("input", sync);
    input.addEventListener("change", sync);
  });
}
