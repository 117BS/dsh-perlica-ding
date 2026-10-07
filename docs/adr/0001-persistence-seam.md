# ADR 0001 — 持久化 seam、包通道形态与版本容忍策略

- 状态：**已决**（决策权威：YG，2026-10-07）
- 适用仓库：`ENDFIELD-TERRA/dsh-perlica-ding`（fork of `117BS/dsh-perlica-ding`）
- 上游基线：`117BS/dsh-perlica-ding@142c17b`（= master HEAD，2026-09-11）
- 证据来源：T1 `docs/workstreams/01-std-contract.md`、T2 `docs/workstreams/02-harness-matrix.md`、T3 `docs/workstreams/03-plugin-audit.md`

## 1. 问题

音量（以及任何用户设置）在 DSH 0.2.0-rc.2 桌面版上**无法持久化**。

根因（两轮独立复核一致）：插件把 `ctx.settings.register(...)` 包在 `try/catch` 里（`index.mjs:245-264`）。0.1.5 线上 `ctx.settings` 是 `SettingsProvider`（有 `register`），0.2.x 线上是 `SettingsForms`（**没有** `register`，ns = profile entry patch id，写进 `profiles/<p>/cordis.patch.yml`）。0.2 线上 `register` 是 `undefined` 而非取服务时抛错，因此取服务检查无声，异常被自身 catch 吞掉，音量退化为进程内 `runtimeVolume`。

同时 T3 发现 **N1（假绿）**：插件自带的 `scripts/verify-settings.mjs` 提供了一个**带 `register` 的假 settings 服务**，于是自检通过——"验证通过"与"真实宿主可用"之间没有因果关系。本 ADR 的第 7 节据此立了一条验证纪律。

## 2. 决策驱动

| # | 驱动 | 来源 |
|---|---|---|
| D1 | 桌面版（0.2.0-rc.2）**今天**必须真正持久化 | YG 目标 |
| D2 | 必须跨 `0.1.5 → 0.2` 这条断崖存活 | T2（唯一断崖） |
| D3 | 不假定上游 `T-Auto/dsh-std` 会合并我们的改动 | YG 裁决 |
| D4 | 对外只向 `117BS/dsh-perlica-ding` 提 PR，评审成本要可控 | YG 裁决 |
| D5 | 能走 dsh-std 就走，不行用通用方法 | YG 裁决 |
| D6 | 冻结既有用户契约（配置键名、四档语义、音效资源） | T3 BC12 |

## 3. 候选方案

| 方案 | 评估 |
|---|---|
| **A 纯标准组件**（只有 `dsh-plugin.json`，无 `dsh.bundle`） | ❌ 否决：`storage.dsh/v1alpha1` 在 dsh-std 与 DSH 两侧都**没有 provider**，且协商禁止消费者自供；硬 require 会 `required-support-failure` 装载失败。纯标准版**无法持久化**，且必须有 `@dsh-std/adapter-dsh` 才装载。 |
| **B 纯原生**（维持现状，现代适配） | ✅ 可用，但放弃 std 宿主可移植性；"基于 dsh-std"退化为词汇层。 |
| **C 单包双通道 + 激活守卫** | ✅ **选中**（YG 裁决）。原生通道是 DSH 上的活路径；`dsh-plugin.json` 让 std 宿主也能发现。守卫解决 T1 证实的**双载**风险。 |
| **D 两包互斥**（native + std） | ❌ 本轮否决：语义最干净，但 monorepo 重构显著抬高 D4 的评审成本。保留为守卫证伪时的退路。 |

### 3.1 双载风险的代码依据（T1 §3.4）

- 原生通道入选 = 包名在 `dsh.profile.bundles` × 声明 `dsh.bundle`；
- 标准通道入选 = 包名在 profile `dependencies` × 包目录存在 `dsh-plugin.json`；
- 两者可同时为真，且 `mountProfileComponents` 不检查 `dsh.bundle`/`cordis.patch.yml`，原生侧不检查 `dsh-plugin.json`，**无任何去重守卫**；
- 安装器还会把带 `dsh.bundle` 的新依赖**自动写进** `dsh.profile.bundles`（T1 §3.3）。

