# 04 — Issue closure（AC-5 闭环表）

- 状态：**T9/T10 闭环**，证据全部可复跑
- 上游：`docs/workstreams/03-plugin-audit.md`（T3 的 9 条 K + N 系列）、`docs/adr/0001-persistence-seam.md`（冻结契约）
- 代码基线：本文件写就时的 `lib/` 与 `tests/`；每次引用都给出 `file:line` 或测试名
- 判定口径：**已修**（给出落点与证据）/ **有理由不改**（写清理由）/ **移交**（给出去向）/ **未处置**（如实记录，不粉饰）
- 复跑：`node --test`（仓根）→ 见 §5

> **纪律**：本表不写没有证据的"已修"。任何"已修"都必须能指出落点行，并且能被本仓测试证伪（§5.2 的三次反例控制即为该纪律的执行）。

---

## 1. T3 原始 9 条（K1–K9）

| ID | 缺陷（T3 原文摘要） | 判定 | 落点 | 证据锚点 |
|---|---|---|---|---|
| **K1** | `settings.register` 在 0.2 线不存在，音量退化内存 | **已修** | ADR §4.2 明确弃用 `ctx.settings`，改走 P1/P2/P3（`lib/host/store.mjs`）；装配层 `lib/host/activate.mjs:204-218` 全程不触 `settings` | `tests/host-simulation.test.mjs` → `trap: a settings seam that explodes on any touch is never touched during a full turn`（含 trap 自检，证明陷阱真的会炸）；同文件两条 `assert.deepEqual(settingsCalls, [])`（0.2.x 的 `{update,describe}` 形状与 0.1.5 的 `{register}` 形状各一） |
| **K2** | 自建 HTTP 桥无鉴权/来源校验 | **已修** | `lib/host/transport-native.mjs:23-27`（`originAllowed`：缺 Origin 放行；`dsh-app://app` 与 loopback 放行；其余 403）；`:96-112`（POST 强制 `application/json`→415、超 8KB→413、非 JSON→400）；`:122`（未知路径 404） | `tests/host-negative.test.mjs` → `ADR §4.5 transport admission rules` 两条用例（6 条准入规则全覆盖；此前该表在测试里**零覆盖**） |
| **K3** | `resolveSound` 用 `process.cwd()` 当工作区 | **已修** | `lib/host/engine.mjs:11-15,93-107`（候选链由调用方决定，只回存在项）；`lib/host/activate.mjs:120-136`（soundDir → 会话 cwd → 包内 → OS，OS 候选在 `:129-134` 先 `existsSync`）；工作区来源改为 `agent.session.header.cwd`（`activate.mjs:277-283`）。`process.cwd()` 在 `lib/` 的**代码里 0 处**，仅剩 3 处注释说明为何不用（`lib/host/activate.mjs:116`、`lib/host/engine.mjs:7,11`） | `tests/engine.test.mjs` → `the sound resolver searches candidates in order and returns null when none exist (K3, N13)`；`tests/host-simulation.test.mjs` 的 `driveDoneTurn` 走真装配链并真的 spawn |
| **K4** | `settings` 缺失只 `console.error`、不重试 | **已修** | `lib/host/store.mjs:128-149`（`select()` 结果 memo 化：一次选择、终身固定、失败只记一次）；`lib/host/store.mjs:205`（`acquireFacility` 用 `ctx.inject(['storageDomain'])`，上界 1000ms，超时后退到下一档而不是放弃本进程） | `tests/store.test.mjs` → `degrades once when a tier throws from open, and never retries it`；`tests/host-negative.test.mjs` → `any other storageDomain failure degrades once and is never retried`（断言 `facility.opens === 1`，跨读/写多次） |
| **K5** | `agents` 不可用时 `isRoot` 返回 `true` | **已修（core）+ 有意例外（装配层）** | core：`lib/core/scenarios.mjs:53-54`（`rootOf` **默认拒绝**）、`:89-127`（`toolResult` / `ask` / `error` 全部 root 门控）。装配层例外：`lib/host/activate.mjs:187-190`（服务不可用→`true`）、`:191-199`（`roots()` 抛错或返回空数组→`true`），注释给出的理由：宁可多响一声也不让插件永久静音 | `tests/core.test.mjs` → `an undecidable root stays silent instead of guessing (K5)`、`subagent turns never decide a sound, in either direction (BC5, K5)`。**与 T3 建议不完全一致**：T3 要求服务不可得时保守判非 root，实现选择了相反方向 —— 见 §4 残留 R1 |
| **K6** | `execTools` 默认白名单与真实工具集错配 | **部分已修；两处需裁决** | 已补：`present`(`lib/core/exec-tools.mjs:38`)、`str_replace_editor`(`:42`)、`job_output`(`:57`)、`spawn_teammate`/`send_message`/`wait_agent`/`team_task_*`/`interrupt_agent`(`:43-48`)、`terminal_*`(`:30-33`)、`cordis_*`(`:52-55`)；已排除 `todo_write`/`job_list`/`cordis_inspect_*`/`list_agents` | `tests/core.test.mjs:143` → `default exec whitelist counts effects and excludes pure reading/bookkeeping (N6)`（正反两组名单）。**未闭合部分见 §4 残留 R2** |
| **K7** | 音量缓存键 = basename + volume + 字节数 | **已修** | `lib/core/wav.mjs:52`（`contentDigest`）、`:62`（`cacheKeyFor` 取内容摘要）、`:169`（`scaleWavVolume`，缩放与落盘的唯一入口） | `tests/core.test.mjs` → `WAV cache identity follows file content, not the file name or size (K7)`、`the digest key is stable for identical bytes and differs on one changed byte`、`a failing cache write still yields the scaled audio, and never a half-written entry (N15)` |
| **K8** | 无 `settings.configure({auto:false})` | **有理由不改** | 适用条件已消失：ADR §4.2 同时否决了 `ctx.settings` 与 `Config.volume.volatile()`，因此"自动生成配置页"与 `SettingsForms.update('volume')` 两条路径都不再存在。`lib/host/config.mjs:10-31` 的 Config 无 volatile 字段，不会触发 `autoGenerate` | `grep -n 'settings\.configure\|\.volatile\('` 在 `lib/**/*.mjs` → **0 命中**；`grep -n 'volatile'` 在 `lib/host/*.mjs lib/core/*.mjs` → **0 命中**；`lib/host/activate.mjs:204-218` 的持久化装配不引用 settings |
| **K9** | `verify` 脚本不在 `files`，安装副本 MODULE_NOT_FOUND | **已修** | `package.json` `scripts.verify = "node --test"`；测试迁入仓内 `tests/`（6 个文件）；`files` 不含 `scripts/`，因此安装副本不再承诺可 verify | `node --test`（仓根）→ 104 pass / 0 fail；`tests/` 下 6 个 `*.test.mjs` |

