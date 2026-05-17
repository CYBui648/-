# Worker 模块说明

这一层放的是浏览器 Web Worker 中运行的计算逻辑。页面负责收集输入和展示结果，真正耗时的 M1~M4 计算都通过 `solver.worker.js` 分发到这里执行，避免阻塞界面。

## 入口关系

`solver.worker.js` 是 Worker 总入口，会根据任务类型调用对应模块：

- `M1_PLAN` -> `m1-engine.js`
- `M2_STRESS_TEST` -> `m2-engine.js`
- `M3_DISPATCH_DIAGNOSIS` -> `m3-engine.js`
- `M3_VALIDATE_SELECTED_ROUTE` -> `m3-engine.js`
- `M4_FINALIZE_PLAN` -> `m4-engine.js`

页面侧只需要通过 `WorkerClient.run(type, payload)` 发送任务，不直接调用这些 engine。

## M4 当前结构

M4 是目前最复杂的一段，所以已经拆成几个小模块。可以把 `m4-engine.js` 理解成总控文件，其他文件各管一块细节。

### `m4-engine.js`

M4 总控流程。它不负责解释所有细节，而是把各步骤串起来：

```js
const base = buildBasePayload(context);
const diagnosis = diagnoseResidualRisk(base);
const scenarioPlans = buildScenarioPlans(base, diagnosis);
const evaluated = scenarioPlans.map((scenario) => evaluateScenario(base, scenario));
const scored = scoreScenarios(evaluated, context.input?.m4 || {});
const recommendation = buildRecommendation(scored);
```

它目前仍保留了方案复验和年度指标计算相关逻辑，比如追加投资、压力月复验、全年复验、PVUR、GFF。这部分先不继续拆，方便追踪 M4 如何把方案落到仿真结果上。

### `m4-base-payload.js`

负责把 M1/M2/M3 的上下文整理成 M4 能用的基础输入。

适合修改这里的情况：

- M4 需要新增来自 M1/M2/M3 的字段
- M4 前置校验规则变化
- 柔性矩阵路线或传统桩站路线的基础参数承接方式变化
- 气象、分时电价、车辆参数等基础仿真参数口径变化

### `m4-risk-diagnosis.js`

负责残余风险诊断。

适合修改这里的情况：

- 调整 low / medium / high 风险阈值
- 调整功率、能量、服务、SOC 风险的触发条件
- 修改 `severity` 或 `severityScore` 的计算方式
- 改 M4 如何理解 M3 传来的残余风险

### `m4-scenarios.js`

负责生成 S0~S4 工程方案。

适合修改这里的情况：

- 调整 S1/S2/S3/S4 的硬件增量
- 改功率、储能、PCS、桩、矩阵接口的补量规则
- 改每个方案的 `intent` 或 `triggerBasis` 文案
- 新增 S5、删除某类方案，或细分 S1/S2/S3

### `m4-recommendation.js`

负责方案评分、硬可行性判断和最终推荐。

适合修改这里的情况：

- 调整推荐权重
- 修改硬可行性条件
- 改低投资方案、高保护方案、综合推荐方案的选择逻辑
- 改 fallback 推荐逻辑

## M4 数据流

M4 的数据流大致是：

1. 从 `context` 读取 M1 基准硬件、M2 压力测试、M3 已选路线和全年验证上下文。
2. `buildBasePayload()` 组装基础仿真参数。
3. `diagnoseResidualRisk()` 诊断 M3 后仍然存在的风险。
4. `buildScenarioPlans()` 基于风险生成 S0~S4 候选方案。
5. `evaluateScenario()` 对每个方案做压力月复验和全年复验。
6. `scoreScenarios()` 按风险、投资、电网友好度、光伏利用率、LCOE 评分。
7. `buildRecommendation()` 先筛硬可行方案，再给出最终推荐。
8. 返回 `M4Result` 给页面渲染。

## 常见修改位置

如果你想改推荐权重：

- 默认值在 `src/config/system-config.js` 的 `DEFAULT_PROJECT_INPUT.m4`
- 评分公式在 `m4-recommendation.js`

如果你想改“什么算高风险”：

- 看 `m4-risk-diagnosis.js`

如果你想改 S0~S4 怎么生成：

- 看 `m4-scenarios.js`

如果你想改 M4 接收 M1/M2/M3 的字段：

- 看 `m4-base-payload.js`

如果你想改压力月/全年复验细节：

- 先看 `m4-engine.js` 中的 `evaluateScenario()`
- 再看 `m4-dispatch-core.js` 中的调度仿真内核

## 快速检查

重构或调整 M4 后，可以运行：

```bash
node scripts/smoke-test.mjs
```

这个脚本不会跑完整全年仿真，只检查 M4 拆分模块、推荐逻辑和 Worker 依赖链是否还能正常加载。
## 柔性矩阵接口数口径

`N_matrix` 现在优先按压力月日均接入需求确定，不再只按固定车辆瞬时并发 P99 定位。

当前传递关系是：

1. M2 输出 `monthlyAccessDemand`、`dailyAccessDemand` 和 `recommendedMatrixByDailyAccess`。
2. M3 将 `ceil(dailyAccessDemand)` 作为柔性矩阵接口数的主要下限。
3. 固定车队 P95/P99/Max 并发需求继续作为安全参考，避免日均接入口径低估高峰并发。
4. 最终 `recommended` 取日均接入口径、固定车 P99 口径、既有桩数下限中的较大值。

这样柔性矩阵的定位更清楚：它首先是尽量满足日均车辆接入需求的接口矩阵，再通过调度策略降低排队、峰值压力和能量缺口。