## 4. 决策

### 4.1 包形态

**单包、双通道、模块级激活守卫**：

- `package.json` 保留 `dsh.bundle.patch`（原生通道，0.2 正式装载机制，不删）；
- 新增 `dsh-plugin.json`（标准通道发现面），host facet 入口指向与本包原生入口**同一份激活逻辑**；
- 守卫：两个通道的入口都在**同一模块作用域**里争抢一个一次性激活令牌（模块级 `let`，由 Node ESM 的 URL 缓存保证"同包只求值一次"）；拿到令牌的一方激活，另一方记录一行日志后 no-op。**不引入 `globalThis` 全局符号，不读 loader 内部结构**（后者会违反 AC-4 的"无未声明私有 API 依赖"）。
- 守卫失败模式与回退：若装载实验（T13）证明模块身份不唯一（两个通道各自求值），则**退回方案 D**（两包互斥），并以实验输出为据。

### 4.2 持久化责任链（三档，按可用性降级）

| 档 | 机制 | 可用性 | 结论 |
|---|---|---|---|
| P1 | `storage.dsh/v1alpha1 LocalStorage`（std，**optional requirement**） | 仅在 std 宿主存在合规 provider 时 | 声明并协商；拿不到就静默降级，**绝不硬 require** |
| **P2** | **DSH 原生 `ctx.storageDomain.open(defineDomain(spec))`** | **三线 lib 逐文件 sha256 完全一致，三线 base patch 均启用，root=`$DSH_HOME/storages`** | **主通道**（T2 §③） |
| P3 | 自有 JSON 文件（`$DSH_HOME/dsh-perlica-ding/state.json`） | P2 未挂载或 open 失败时 | 最后兜底；原子写（临时文件 + rename） |

**明确不采用**：`ctx.settings`（同名不同型，T2 判定"不是公共面"）与 `Config.volume.volatile()`（0.2 线独有，且耦合 `configEditor`/`profileContext`，两者在 0.1.5 线不存在）。T3 的 K1 建议（volatile）在此被**有意否决**，理由即 T2 的两条字节级证据。

`persistent` 标志的语义随之修正为：**「P2 可用且已成功 open」或「P1 已成功协商」**，不再是"有没有 settings 命名空间"。

### 4.3 配置与既有契约

- 配置键名冻结（T3 BC12）：`enabled` / `volume` / `debounceMs` / `soundDir` / `execTools`。
- 四档音效语义、只响主对话、每档独立防抖、音量 PCM 缩放语义、音效查找顺序的**意图**不变（查找顺序的**实现**按 K3 修正）。
- `sounds/` 与 `assets/` 原样保留；`cordis.patch.yml` 保留。

### 4.4 传输 seam（设置页 ↔ host）

UI 只有 3 个操作：`getState()` / `setVolume(v)` / `preview(kind)`。

- **T-native**：`webServer.register({kind:'prefix', path:'/perlica-ding/api', handler})`。三线 `index.d.ts` 逐字节同源（sha `342D45C37BFA`，T2）。
- **T-std**：dsh-std `ContributionHost` 的 facet-scoped 调用（仅适配器存在时）。

**范围约束**：T-std 只在 T1 的 ABI 显示实现量 **≤ 50 行**时实现；否则本轮不实现并在文档中标注为已知缺口（D1/D2 都不依赖 T-std）。

### 4.5 安全（K2 的处置）

桌面版实测的传输事实（asar `lib/main.js`：`protocol.handle('dsh-app')` → `forwardWebRequest`）：

- 渲染页 origin 是 `dsh-app://app`；非静态资源路径一律转投 harness 本地 HTTP 载体；
- 转投时**删除 `Origin` 头并附加 harness 的 host cookie**；
- 因此"`Origin` 缺失即拒绝"会误杀桌面合法路径。

