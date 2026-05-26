export const SCENARIO_KEYS = [
  "offgrid_rule",
  "offgrid_dispatch",
  "grid_rule",
  "grid_dispatch"
];

export const SCENARIO_DEFINITIONS = {
  offgrid_rule: {
    key: "offgrid_rule",
    label: "离网-规则运行",
    gridConnected: false,
    dispatchEnabled: false,
    description: "EV 需求按自然到站规则运行，仅由光伏与储能供能，不允许电网补电。"
  },
  offgrid_dispatch: {
    key: "offgrid_dispatch",
    label: "离网-优化调度",
    gridConnected: false,
    dispatchEnabled: true,
    description: "EV 需求允许调度转移，仅由光伏与储能供能，不允许电网补电。"
  },
  grid_rule: {
    key: "grid_rule",
    label: "并网-规则运行",
    gridConnected: true,
    dispatchEnabled: false,
    description: "EV 需求按自然到站规则运行，光伏与储能不足时允许电网补电。"
  },
  grid_dispatch: {
    key: "grid_dispatch",
    label: "并网-优化调度",
    gridConnected: true,
    dispatchEnabled: true,
    description: "EV 需求允许调度转移，光伏与储能不足时允许电网补电。"
  }
};

export function getScenarioDefinition(key) {
  return SCENARIO_DEFINITIONS[key] || null;
}

export function listScenarioDefinitions() {
  return SCENARIO_KEYS.map((key) => SCENARIO_DEFINITIONS[key]);
}
