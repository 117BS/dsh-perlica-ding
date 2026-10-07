# 验收账本（AC-1 … AC-8）

> 逐条可判定。每条给"判据 / 当前证据 / 状态"。**未验证一律写未验证**，不写"应该没问题"。

| # | 判据 | 证据 | 状态 |
|---|---|---|---|
| **AC-1** | 桌面版改音量 → **完全退出** → 重启 → 值保持；且 `$DSH_HOME` 下存在承载文件 | **待 YG 重启**（前置：`.verification/state-log.txt` 的 s0/s1 基线；安装已就位） | ⏳ 阻塞在重启 |
| **AC-2**（已修正） | web profile 上同样通过；且唯一网络面是那一条 hardened 路由 | 未开始 | ⏳ |
| **AC-3** | 同一 artifact 在 0.1.5-rc.2 线与 0.2.0 线各有一条自动化通过记录 | `tests/host-simulation.test.mjs`：两代 **API 形态仿真** + `settings` 零访问 trap 断言 | ✅（仿真级；**非**真实旧线宿主，见 ADR §9.5） |
| **AC-4** | 无未声明的私有 API 依赖；`node --test` 全绿 | `lib/**` 无 `dsh-settings`/`config-editor`/`profileContext` 引用；104 tests / 0 fail；三线公共最小面见 T2 §② | ✅ |
| **AC-5** | 上轮 9 条隐性问题逐条闭环 | `docs/workstreams/04-issue-closure.md`（含 T3 追加的 21 条） | ✅（残留项见下） |
| **AC-6** | 依赖精确版本 + lockfile；PR 正文含四段证据 | `dependencies: zod 4.6.5` 精确；**无 lockfile**（上游插件仓本就没有，见待决 D-1）；PR 正文待写 | ⚠️ 部分 |
| **AC-7** | 四档音效桌面实测各响一次，含子代理静音、纯问答静音两条负例 | 负例已自动化（`tests/`）；**听觉验证待重启后由 YG 确认** | ⏳ |
| **AC-8** | 卸载后不残留未声明状态 | 路径：`$DSH_HOME/storages/perlica_ding.json`（P2）或 `$DSH_HOME/dsh-perlica-ding/state.json`（P3）+ `.corrupt-*`；未实测卸载 | ⏳ |

## AC-2 的修正说明（诚实账）

原条款写的是"插件不再注册任何自建 HTTP 路由（传输由 adapter 承载）"——那是在"纯标准组件"假设下写的。**实际采用原生通道 + 一条 hardened 路由**（理由见 ADR §4.4/§4.5：std 通道需要第三方 adapter 且无 provider），所以该条款的后半句**不再适用**，改为"唯一网络面是那一条路由，且 Origin/Content-Type/大小准入有测试覆盖"（`tests/host-negative.test.mjs` + `tests/host-simulation.test.mjs`）。这不是降标，是把条款对齐到已决架构。

## 待决（需要 YG 或后续轮次）

- **D-1**：是否为本仓加 `pnpm-lock.yaml`？上游插件仓无 lockfile，加它会让 PR 变大；但精确锁定依赖是更稳的工程实践。
- **D-2**：`T7`（dsh-std fork 内参考 LocalStorage provider）是否本轮交付——它让 P1 档真正可用，但不影响任何现有宿主。
- **D-3**：推分支到 org fork 与开 PR 需你确认（远端记录）。