**鉴权规则（按上述证据写成）**：

| 规则 | 理由 |
|---|---|
| 只接 `GET /perlica-ding/api/state`、`POST .../volume`、`POST .../preview`，其余 404 | 最小暴露面 |
| `Origin` **缺失 → 放行**；存在 → 仅允许 `dsh-app://app` 与 loopback（`http://127.0.0.1:*`、`http://localhost:*`）；其余 403 | 桌面转投路径形态 + 同源浏览器；跨站 POST 被挡 |
| 所有 POST 强制 `Content-Type: application/json` | 跨站请求会被迫走预检，而本载体无 CORS 头 → 预检失败，请求到不了 handler |
| 请求体上限 8KB（超限 413）、非 JSON 体 400 | 消除静默截断（旧实现 64KB 截断后仍解析） |
| UI 不再轮询 | 旧实现失败时 5 次重试 + 手动重试按钮，属噪声 |

**残余风险（显式接受）**：本机任意进程仍可直连 `127.0.0.1:<port>` 调用这三个端点，影响面仅"会话内改音量 / 响一声"。记录为已知缺项；**不私造令牌绕开载体自身的准入策略**（`ctx.connection.requestRejection` 属 0.2 线能力，不在公共最小面内）。

## 5. 接口（实现前冻结，供并行工作使用）

```text
lib/core/            # 纯逻辑，无宿主依赖，可在 Node 里直接单测
  kinds.mjs          # 四档定义与标签
  volume.mjs         # 音量模型：0..100 整数、presets、clamp
  wav.mjs            # PCM 增益缩放 + 缓存键（内容摘要，非 basename+size）
  exec-tools.mjs     # 执行类工具白名单（N6 重列后的默认集合）
  scenarios.mjs      # 事件 → 四档判定（纯逻辑，isRoot 由调用方注入）

lib/host/
  config.mjs         # schemastery Config（键名冻结，见 §4.3）
  activate.mjs       # 模块级激活令牌 + 两通道共享装配 + 事件接线
  store.mjs          # VolumeStore：P1/P2/P3 三档 provider + 选择器 + 负路径
  engine.mjs         # 播放链（每平台 argv + 升级链）+ 防抖 + 解析器
  transport-native.mjs # T-native 路由（含 §4.5 鉴权）
  entry-native.mjs   # 原生 Cordis 入口：name / inject / Config / apply
  facet-std.mjs      # 标准 host facet 入口（plain object，见 §4.4）

lib/browser/
  index.js           # 设置页 + 传输（单文件经典脚本，见下方"单文件约束"）
```

**单文件约束（2026-10-07 核实）**：DSH 的 client bundle 体系每包只服务一个 `exports["./client"]` 文件，工厂内 `require()` 不解析子路径。理论上存在包内 client chunk（`require.async("./client.*.js")`，受 `CLIENT_CHUNK` 正则约束），但已装插件**零使用**该 API、且 `node_modules` 下**不存在任何** `client.*.js` chunk 文件——属"源码里存在、生态零实践、实机未验证"的机制，而验收重启是人工成本。故传输层以**注入 `fetchImpl` 的纯函数**形式内联进 `index.js`：单文件、零定时器、`index.js` 内直接 `fetch(` 零命中（全部网络只经该 seam）。

**VolumeStore 契约**（唯一的持久化接口）：

```text
read(): Promise<{ volume: number, source: 'P1'|'P2'|'P3'|'default' }>
write(volume: number): Promise<{ ok: true, source: string }>   // 失败必须抛，不得静默
capabilities(): { persistent: boolean, kind: 'P1'|'P2'|'P3'|'none' }
```

## 6. 负路径与恢复（keel §5）