---

## 2. T3 新发现中已采纳的（N1–N21 相关）

| ID | 缺陷（T3 原文摘要） | 判定 | 落点 / 理由 | 证据锚点 |
|---|---|---|---|---|
| **N1** | 自检脚本用假 settings 造假绿 | **未处置（清理缺失）→ 移交** | 假绿**路径**已断：`package.json` 不再引用 `scripts/verify*.mjs`，`files` 也不打包它们。但**文件仍在仓内**，`scripts/verify-settings.mjs:78` 依旧是那个带 `register` 的假 settings 服务。ADR §8 把 `verify-*.mjs` 列为 retire 目标 | `grep -n 'register(' scripts/verify-settings.mjs` → `:78` 仍在；`package.json` `scripts` 段只剩 `verify: node --test`。删除不在本轮写入范围 |
| **N2** | `ask` 无 root 判定 | **未处置（修了一半）** | `lib/host/activate.mjs:290-293` 的 `tools/execute` **已加** `isRootRef(exec.agent)` ✓；但 `:295-298` 的 `approval/request` 仍无条件 `play('ask')`，**未使用 `_req.agent`**（参数名以 `_` 前缀表明被有意忽略）。同时 core 提供的 root 门控 seam `lib/core/scenarios.mjs:126-129`（`decider.ask()`）**装配层从未调用**（`grep 'decider\.ask' lib/host/activate.mjs` → 0 命中），目前是死代码 | `lib/host/activate.mjs:295-298`；`lib/core/scenarios.mjs:126-129`；`tests/core.test.mjs` → `ask and error are root-gated (N2)` 只覆盖 core，**未覆盖装配层** |
| **N3** | 回合判定用墙钟时间戳 | **已修** | `lib/core/scenarios.mjs:9-13`（改布尔回合标记）、`:79-102`（`claim` 重置标记、`toolResult` 置位）、`:111-117`（`turnStopping` 读标记）；`lib/host/activate.mjs:277-283` | `tests/core.test.mjs` → `a claim resets the previous turn marker: no work leaks across turns (N3)`、`an execution tool observed before the claim still counts for that turn` |
| **N4** | `planMode` 抛错不兜底到事件折叠 | **已修** | `lib/host/activate.mjs:310-322`：`planMode.get()` 抛错 → `warnOnce` + 回落 `foldPlanModeFromEvents`；`planMode` 整个缺席 → 同样折叠（`foldPlanModeFromEvents` 定义于 `:95-102`） | `lib/host/activate.mjs:310-322`；`tests/host-simulation.test.mjs` 全部用例注入 `planMode.get()` 并驱动 `agent/turn-stopping` |
| **N6** | 一个 ID 覆盖两件事，处置不同 | **拆开判定** | ① `job_output` 缺失 → **已修**（`lib/core/exec-tools.mjs:57`）。② 审计原文的 `btoa`/`engines`：`btoa` **已修**（`lib/host/engine.mjs:48-50` 改用 `Buffer.from(text,'utf16le').toString('base64')`）；`engines` **未处置 → 移交**（`package.json` 无 `engines` 字段，grep 0 命中；不在本轮写入范围） | `tests/core.test.mjs:143` 的 `job_output` 在"应计数"名单内；`grep -n 'btoa' lib/` → 0 命中；`grep -n 'engines' package.json` → 0 命中 |
| **N7** | `done` 非零退出码也 resolve，降级链几乎不触发 | **已修** | `lib/host/engine.mjs:194-199`：把 `done` 的 resolved 结果当判定依据，`exitCode !== 0` 继续下一个候选 argv，不再只靠 `catch` | `tests/engine.test.mjs` → `a non-zero exit escalates to the next interpreter (N7)`、`a provider rejection and a throwing spawn also escalate, and exhaustion reports false` |
| **N13** | `resolveSound` 找不到时返回不存在的 `candidates[0]` | **已修** | `lib/host/engine.mjs:97-107`（只回存在项，否则 `null`）；`lib/host/engine.mjs:236-237`（`no-sound` 静默放弃）；`lib/host/activate.mjs:129-135`（OS 候选同样先 `existsSync`） | `tests/engine.test.mjs` → `the sound resolver searches candidates in order and returns null when none exist (K3, N13)`、`unknown kinds and missing sounds are reported, not thrown (N13)` |
| **N19** | `verify-volume.mjs` 改写 `process.platform` | **已修** | `lib/host/engine.mjs:139-146`：`platform` 是注入参数，`playbackAttempts(platform, file)` 为纯函数；测试不再改写全局 | `tests/engine.test.mjs` → `the engine never mutates the platform it was given (N19)` |
| **N21** | `dsh.client.inject` 声明了不存在的客户端模块行 | **未处置（复核后仍成立，非误报）→ 移交** | 实测 `@deepseek-ai/dsh-client-ui-slots` 的清单**无 `dsh` 字段、无 `exports["./client"]`**（桌面 asar `dsh/node_modules/@deepseek-ai/dsh-client-ui-slots/package.json`），因此它永远不是 client module row；对照 `@deepseek-ai/dsh-client-ui-settings` 声明 `dsh.client = {"inject":["@deepseek-ai/dsh-api-remotes"],"platform":"web"}`。插件客户端真正的依赖是运行时 `ctx.get('slots')`（`lib/browser/index.js:506-522`，`exports.inject = ['slots']`），与 `package.json:19-22` 的图边不是同一件事 | `package.json:19-22` 仍写着 `@deepseek-ai/dsh-client-ui-slots`。**影响未验证**：该图边是否导致客户端 bundle 不被装载，需要 T13 的装载实验才能定论 —— 见 §4 残留 R4 |

