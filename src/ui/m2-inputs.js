import { dom } from "./dom.js";

function parseCsvLine(line) {
  const cols = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === '"' && inQuotes && next === '"') {
      current += '"';
      i++;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      cols.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cols.push(current.trim());
  return cols;
}

function parseInputValue(input) {
  if (input.tagName === "SELECT") {
    if (input.dataset.m2Input === "monthIndex") return Number(input.value);
    return input.value;
  }
  const parsed = Number(input.value);
  return Number.isFinite(parsed) ? parsed : input.value;
}

export function hydrateM2Inputs(state) {
  dom.m2Inputs.forEach((input) => {
    const key = input.dataset.m2Input;
    const value = state.input.m2[key];
    if (value !== undefined && value !== null) input.value = value;
  });
  dom.m2CsvStatus.textContent = state.input.m2.gTiltStatus || "尚未加载 TMY CSV。";
}

export function bindM2Inputs(state, onChange) {
  dom.m2Inputs.forEach((input) => {
    const sync = () => {
      const key = input.dataset.m2Input;
      state.input.m2[key] = parseInputValue(input);
      onChange(state);
    };
    input.addEventListener("input", sync);
    input.addEventListener("change", sync);
  });

  dom.m2CsvFile?.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    state.input.m2.gTiltStatus = "正在解析气象数据...";
    dom.m2CsvStatus.textContent = state.input.m2.gTiltStatus;
    onChange(state);

    const reader = new FileReader();
    reader.onload = (loadEvent) => {
      const text = String(loadEvent.target?.result || "");
      const lines = text.split(/\r?\n/);
      const data = [];
      let headerFound = false;
      let gTiltIndex = -1;

      for (const line of lines) {
        if (!line.trim()) continue;
        const cols = parseCsvLine(line);
        if (!headerFound) {
          gTiltIndex = cols.findIndex((col) =>
            col.replace(/^﻿/, "").trim().toLowerCase().includes("g_tilt")
          );
          if (gTiltIndex !== -1) headerFound = true;
          continue;
        }

        if (cols.length > gTiltIndex) {
          const value = Number.parseFloat(cols[gTiltIndex]);
          data.push(Number.isFinite(value) ? value : 0);
        }
      }

      if (data.length >= 8760) {
        state.input.m2.gTiltData = data.slice(0, 8760);
        state.input.m2.gTiltStatus = `✅ 已接管 TMY 数据（${data.length} 行，使用前 8760 行）`;
      } else {
        state.input.m2.gTiltData = null;
        state.input.m2.gTiltStatus = "❌ 数据不足 8760 行，无法进行真实月压力测试。";
      }
      dom.m2CsvStatus.textContent = state.input.m2.gTiltStatus;
      onChange(state);
    };
    reader.readAsText(file);
  });
}