| 触发 | 决策权 | 动作 | 终止不变量 | 证据 |
|---|---|---|---|---|
| P2 服务不存在 | 插件自动 | 降级 P3 | 音量仍可读写且跨重启保持 | `capabilities().kind === 'P3'` |
| P2 `open()` 抛错 | 插件自动 | 记录一次 → 降级 P3，本进程不再重试 | 不进入"每次读都抛"的循环 | 降级日志 1 条 + kind=P3 |
| 存储文件损坏/非 JSON | 插件自动 | 保留损坏文件为 `.corrupt-<ts>`，回落到默认值并写新文件 | 不静默丢用户数据 | `.corrupt-*` 存在 |
| `write` 失败 | 插件自动 | **向 UI 明确报错**，内存值不提交 | UI 不得显示"已保存" | `/perlica-ding/api/volume` 返回非 2xx |
| `volume` 越界/非数 | 插件自动 | clamp 到 0..100，非有限数拒绝 | 存储值恒为 0..100 整数 | 单元测试 |

## 7. 守卫与验证（falsifiable）

1. **不许 mock 掉被验证的 seam**（N1 的直接后果）：任何声称验证持久化的测试，必须至少有一条跑在**真实** `storageDomain` 或真实文件系统上；mock 只允许用于失败路径注入。
2. **装载唯一性（T13）**：在隔离 profile 中同时满足两条通道的入选条件，断言"恰好一次激活"（日志计数 + 音效播放计数）。这是 3.1 的证伪实验。
3. **重启保持（AC-1）**：改值 → 完全退出进程 → 重启 → 值保持，且能指出承载它的文件/表。
4. **旧线不崩（AC-3）**：在 `settings` 只有 `register` 的形态下，插件必须走 P2 且不调用 `register`；在 `settings` 只有 `update/describe` 的形态下同样不调用。
5. **无私有耦合（AC-4）**：`grep -r "dsh-settings\|config-editor\|profileContext"` 在 `lib/` 下必须为 0 命中（除注释/文档）。

## 8. 后果

- **retire**：自建桥的裸奔形态、`registerVolumeSettings`/`volumeScope`/`runtimeVolume` 三件套、`verify-*.mjs` 这类会造假的断言、`dsh.client.inject` 的假依赖（T3 N21）。
- **net growth**：新增 `dsh-plugin.json` + 一个 facet 入口 + 三档 store。理由：D1/D2 无法用更少的活动部件同时满足；三档不是投机抽象——P1/P2/P3 **都真实存在**（P1 在 std 宿主，P2 在本机正在运行，P3 是 P2 缺席时的现实）。
- **风险**：P2 是三线同构的**当前**事实，不构成未来承诺。若 DSH 改动 `storageDomain`，P3 仍然兜底——这是把 P3 保留为真实档位（而非死代码）的全部理由。

## 9. 未决

1. 守卫的模块身份假设（§4.1）待 T13 装载实验证伪。
2. `enabled` 是否也纳入设置页（T3 遗留 2）。
3. `SYSTEM_SOUNDS` 在 std 形态归 host facet 还是配置（T3 遗留 4）。
4. 24bit/float WAV：补实现还是显式拒绝（T3 遗留 5）。
5. 0.1.5 线的 loader 版本无直接观测（T2 遗留 a）——AC-3 的"旧线"以 **API 形态仿真**为准，不作为真实宿主证据。
6. **P1（std LocalStorage）已声明但有意未接线**：两个入口都没有向 `createVolumeStore` 传入 `storageProviders`，因为 DSH 侧与 dsh-std 侧当前都不存在合规 provider（T1 §5.1），接线即死代码。改变条件：T7（我们的 dsh-std fork 内参考 provider）落地并被安装后，由 facet 在 `activate(context)` 里用 `context.protocols.client(...)` 构造 P1 provider 传入——届时本 ADR 与 README 需同步回改。
7. 设置页只显示"能/不能持久化"两态，**不显示档位名**（`capabilities().kind` 已随 `/state` 传递）。若要求显示档位名，需改 UI 后回填文档。