---

## 3. 本轮新发现

| ID | 缺陷 | 判定 | 落点 | 证据锚点 |
|---|---|---|---|---|
| **D1** | 空档位把 `source` 报成档位名，导致 `config.volume` **永不生效** | **已修**（本轮） | `lib/host/store.mjs:159`：档位可用但无存档 → `source: 'default'`（与 `:153` 无档位、`:162` 读失败一致）。`lib/host/store.mjs:151-164` 语义钉死为"值的来源"；`capabilities().kind` **未改**，仍报告"已选中的档位"（T5 契约 §2 的要求）。模块头注释 `lib/host/store.mjs:28-40` 把两者的区别写进契约文本 | `tests/host-simulation.test.mjs` → `defect D1 regression: an empty tier must not shadow config.volume`：P2 空 + `config.volume=30` → `/state.volume === 30` 且 `kind === 'P2'`；写入 70 后重开 → `70`（持久值胜过配置值）；P3 空 → `30`。**反证**：把 `:159` 改回 `source: store.kind` → 该文件 5 条用例变红（§5.2 的 M-D1）。仓库内所有固化旧语义的断言已同步改正：`tests/store.test.mjs` 6 处、`tests/host-simulation.test.mjs` 4 处 |
| **D2** | `readJsonBody` 的 8KB 上限与 `Content-Type` 强制在本轮之前**没有任何宿主级测试** | **已补测试（非缺陷）** | 实现本身符合 ADR §4.5；缺的是证据 | `tests/host-negative.test.mjs` → `ADR §4.5 transport admission rules`（Origin 三正一反、`text/plain`→415、超限→413、未知路径→404、无内容类型→415） |

