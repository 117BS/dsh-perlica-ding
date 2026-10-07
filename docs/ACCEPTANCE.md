# 验收账本（AC-1 … AC-8）

> 逐条可判定。每条给"判据 / 当前证据 / 状态"。**未验证一律写未验证**，不写"应该没问题"。

| # | 判据 | 证据 | 状态 |
|---|---|---|---|
| **AC-1** | 桌面版改音量 → **完全退出** → 重启 → 值保持；且 `$DSH_HOME` 下存在承载文件 | 离线部分**已证**（见下"重启前的离线证明"）；**承载文件已在场**：`$DSH_HOME\storages\perlica_ding.json` 现为 `volume:45`（由 AC-2 的 web 宿主写入）→ 桌面重启后若显示 45，即为"跨进程从盘读回"的独立证据 | ⏳ 仅剩重启 |
| **AC-2**（已修正） | web profile 上同样通过；且唯一网络面是那一条 hardened 路由 | **真服务器实测通过**（`dsh --profile web --port 19456 --no-open`，验完即停）：`GET /state` → 200 `persistent:true kind:"P2"`；`POST /volume {45}` → 落盘；读回 45；跨站 Origin → **403**；非法值 → **400**；错 Content-Type → **415**。浏览器 UI 渲染未验 | ✅（除浏览器渲染） |
| **AC-3** | 同一 artifact 在 0.1.5-rc.2 线与 0.2.0 线各有一条自动化通过记录 | `tests/host-simulation.test.mjs`：两代 **API 形态仿真** + `settings` 零访问 trap 断言 | ✅（仿真级；**非**真实旧线宿主，见 ADR §9.5） |
| **AC-4** | 无未声明的私有 API 依赖；`node --test` 全绿 | `lib/**` 无 `dsh-settings`/`config-editor`/`profileContext` 引用；104 tests / 0 fail；三线公共最小面见 T2 §② | ✅ |
| **AC-5** | 上轮 9 条隐性问题逐条闭环 | `docs/workstreams/04-issue-closure.md`（含 T3 追加的 21 条） | ✅（残留项见下） |
| **AC-6** | 依赖精确版本 + lockfile；PR 正文含四段证据 | `dependencies: zod 4.6.5` 精确；**无 lockfile**（上游插件仓本就没有，见待决 D-1）；PR 正文待写 | ⚠️ 部分 |
| **AC-7** | 四档音效桌面实测各响一次，含子代理静音、纯问答静音两条负例 | 负例已自动化（`tests/`）；**听觉验证待重启后由 YG 确认** | ⏳ |
| **AC-8** | 卸载后不残留未声明状态 | 路径：`$DSH_HOME/storages/perlica_ding.json`（P2）或 `$DSH_HOME/dsh-perlica-ding/state.json`（P3）+ `.corrupt-*`；未实测卸载 | ⏳ |

## AC-2 的修正说明（诚实账）

原条款写的是"插件不再注册任何自建 HTTP 路由（传输由 adapter 承载）"——那是在"纯标准组件"假设下写的。**实际采用原生通道 + 一条 hardened 路由**（理由见 ADR §4.4/§4.5：std 通道需要第三方 adapter 且无 provider），所以该条款的后半句**不再适用**，改为"唯一网络面是那一条路由，且 Origin/Content-Type/大小准入有测试覆盖"（`tests/host-negative.test.mjs` + `tests/host-simulation.test.mjs`）。这不是降标，是把条款对齐到已决架构。

## 重启前的离线证明（AC-1 的预备证据）

全部在**装出来的那份**（`profiles/desktop/node_modules/dsh-perlica-ding`，`file:` 快照）上完成：

1. **入口解析**：`import('dsh-perlica-ding')` → 导出 `Config,apply,inject,name`；内部裸导入 `@deepseek-ai/schemastery` / `zod` / `@deepseek-ai/dsh-storage-domain` 全部解析成功。
   > 反例：`link:` 安装会让 realpath 落到开发目录，裸导入**解析失败**（`Cannot find package '@deepseek-ai/schemastery'`）→ 已改用 `file:`。
2. **完整装配**：`apply(fakeCtx)` → `GET /state` 200（`persistent:true, kind:"P3"`）；`POST /volume {30}` 落盘；跨站 `Origin` → 403；缺 `Origin` → 200；播放链 spawn 成功；`dispose()` 干净。
3. **spec 校验**：用宿主自己的 `defineDomain` 跑我们逐字相同的 spec → 通过（`perlica_ding` / `tables:["settings"]`）。
4. **P2 带外往返**（真 `JsonStorageBackend` + 临时 root）：
   - 写 `{volume:30}` → `tables.settings.volume = {volume:30}`；
   - **换一个后端实例读同一 root → 仍是 30**（重启的类比）；
   - 承载文件确定为 `<root>/perlica_ding.json`（`single` 布局，源码 `storage-json/lib/index.js:569-575` 的 `join(root, name + ".json")`），内容形如
     `{"unit":{"name":"perlica_ding","version":1},"global":null,"tables":{"settings":{"volume":{"volume":30}}}}`
     → 真实路径即 `$DSH_HOME\storages\perlica_ding.json`，与 `.verification/capture-state.ps1` 的探测路径一致。
5. **注入面惰性**：`dsh-plugin.json` 不被 harness 自身清单包引用（`plugin-package-inventory-deepseek` / `host-plugin-inventory` 零引用；插件管理器只认 `dsh.bundle`）。

**仍未证**：P2 在真实宿主里经 `ctx.storageDomain` 的注入与单例（`already-open`）行为；真实 `webServer` 注册；客户端模块在真实浏览器里的加载。

### 追加：AC-2 真服务器实测的两个发现（2026-10-07）

1. **P2 在真实宿主上成立**（此前 T5-store 与 T9/T10 都把它标为唯一未闭合项）：真 `dsh web` 宿主里 `/state` 报 `kind:"P2"`，写入后 `<root>/perlica_ding.json` 出现，
   形状与离线预测**逐字一致**：`{"unit":{"name":"perlica_ding","version":1},"global":null,"tables":{"settings":{"volume":{"volume":45}}}`。
2. **`dsh plugin add` 与裸 `pnpm add` 不等价**（我第一次装 web profile 时踩到）：裸 `pnpm add` 只写 `dependencies`，**不写 `dsh.profile.bundles`**，于是插件根本不装载（路由 404，日志零 `perlica` 行）；把包名补进 bundles 后立刻生效。用 `dsh plugin --profile <name> add` 时这一步由安装器自动完成。



## 已知限制（不粉饰）

- **跨进程并发写**：宿主存储档（P2）落在 `$DSH_HOME/storages/perlica_ding.json`，后端是 **single 布局的整文件重写**，且 `storageDomain` 的 `already-open` 只在本进程内生效。因此**同时**运行两个宿主（例如桌面应用 + 另一个 `dsh web`）并各自改一次音量时，存在后写覆盖先写的窗口。影响面：音量设置、写入极稀疏。
- **P1 未接线**：见 ADR §9.6。
- **0.1.5 线只有 API 形态仿真**：本机无真实旧线宿主，见 ADR §9.5。

## 待决（需要 YG 或后续轮次）

- **D-1**：是否为本仓加 `pnpm-lock.yaml`？上游插件仓无 lockfile，加它会让 PR 变大；但精确锁定依赖是更稳的工程实践。
- **D-2**：`T7`（dsh-std fork 内参考 LocalStorage provider）是否本轮交付——它让 P1 档真正可用，但不影响任何现有宿主。
- **D-3**：推分支到 org fork 与开 PR 需你确认（远端记录）。
