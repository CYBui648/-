# Worker 模块说明

这一层放浏览器 Web Worker 中运行的计算逻辑。页面负责收集输入和展示结果，耗时计算通过 `solver.worker.js` 分发到各 engine，避免阻塞界面。

## 入口关系

- `M1_PLAN` -> `m1-engine.js`
- `M2_SCENARIO_COMPARE` -> `m2-engine.js`
- `M2_STRESS_TEST` -> `m2-engine.js`，兼容旧按钮/调用，实际执行四情景评价
- `M3_SCENARIO_OPTIMIZATION` -> `m3-engine.js`
- `M3_CONFIG_OPTIMIZATION` -> `m3-engine.js`
- `M3_DISPATCH_DIAGNOSIS` -> `m3-engine.js`，兼容旧调用，实际执行四情景配置优化

## 当前算法结构

- `scenario-core.js` 是公共内核，统一需求生成、桩服务、辐照序列、四情景能量仿真和成本口径。
- `m1-engine.js` 只生成 S0 离网基准配置。
- `m2-engine.js` 只评价 S0 在四情景下的运行表现。
- `m3-engine.js` 分别优化 C1-C4 四套情景配置，并输出横向比较。

## 快速检查

```bash
node scripts/smoke-test.mjs
```