---

## 4. 残留与移交

| ID | 事项 | 性质 | 去向 |
|---|---|---|---|
| **R1** | `agents` 服务不可用/`roots()` 抛错/`roots()` 为空时，装配层仍判"是 root"（`lib/host/activate.mjs:187-199`） | **有意例外**，与 T3 K5 的建议方向相反 | 需要 ADR 补一条明确裁决：要么保留（理由是"宁可多响一声"），要么改成保守判非 root。当前注释已写下理由，但**没有 ADR 记录**，属未被治理的取舍 |
| **R2** | `create_goal` / `update_goal` 仍留在默认执行白名单（`lib/core/exec-tools.mjs:60-61`），且 `tests/core.test.mjs:143` 把它当成期望行为固化 | **待裁决**：T3 K6 明确要求移除（模型每轮收尾常调 `update_goal` → 纯对话误判为"任务完成"）；实现按 `exec-tools.mjs:5-12` 的语义规则（"改变会话外的副作用，含持久状态"）保留。**`exec-tools.mjs:59` 的理由注释引用 "config/ADR §5"，但 ADR §5 是接口冻结清单，未涉及 execTools 内容——该引用不成立**，因此这不是一个有据的"有理由不改" | 需要 ADR 一条裁决；无论哪个方向，`tests/core.test.mjs:143` 的名单都要随之改。同时 `job_kill`（`:58`）也是 T3 建议移除、实现保留的同类条目 |
| **R3** | `lib/core/scenarios.mjs:126-129` 的 root 门控 `decider.ask()` 装配层从未调用（N2 的另一半） | **死代码 + 契约缺口** | `lib/host/activate.mjs` 侧的接线修复（`approval/request` 用 `req.agent` 判定，两处统一走 `decider.ask()`） |
| **R4** | `package.json:19-22` 的 `dsh.client.inject` 仍指向非客户端包（N21） | **一行 manifest 修正** | 需要与 T13 装载实验一起判定其实际影响后再改 |
| **R5** | `package.json` 无 `engines` 字段（N6 的后半） | **一行修正** | manifest owner |
| **R6** | `scripts/verify.mjs` / `verify-volume.mjs` / `verify-settings.mjs` 三个造假脚本仍在仓内（N1） | **清理缺失**（路径已断，文件未删） | 删除或改写为仓内契约测试；ADR §8 已列为 retire |
| **R7** | **P1 已声明、有意未接线** | **设计决定（ADR 已治理）** | `lib/host/entry-native.mjs` 与 `lib/host/facet-std.mjs` 都没有传 `options.storageProviders`，因此 P1 只存在于 `tests/store.test.mjs` 的选择顺序单测里。理由：DSH 侧与 dsh-std 侧都**没有** `storage.dsh/v1alpha1 LocalStorage` provider（T1 §5.1），接通即死代码。**已在 ADR 留痕**：`docs/adr/0001-persistence-seam.md:165`（§9 未决 6），含改变条件（T7 参考 provider 落地后由 facet 构造并传入）。无端到端 P1 断言是刻意的 |
| **R8** | 旧线证据缺口 | **取证边界** | 0.1.5-rc.2 主机在本机不可观测（T2 §9a）。`tests/host-simulation.test.mjs` 的 0.1.5 用例是 **API-shape simulation**（文件头已写明），不是真实旧线证据 |
| **R9** | 未做的验证 | **缺口** | ① 未在真实 DSH 进程内装载插件（禁止改用户 profile）；② T13 双通道装载唯一性实验未做；③ P2 未对**真实** `storageDomain` 跑过（仓内无法解析该包，见 `tests/host-simulation.test.mjs` 头的 `module.registerHooks` 说明） |

---

## 5. 验证与反例控制

### 5.1 全仓

```
node --test        # 仓根
ℹ tests 104   ℹ suites 6   ℹ pass 104   ℹ fail 0
```

分文件：`core.test.mjs` 27 / `engine.test.mjs` 17 / `browser-transport.test.mjs` 25 / `store.test.mjs` 20 / `host-simulation.test.mjs` 6 / `host-negative.test.mjs` 9。

另核 ADR 的两条可判定验收：

- **AC-4（ADR §7.5）无私有耦合**：`dsh-settings|config-editor|profileContext` 在 `lib/` 下 → **0 命中**（含注释）。✓
- **AC-3（ADR §7.4）旧线不调用 `settings.register`**：0.1.5 形状用例断言 `settingsCalls === []` 且 `/state.kind === 'P2'`。✓（该用例是 **API-shape simulation**，见 `tests/host-simulation.test.mjs` 文件头的范围声明）

本轮新增 **15** 条（simulation 6 + negative 9），全部是宿主级集成缺口：此前 `activateHost` 的端到端装配**没有任何测试**。

ADR §6 行覆盖：

| ADR §6 行 | 覆盖用例 |
|---|---|
| P2 服务不存在 → 降级 P3 | `host-simulation` 0.2.x-without-facility、`host-negative` "with every tier unusable…" |
| P2 `open()` 抛错 → 记一次 → 降级 P3，不再重试 | `host-negative` "an already-open storageDomain…"（`already-open`）、"any other storageDomain failure degrades once and is never retried"（`opens === 1`） |
| 存储文件损坏/非 JSON → `.corrupt-<ts>` | `host-negative` "a corrupt P3 document is quarantined and the host keeps reading and writing"（真实文件、真实字节比对） |
| `write` 失败 → 向 UI 明确报错 | `host-negative` "a failed write answers 5xx and the page never shows the submitted value"（真实文件系统故障，非 stub） |
| `volume` 越界/非数 | `store.test.mjs`（clamp + 非有限数拒绝）、`core.test.mjs` |
| 另加 ADR §4.5 | `host-negative` "ADR §4.5 transport admission rules" 两条 |

### 5.2 反例控制（三个变异体，跑在 `%TEMP%` 副本上，仓库未被触碰，跑完全部删除）

| 变异 | 结果 | 变红的正是 |
|---|---|---|
| **M-A3**：在 `activateHost` 里插回 `ctx.get('settings')` | pass 5 / **fail 1**，exit 1 | `trap: a settings seam that explodes on any touch is never touched during a full turn` |
| **M-B3**：把 `setVolume` 的 `throw withStatus(500, …)` 换成吞掉 | pass 5 / **fail 2**，exit 1 | `a failed write answers 5xx and the page never shows the submitted value`、`with every tier unusable…`（两者都断言 5xx） |
| **M-D1**：把 `lib/host/store.mjs:159` 改回 `source: store.kind` | pass 1 / **fail 5**，exit 1 | `defect D1 regression…` 及 4 条 API-shape 用例 |

三个变异体全部被杀死，说明 §1/§2/§3 的关键断言都**能失败**，不是恒真装饰。
