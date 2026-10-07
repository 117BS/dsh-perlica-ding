# T3 — dsh-perlica-ding 现插件全量清点 + 缺陷定位

| 项 | 值 |
|---|---|
| 任务 | T3：现插件全量清点（功能块 / 行为契约 / 缺陷 / 迁移落点 / 风险） |
| 状态 | Evidence（只读取证，无代码修改权限） |
| 审计对象 | `dsh-perlica-ding` @ `142c17b`（`package.json version 0.2.0`），`index.mjs` 530 行、`lib/client.js` 307 行 |
| 宿主基线 | `@deepseek-ai/dsh-base@0.2.0-rc.2`（`C:\Users\INAGN\.dsh\profiles\node_modules\@deepseek-ai`）；源码 `Q:\PROJ\deepseek-harness` @ `639ed01539`（tag `dsh-v0.1.6-alpha.2`，compose 线 = 0.2.0-rc.2） |
| 实装副本 | `C:\Users\INAGN\.dsh\profiles\desktop\node_modules\dsh-perlica-ding`（github pin `#142c17b`，**无 `scripts/`**） |
| 迁移目标 | `Ætherside/dsh-std` `@dsh-std/*@0.1.1-rc.x` |
| 已确诊症状 | 音量无法持久化；设置页显示"当前环境无法持久化" |

## 0. 一句话结论

宿主 0.2 线把配置面从"插件自注册命名空间"改成了"插件 Config schema + volatile 字段 + 配置编辑器"，而本插件的 Config 一个 volatile 字段都没有、`lib/client.js` 又是手写注册页 —— 三者叠加让 0.2 线没有任何可写通道，于是音量退化到进程内 `runtimeVolume`，所有"持久化"路径（含自建 HTTP 桥）都建立在已死 API 之上。

---

## A. 全量清单

### A.1 `index.mjs`（host facet）

| # | 块 | file:line | 职责 | 外部契约耦合点 |
|---|---|---|---|---|
| H1 | 模块头 + 常量 | `index.mjs:1-32` | 文档、`BUNDLED_SOUNDS`、`CACHE_DIR`、`name`、`inject:['subprocess']` | harness 服务 `subprocess`；`import.meta.url` 定位包内 `sounds/` |
| H2 | `scaleWavVolume(src, vol)` | `index.mjs:42-110` | 纯 JS 解析 RIFF、按 gain 缩放 8/16bit PCM、写 `%TEMP%\dsh-perlica-ding` 缓存 | 文件系统（tmpdir）、WAV 格式（PCM 1 / EXTENSIBLE 0xFFFE） |
| H3 | `DEFAULT_EXEC_TOOLS` | `index.mjs:120-137` | "执行类工具"白名单 | harness 工具名注册表（跨 0.1/0.2/agent-team 三套命名） |
| H4 | `Config`  schema | `index.mjs:140-161` | `enabled` / `debounceMs` / `soundDir` / `volume` / `execTools`；**无 `.volatile()`** | Loader 配置层校验；`SettingsForms` 只投影 volatile 字段 |
| H5 | `KINDS` / `KIND_LABELS` | `index.mjs:164-170` | 四档 id 与中文标签（同时是 API 的枚举白名单） | 自建 HTTP 桥 `state.kinds`、`preview.kind` |
| H6 | `SYSTEM_SOUNDS` | `index.mjs:173-192` | win32/darwin/linux 兜底音频路径表 | 系统文件路径（`C:\Windows\Media\*`、`/System/Library/Sounds/*`、freedesktop） |
| H7 | `utf16leToBase64` | `index.mjs:195-202` | PowerShell `-EncodedCommand` 编码 | 全局 `btoa`（Node >= 16） |
| H8 | `foldPlanModeFromEvents` | `index.mjs:209-219` | 服务缺失时从 session 事件折叠 `plan/mode` | session 事件名 `plan/mode`、`event.data.active` |
| H9 | `apply` 头部 + 运行时状态 | `index.mjs:221-232` | `ctx.get('subprocess'/'agents'/'planMode')`；`lastPlayed` / `turnStart` / `lastTool` | 服务名 `subprocess`、`agents`、`planMode` |
| H10 | 音量持久化注册 | `index.mjs:244-278` | `settings.register('dsh-perlica-ding', …, {base,applies:'live'})` → `volumeScope`；`runtimeVolume` 兜底；`currentVolume()` 优先级链 | **private API** `ctx.settings.register`（0.1.x 线） |
| H11 | `isRoot(agent)` | `index.mjs:280-288` | 用 `agents.roots()` 判定主对话 | harness 服务 `agents.roots()`；事件载荷 `payload.agent.id` |
| H12 | `resolveSound(kind)` | `index.mjs:296-307` | 候选顺序 `soundDir → process.cwd() → 包内 sounds/ → OS` | `process.cwd()`（**非**会话工作区） |
| H13 | `spawnBeep(attempts)` | `index.mjs:309-333` | 顺序尝试 argv、`handle.done` 失败时降级、cwd 固定 `C:\Windows` / `/` | `subprocess.spawn({argv,cwd,stdio,graceMs})`、`handle.done` |
| H14 | `play(kind, force)` | `index.mjs:339-362` | enabled → volume>0 → 每档 debounce → 解析 → 缩放 → 平台播放链路（win32 SoundPlayer / afplay / paplay+aplay） | 平台二进制、PowerShell `Media.SoundPlayer` |
| H15 | `readJsonBody(req)` | `index.mjs:372-386` | 原始 body 拼串 + `JSON.parse`，64KiB 截断，失败一律 `{}` | node `IncomingMessage` |
| H16 | `registerBridge(webServer, host)` | `index.mjs:389-446` | 注册 `/perlica-ding/api`（`kind:'prefix'`），实现 `GET /state`、`POST /volume`、`POST /preview` | `webServer.register({kind,path,handler})`、`ctx.effect()` |
| H17 | 延迟注入双路 | `index.mjs:450-467` | `webServer` 与 `settings` 各两条路径（现在 / `ctx.inject`） | `ctx.inject(names, cb)` |
| H18 | 事件绑定 | `index.mjs:469-529` | `agent/inbox/claimed`、`tools/result`、`tools/execute`(ask_user_question)、`approval/request`、`agent/error`、`agent/turn-stopping` | 6 个 harness 事件名；`ask_user_question` 工具名；`payload.agent` / `exec.name` / `exec.agent` |

### A.2 `lib/client.js`（browser facet）

| # | 块 | file:line | 职责 | 外部契约耦合点 |
|---|---|---|---|---|
| C1 | 模块头 + 注册 | `lib/client.js:1-20` | 经典脚本 `window.__ModuleLoader__.load({id, factory})`，`require('react')` | `window.__ModuleLoader__` 队列门面；React 必须来自平台 seed |
| C2 | `request(path, body)` | `lib/client.js:28-50` | fetch 桥；非 `application/json` 一律判定"路由未就绪" | fetch、`/perlica-ding/api` 路径硬编码 |
| C3 | `VOLUME_PRESETS` | `lib/client.js:52-57` | 100/60/30/0 四档预设 | — |
| C4 | `styles` | `lib/client.js:59-122` | 用 `--dsw-alias-*` 主题变量的手写样式 | DSH 主题 token 名（未在契约中声明） |
| C5 | `PerlicaDingSettings()` | `lib/client.js:124-283` | 加载态/重试(5×2s)/滑块(200ms 去抖)/预设/试听/错误面板 | `/state`、`/volume`、`/preview`；`state.persistent` |
| C6 | `apply(ctx)` + 导出 | `lib/client.js:286-306` | `slots.inject('settings.section')` → `slots.register({name,id:'perlica-ding',order:60,label}, Component)`；`exports.inject=['slots']` | 槽位名 `settings.section`、`ctx.slots`、`dsh.client.inject:['@deepseek-ai/dsh-client-ui-slots']` |

### A.3 包与资源

| 块 | file:line | 职责 | 耦合点 |
|---|---|---|---|
| `package.json` `dsh.bundle.patch` | `package.json:13-16` | 声明组合层 patch → 由 app-boot 在 profile 组合时加载 | harness 0.2 `dsh.bundle.patch`（`profile.ts` / `plugin-manager`） |
| `package.json` `dsh.client` | `package.json:17-22` | `platform:'web'`、`inject:['dsh-client-ui-slots']`、`exports['./client']→lib/client.js` | `dsh-client-modules` 扫描（要求已构建的 `lib/client.js` + `exports['./client']`） |
| `package.json` `files` | `package.json:24-33` | 发布白名单（**不含 `scripts/`**） | npm pack / `dsh plugin add` |
| `package.json` `scripts.verify` | `package.json:35` | 三个自检脚本（**不在 files/ 内**） | node 直跑 |
| `package.json` peerDeps | `package.json:56-67` | `@deepseek-ai/cordis`、`schemastery` 均为 `*` 且 optional | 违反"精确版本 + lockfile"基线；也意味着不会拦住不兼容宿主 |
| `cordis.patch.yml` | 6 行 | `- insert: [{id: dsh-perlica-ding, name: dsh-perlica-ding}]` | Loader 条目 id 即目录 id |
| `sounds/` | 4 个 WAV（PCM16 mono 44.1k）：`plan.wav` 2.664s/235,086B、`done.wav` 2.142s/189,006B、`ask.wav` **3.187s**/281,166B、`fail.wav` 2.560s/225,870B | 开箱音效 | `scaleWavVolume`；`spawnBeep` 的 `graceMs:3000` |
| `assets/` | `avatar.png`、`social-preview.jpg` | README 展示 | 无运行时耦合 |
| `scripts/` | `verify.mjs` 216 行、`verify-volume.mjs` 152 行、`verify-settings.mjs` 180 行 | 自建离线自检（mock ctx） | 与被测代码同仓，不随包发布 |

### A.4 行为契约（重构不得改变语义）

| # | 契约 | 出处 | 语义要点 | 现状是否成立 |
|---|---|---|---|---|
| BC1 | 四档音效与触发 | `index.mjs:497-529`（plan/done）、`482-490`（ask）、`492-495`（fail）；README 表格 | `plan`=回合结束时 plan mode 仍激活；`done`=同回合有执行类工具（`tool >= turnStart`）；`ask`=`ask_user_question` 工具**或**审批请求；`fail`=root agent 报错 | 成立 |
| BC2 | 静音语义 | `index.mjs:344,519-522` | 纯对话 / 只用查询类工具 → 不响；`volume<=0` → 不响；`enabled=false` → 全程不响 | 成立 |
| BC3 | `execTools` 白名单语义 | `index.mjs:474-480`、`DEFAULT_EXEC_TOOLS:120-137` | 集合判定；**空数组 = 所有工具都算**（legacy）；未知名字静默无效（0.2 工具名是每部署注入的） | 白名单内容错配（见 K6/N1） |
| BC4 | debounce | `index.mjs:144`(`min100/max60000/default2500`)、`339-345` | 每档独立窗口，同档最小间隔 2500ms 默认 | 成立（`force` 绕过，仅桥用） |
| BC5 | 只响主对话 | `index.mjs:280-288`；README | 子代理/后台任务不单独响 | **不成立**（K5） |
| BC6 | 音效查找顺序 | `index.mjs:296-307`；README「配置目录 → 工作区 → 包内自带 → 系统回退」 | 第一个存在者胜出 | 部分不成立（K3：第二档是宿主 cwd 不是工作区） |
| BC7 | 音量缩放语义 | `index.mjs:339-348`；README「不改系统音量」 | `volume`=百分比增益；100 = 原文件；非 PCM/异位深 → 回退原音量；0 = 完全不 spawn | 成立（覆盖范围见 N4） |
| BC8 | 音量持久化与优先级 | `index.mjs:266-278,244-264`；README「设置页值优先，config 为初始值」 | 优先级 = 用户设置 → 运行期值 → config → 100 | **不成立**（K1/K4），退化为 config→100 |
| BC9 | 桥接口形状 | `index.mjs:406-434`；`client.js:28-50` | `GET /state`→`{volume,enabled,debounceMs,persistent,kinds[]}`；`POST /volume {volume:0..100}`；`POST /preview {kind}`；非法值 400，未知路由 404 | 成立（无鉴权，见 K2） |
| BC10 | 设置页契约 | `client.js:286-299` | 一个 `settings.section`（id `perlica-ding`，label「佩丽卡提示音」，order 60）；试听走与真实通知**完全相同**的播放链路 | 成立（依赖私有注册方式） |
| BC11 | 跨平台播放链路 | `index.mjs:349-361` | win32 `Media.SoundPlayer.PlaySync`（PowerShell 优先 + pwsh 降级）/ darwin `afplay` / linux `paplay→aplay` | 成立；但降级只在 spawn 失败时发生（N7） |
| BC12 | 配置键名 | `Config:140-161`；README「高级配置」 | `enabled` / `volume` / `debounceMs` / `soundDir` / `execTools` 是用户已写入 profile 的键 | 必须原样保留 |

---

## B. 缺陷定位

严重度：**S1** = 功能不可用/安全面；**S2** = 行为与文档不符；**S3** = 健壮性/维护性。

### B.1 已知 9 条（复核结论 + 证据）

| ID | 缺陷 | file:line | 严重度 | 触发条件 | 影响 | 建议修法（一行） |
|---|---|---|---|---|---|---|
| K1 | `settings.register` 私有 API 在 0.2 线不存在 | `index.mjs:252-263`（调用）、`460-467`（注入）；容量依据 `dsh-settings/lib/index.js:322` + 实测 `SettingsForms.prototype` = `configure/describe/update/replace/mutate`，**`register === undefined`** | S1 | 插件在 0.2.0-rc.2 上 apply，`ctx.inject(['settings'])` 回调执行 | `volumeScope` 永远为 null → `currentVolume()` 只走 `runtimeVolume`/`cfg.volume`；`/state.persistent=false`；重启即丢 | 删除注册逻辑，改为把 `Config.volume` 标成 `.volatile()`，让宿主 `SettingsForms`（`update(ns,{volume})`）写 profile 配置 |
| K2 | 自建 HTTP 桥无任何鉴权/来源校验 | `index.mjs:389-446`（路由）、`372-386`（`readJsonBody`） | S1 | 本机任意页面/进程访问 `http://127.0.0.1:19387/perlica-ding/api/*`；`readJsonBody` 不看 `Content-Type`，`text/plain`/表单类**简单请求**即可跨站触发 | 任意网页可让用户机器发声（`POST /preview`）、静默改音量（`POST /volume`，响应读不到但副作用成立）；`0.0.0.0` 绑定配置下一并暴露到局域网；宿主 `WebServer`（`dsh-host-webserver/src/index.ts:125-133`）本身不带 Origin/CSRF 校验，该风险由插件自行承担 | 直接删除桥：改用 harness remote（`ctx.remote.settings.mutate` / 客户端 `settings` 命名空间）与 `settings/document-updated` 推送 |
| K3 | `resolveSound` 用 `process.cwd()` 当"工作区" | `index.mjs:299` | S2 | 桌面端宿主进程 `cwd = ~/.dsh/profiles/desktop`（`apps/desktop/src/host-process.ts:189-198` 以 `projectDir` 为 `cwd` spawn），永远不是用户工作区 | 放工作区根目录的自定义 WAV 全部失效、无任何提示，只能听到包内音效 → 与 README「放到工作区根目录」直接矛盾 | 用 `agent.session.header.cwd`（harness 标准工作区来源，见 `tool-fs/src/session-cwd.ts:18`）替换，缺失时才退回 `process.cwd()` |
| K4 | `settings` 缺失只 `console.error` 不重试 | `index.mjs:245-250`、`463-467` | S1 | 启动早期 `ctx.get('settings')` 为 undefined（或服务后续被替换/重载） | 本进程内永久放弃注册：既无重试也无多宿主级错误出口，用户只看到"不持久化" | 用 `ctx.inject(['settings'], child => child.effect(...))` 单一路径，并挂 disposer 支持服务替换 |
| K5 | `agents` 缺失/抛错时 `isRoot` 返回 `true` | `index.mjs:280-288` | S2 | `agents` 服务未就绪（加载早期）或 `roots()` 抛错 | 子代理/后台的 `agent/turn-stopping`、`agent/error` 也被当成主对话 → 子代理单独响，违背 BC5 | 事件里优先用 `payload.agent` 与 root 集合比较，服务不可得时**保守判定为非 root**（宁可不响） |
| K6 | `execTools` 默认白名单与真实工具集错配 | `index.mjs:120-137` | S2 | 0.2 / agent-team 部署 | 见下方 B.1.1 明细：`done` 漏响（`present`、`job_output`、`spawn_teammate`、`team_task_*`）与误响（`create_goal`/`update_goal`）并存；`get_goal` 被漏列但本不该列 | 改为按"执行类"语义列全集（B.1.1），并把 goal/todo 类记账工具排除 |
| K7 | 音量缓存键 `basename + volume + 字节数` | `index.mjs:99-104` | S3 | 同名同字节数的不同源文件/不同源目录同时存在于候选链；或用户替换同名不同内容 WAV 但字节数恰好相同 | `existsSync(dest)` 命中旧缓存 → 播到**别的音频**；缓存还直接读 `cwd`/用户目录，无原子写（读到半截文件） | 键改为内容摘要（`sha256(wavData)` 前若干位）+ volume，写入用临时文件 + `rename`（参考宿主 `dsh-atomic-write`） |
| K8 | 客户端手写注册 + 无 `configure({auto:false})` | `lib/client.js:286-299`；`index.mjs` 无 `configure` | S2 | 一旦 `Config` 出现 volatile 字段（迁移后必然） | `SettingsForms.describe()` 默认 `autoGenerate=true` → 宿主自动生成一张配置页，与手写「佩丽卡提示音」页并存/重复；`SettingsForms.update('volume')` 被拒绝时也无提示 | host 半 `ctx.inject(['settings'], c => c.effect(() => c.settings.configure({auto:false}, ctx.fiber)))`（照抄 `ui-settings/src/index.ts:24`），browser 半只保留自定义页 |
| K9 | `verify` 脚本不在 `files` 白名单 | `package.json:24-33` vs `35` | S3 | 安装副本里跑 `pnpm verify`（实装副本 `C:\Users\INAGN\.dsh\profiles\desktop\node_modules\dsh-perlica-ding` **无 `scripts/` 目录**，已核实） | `node scripts/verify.mjs` → MODULE_NOT_FOUND，用户按 README 自检必失败 | 二选一：把 `"scripts"` 加进 `files`，或（更正确）迁移测试到仓内 `tests/` 并在 CI 跑、不承诺安装副本可 verify |

#### B.1.1 K6 明细：白名单 vs 真实工具名

真实工具名取自 0.2 线注册表（`dsh-client-ui-cordis/src/client/slot-catalog.ts:4079` 的全量 key 集 + 各 `dsh-tool-*/src/*.ts`），含 agent-team 扩展。

| 白名单项 | 真实存在？ | 判定 |
|---|---|---|
| `pwsh` / `bash` | 是（每部署二选一注入） | 保留 |
| `write` / `edit` | 是（`dsh-tool-fs`） | 保留 |
| `subagent` | 是（`toolName` 可配置） | 保留 |
| `subagent_fork` | 是（实装 profile 把 `tool-subagent` 二次注册成 `subagent_fork`） | 保留 |
| `workflow` / `ralph` | 是（可被 profile disabled，如当前实装 profile 禁用 `tool-workflow`/`tool-ralph`） | 保留（名字无害） |
| `job_kill` | 是（`dsh-tool-jobs/src/index.ts:372-376`），但属**控制类**非执行类 | 建议移除，改列 `job_output` |
| `create_goal` / `update_goal` | 是，属 **goal 记账/控制** | 应移除：模型每轮收尾常调 `update_goal`，会把纯对话误判为"任务完成" |
| `todo_write` | 是，属计划记账 | 应移除（README 的"改文件/跑命令/子代理/工作流"不含它） |
| `cordis_define` / `cordis_run` / `cordis_stop` / `cordis_undefine` | 存在（动态插件宿主工具，属重执行类） | 保留，但必须与 `cordis_inspect_list` / `cordis_inspect_query` 区分：后两者是查询类，不得加入 |
| 缺失：`present` | 存在（交付物声明） | **应加入**：只交付文件的一轮现在静音 |
| 缺失：`job_output` | 存在（`dsh-tool-jobs/src/index.ts:311-318`：`wait:true` 可阻塞收取后台任务结果） | **应加入，且优先级最高**：典型长任务 = 启动后台工作 → 后续回合用 `job_output(wait)` 收口，这条路径现在**必定静音**；而白名单里放着的恰恰是控制类的 `job_kill`（同文件 `372-376`） |
| 缺失：`spawn_teammate` / `team_task_create|get|list|update` / `wait_agent` / `send_message` / `interrupt_agent` | 存在（agent-team 线与 subagent 控制） | **应加入**（`list_agents` 保持"查询类"不加） |
| 缺失：`str_replace_editor` | 存在（替代编辑工具） | 建议加入 |
| 缺失：`terminal_open/read/signal/close/list` | 存在（终端执行类） | 建议加入 |
| 缺失：`session_*` / `lsp` / `schedule_*` / `read_image` / `glob` / `grep` / `read` / `web_*` / `skill` / `list_*` | 存在 | 属查询/管理类，**不应**加入 |

### B.2 我继续找出的问题（K 之外）

| ID | 缺陷 | file:line | 严重度 | 证据 / 触发条件 | 影响 | 建议修法（一行） |
|---|---|---|---|---|---|---|
| N1 | 自检脚本用"假的 settings"证明了一个不存在的 API | `scripts/verify-settings.mjs:76-89`（`settings.register(ns,schema,options)` 返回可写 scope） | S2 | 与 K1 的真实 `SettingsForms` 表面直接矛盾；脚本 `apply()` 后 `ctx._settings() !== null` 必然通过 | **测试给了假绿**：K1 这种致命不兼容被自检掩盖，"验证通过"不等于宿主可用 | 换成契约测试：断言 `Config` 中存在 volatile 字段、且写入走 `settings.update(ns,{volume})` |
| N2 | `ask` 完全无 root 判定，且时机早于用户看到问题 | `index.mjs:482-490` | S2 | `tools/execute` / `approval/request` 监听器未调用 `isRoot`；子代理调用 `ask_user_question`、或审批在子上下文发起都会响 | 与 BC5「只响主对话」矛盾；子代理提问刷屏；审批场景在**请求时**响而非用户需要决策的界面态 | 加 `isRoot(exec.agent)` / 用 `approval/request` 的 `req.agent` 判定 |
| N3 | 回合判定用墙钟时间戳比较 | `index.mjs:469-480,519-521` | S3 | `turnStart`/`lastTool` 存 `Date.now()`，跨回合/steering/同一 agent 并发回合时相互覆盖与串味 | 极端时序（回合 A 未收尾、回合 B 已 claim）会把 A 的工具算给 B，或漏响 `done` | 以 `turn` 号（事件载荷已带 `turn`，见 `agent/turn-stopping(turn)`）比较，替代时间戳 |
| N4 | `planMode` 存在但抛错时不做事件折叠 | `index.mjs:504-514`（`if/else`） | S3 | 服务在被调用瞬间 reload/失活时 `planMode.get()` 抛错 → 被 `catch` 吞掉，`active` 保持 `false`，**不会**走 `foldPlanModeFromEvents` 兜底 | 计划模式回合会误响 `done` 而非 `plan` | 改为 `if (planMode) { try {...} catch {} }` 之后**总是**在未取到状态时折叠事件 |
| N5 | `graceMs:3000` 与音频时长关系未被记录 | `index.mjs:320`；`sounds/` 实测 | S3 | `ask.wav` 3.187s / `fail.wav` 2.560s（自测解析 WAV 头得到）；0.2 `graceMs` 只界定"退出后的管道排空等待"，不是播放上限（`dsh-subprocess-local/src/spawn.ts:367,414`） | 当前无截断；但若日后把 `graceMs` 当成 play 超时，或换更长的 TTS，会出现"声音被吃掉"且无日志 | 在代码注释里写死"graceMs 只约束进程排空"，并让 `sounds/` 时长上限成为打包约束（≤ 3s） |
| N6 | 依赖全局 `btoa` 且未声明 engines | `index.mjs:195-202`；`package.json`（无 `engines`） | S3 | `btoa` 自 Node 16 才成为全局；包与宿主都没声明下限 | 老 Node 上 `utf16leToBase64` 直接 `ReferenceError`，播放全灭 | 补 `"engines": { "node": ">=18" }`，或用 `Buffer.from(bytes,'latin1').toString('base64')`（Node 侧更自然） |
| N7 | 播放降级链实际上几乎不会触发 | `index.mjs:309-333` | S3 | `handle.done` 只在 spawn/提供方失败时 reject，非零退出码**正常 resolve**（`dsh-subprocess/src/types.ts:180-181`）；`catch` 里 `console.error` 又把原因写进宿主 stderr 而非用户可见处 | `powershell.exe` 存在但播放失败（如 WAV 损坏）时不会尝试 `pwsh.exe`；非零退出静默 | 以 `done.then(o => o.exitCode !== 0 && tryNext())` 判定，而不是只 catch |
| N8 | HTTP handler 未处理连接已关闭/头已发送 | `index.mjs:399-438` | S3 | `send()` 里 `writeHead/end` 无 `res.headersSent`、无 `res.on('close')`、无 try（外层 `try` 在 await 之后无法回滚已发送响应） | 客户端中断时可能抛未捕获异常/产生无意义 500 分支 | 删除桥即彻底消除；若保留则先 `if (res.headersSent) return` 并监听 `close` |
| N9 | 所有日志走 `console.error` | `index.mjs:107,248,262,323,328,392,442,444,456,466,524` | S3 | 0.2 线其它包统一用 `ctx.logger.warn/info`（`dsh-plan-mode/src/index.ts:208` 等）；仓库 commit `142c17b` 还把 `[dsh-perlica-ding]` 方括号风格对齐了 DSH 约定 | 例行信息污染宿主错误输出，用户/诊断把正常注册当故障 | 迁移时改用 `ctx.logger` 分级；注册成功用 `info`、失败用 `warn` |
| N10 | 桥注册可能重复（幂等守卫不完整） | `index.mjs:388-394,450-457` | S3 | `bridgeRegistered` 只在成功路径末尾置真；若 `webServer` 服务被替换后重新注入，回调再次进入时守卫已为真（安全），但守卫设置前若有并发注入路径，会出现同 prefix 二次 `register`（宿主 `WebServer` 对同名 prefix 不做拒绝，`dsh-host-webserver/src/index.ts:166-180`） | 重复 handler → 同一请求被两个 handler 处理，重复播放/重复写 | 删除桥；或改为 `host.effect(() => webServer.register(...))` 由 fiber 生命周期托管并返回 disposer |
| N11 | 无浏览器客户端时仍常驻暴露 HTTP 面 | `index.mjs:450-457` | S3 | 仅 host facet 的部署（npm `0.1.0` 形态、headless）也会注册 `/perlica-ding/api` | 一份纯本地通知插件凭空多出 3 个未鉴权写接口 | 只在 client facet 存在时注册，或（更优）删除桥改用宿主 remote 通道 |
| N12 | `soundDir` 无路径约束 | `index.mjs:149,298` | S3 | `soundDir` 可指向任意绝对路径（配置层可控），解析结果只做 `existsSync` | 变成"播放任意本地 wav"原语；配合 K2 可被本机页面驱动播放任意文件 | 迁移后用工作区 containment 校验（宿主 `resolveWorkspacePath` 语义），或明确限定为工作区相对路径 |
| N13 | `resolveSound` 找不到时返回不存在的 `candidates[0]` | `index.mjs:306` | S3 | 四个候选全不存在（如非 win32 且无 `soundDir`）→ 返回 `cfg.soundDir/kind.wav` 或 cwd 合成路径 | 调用方无法区分"找到了"和"尽力而为"：mac/linux 分支会先对不存在的路径 spawn 一次、失败后才走降级；失败原因只进 stderr | 返回 `null` 让 `play` 静默放弃，或显式返回 `{path, exists}` |
| N14 | `scaleWavVolume` 静默放弃 24/32bit 与 IEEE float | `index.mjs:78,96-98` | S3 | 只处理 `audioFormat===1` 且 8/16bit；`24bit`、`float32`（`fmt=3`）原样播 | 用户用专业 TTS 导出的 24bit/float WAV 时"音量旋钮无效"，README 只说"罕见非 PCM" | 打包/文档前置校验（拒绝或提示转码），或在迁移时对 int24/float32 做缩放 |
| N15 | 缓存写入非原子、命中判断在写入前 | `index.mjs:100-109` | S3 | `existsSync(dest)` → 若不存在则 `writeFileSync`；并发两次播放或写入中被打断会留下半截 `dest`，之后永久命中坏文件 | 该音量档位永久放不出声音（或爆音），只能手工清 `%TEMP%` | 临时文件 + `rename`（宿主有 `dsh-atomic-write` 可参照） |
| N16 | `readJsonBody` 拼串的性能与静默截断 | `index.mjs:374-377` | S3 | 逐 chunk `data += chunk`，超 65536 才 `slice`（每次 data 事件都再切一次）；截断后 `JSON.parse` 失败吞成 `{}` | 大 body 变成 O(n) 次字符串拷贝；调用方无法得知"被截断了"（200 与 400 都可能因 `{}` 产生） | 删除桥；或改 `Buffer.concat` + 显式 413 |
| N17 | 客户端把"非 JSON"一律解释成"路由未就绪" | `lib/client.js:35-40` | S3 | 任何非 JSON 响应（500 HTML、代理页、405）都会给出"请重启 DSH 后再试" | 误导性用户指引，延长 K1 之外的问题排查时间 | 迁移到宿主 remote/`settings` 通道后自然消失；否则按 `status` 分类提示 |
| N18 | 客户端自建 5×2s 重试轮询 | `lib/client.js:135-167` | S3 | 为解决"路由晚于页面挂载"而做的轮询 | 迁移后应由 `settings/document-updated` 推送替代轮询（宿主已提供该事件，见 `dsh-settings/src/types.ts:66-76`） | 删轮询，改订阅推送 |
| N19 | `verify-volume.mjs` 改写 `process.platform` | `scripts/verify-volume.mjs:81` | S3 | `Object.defineProperty(process,'platform',{value:'win32'})` 且后续用例不恢复（同进程内第 2 个用例 `apply` 前未重置） | 在部分 Node 版本上是可写性依赖；测试间互相污染，本地通过≠CI 通过 | 把平台作为可注入参数（`play` 依赖注入）而不是改全局 |
| N20 | 子代理/团队工具族完全不在契约里 | `index.mjs:120-137` | S3 | 与 K6 同源；README 的"执行类工具"描述停留在 0.1 线词汇 | 迁移后若 agent-team 线成为默认，`done` 大面积漏响 | 白名单改为"显式排除查询类"的补集策略，或按工具元数据（是否有副作用）分类 |
| N21 | `dsh.client.inject` 声明了一个根本不存在的客户端模块行 | `package.json:17-22`（`inject:["@deepseek-ai/dsh-client-ui-slots"]`） | S3 | 实测 `@deepseek-ai/dsh-client-ui-slots` 的 `exports` 无 `./client`、**无 `dsh.client`**（它是库而非浏览器模块行，`Q:\PROJ\deepseek-harness\packages\client\ui-slots\package.json`）；同族真正可注入的模块都自带 `dsh.client`（如 `ui-settings` → `{inject:["@deepseek-ai/dsh-api-remotes"],platform:"web"}`） | 图序里插了一条不存在的依赖行（宿主对"未声明 client 的包"走 "permanently not a client row" 分支，不报错），声明与真实需求不符：客户端真正依赖的是 `events` 派生的 `slots` service，而不是该模块 | 删除该 `inject`，或改成真实被 `require()` 的模块；依赖应以"是否被客户端 `require`"为判据（`dsh-client-modules/README.md:46`） |

---

## C. 迁移映射（→ dsh-std）

dsh-std 词汇基线：`@dsh-std/manifest@0.1.1-rc.3`（`dsh-plugin.json` 静态声明 component + facets）、`@dsh-std/storage@0.1.1-rc.1`（`storage.dsh/v1alpha1 LocalStorage`：`get/set/delete` + 可选 `presence`/`list`）、`@dsh-std/ui-browser@0.1.1-rc.1`（`browser.ui.dsh/v1alpha1`：`LocalModule` facet + `SettingsSection` surface）。

### C.1 契约 → 落点

| 契约 | dsh-std 落点 | 说明 |
|---|---|---|
| BC1 四档触发 | `host` facet：订阅 messages/agent 生命周期（`messages.dsh/v1alpha1 MessageObserver` + agent 生命周期），把「回合收尾判定」做成一个**深模块**（对外只暴露 `observe(turn) -> kind \| null`），四档判定、plan 折叠、exec 判定全部藏在实现里 | 现在的 6 个事件监听 + 3 个 Map 是浅接口摊在 `apply` 里，`deletion test` 失败：删掉它复杂度会散到每个调用点 |
| BC2 静音语义 | 深模块的输出契约：返回 `null` 即静音；`enabled`/`volume==0` 在播放 adapter 内处理 | 让"为什么不响"可在一处验证 |
| BC3 execTools 语义 | `host` facet 内部策略模块（默认白名单 + 允许从配置覆盖，空数组=全放行）；工具身份来自与 harness 的**一次**映射（adapter-dsh 侧），不散落在插件里 | 见 K6：这份表要变成"执行类语义"而不是"0.1 的名字快照" |
| BC4 debounce | 播放 adapter 内部状态（每档一个窗口）；不落存储、不跨进程 | 与 BC7 一起是"播放器"深模块的接口选项 |
| BC5 只响主对话 | `host` facet 用 session 归属判定（root/parent 关系），而**不是**"服务不可得就放行" | 对应 K5/N2 |
| BC6 查找顺序 | `@dsh-std/workspace@0.1.1-rc.1 WorkspaceCatalog` 解析会话工作区，作为顺序第 2 档；包内 `sounds/` 仍是第 3 档（资源随 component 走） | 对应 K3/N12/N13；"工作区相对路径"由此获得权威定义 |
| BC7 音量缩放 | 播放 adapter 内部（保留纯 JS PCM 缩放 + 内容摘要缓存键） | 对应 K7/N14/N15；缩放算法可原样搬运，只换缓存键与写盘方式 |
| BC8 音量持久化 | 见 C.2 双通道决策 | 对应 K1/K4/K8 |
| BC9 桥接口 | **删除**：`GET /state` → `settings`/descriptor 读取；`POST /volume` → `settings.update`；`POST /preview` → browser facet 直接向 host facet 发一次"试听"调用（经宿主通道，不再是匿名 HTTP） | 对应 K2/N8/N11/N16 |
| BC10 设置页 | `browser.ui.dsh/v1alpha1 LocalModule` 声明 + `SettingsSection`（`{label, order}`）surface；component 不得把产品 service 名写进 manifest（`ui-browser.zh.md:77`） | 对应 K8/N17/N18；当前 `settings.section`+`ctx.slots` 是产品槽位私有 API |
| BC11 平台播放链路 | `host` facet 的播放 adapter，走 harness subprocess seam（保持现有三条 argv） | 对应 N7/N5 |
| BC12 配置键名 | component manifest 的静态配置声明 + 迁移读取器 | 见 D.1，必须无损读懂既有 profile 的 `volume/debounceMs/soundDir/execTools/enabled` |

### C.2 音量：双通道决策（必须在 T4 前定稿）

- **通道 A（迁移期权威，保留）**：`Config.volume` 加 `.volatile()`，写入落 profile 配置。依据：`ui-settings` 的宿主半就是 `enabled: DeveloperToolsSettingsFields['enabled'].volatile()` + `configure({auto:false})`（`Q:\PROJ\deepseek-harness\packages\client\ui-settings\src\index.ts:16-24`），且 `SettingsForms.update` 只接受 volatile 字段（`settings/src/index.ts:347-389`，非 volatile 抛 `no volatile fields` / `not volatile`）。好处：**零迁移**，用户已写在 `cordis.yml`/patch 里的 `volume` 立刻变成可写值。
- **通道 B（dsh-std 形态，目标）**：`storage.dsh/v1alpha1 LocalStorage`，key 固定 `volume`（可选 `volume.presence`/`list` 不必要）。依据：`storage.zh.md:31-37` 明确 provider 按 component 分配隔离命名空间，插件**不得**自行指定他人命名空间，key 无路径语义。
- **决策**：A 为读优先源、B 为写归属；两者用一个 10 行 adapter 包住（`readVolume() -> number`、`writeVolume(v)`），并规定"B 存在则优先，B 缺 key 时把 A 的值回填 B"。若 T4 决定只保留 B，则必须保留"读 A"一次以完成迁移 —— 否则老用户音量被静默重置为 100，属于用户可见的回归。

### C.3 重构必须保留的文件/资源

| 保留物 | 理由 |
|---|---|
| `sounds/plan.wav`、`done.wav`、`ask.wav`、`fail.wav` | 开箱音效与佩丽卡语音是产品本体；`ask.wav` 3.187s 需继续满足时长约束（N5） |
| `assets/avatar.png`、`assets/social-preview.jpg` | README/商店展示资源，与运行期无关但对外可见 |
| `cordis.patch.yml`（或等价的 dsh-std 组合声明） | 当前装载机制；即使迁到 dsh-std manifest，也仍需一个可被现有宿主识别的组合层（见 C.4） |
| README 中「四档表格」「查找顺序」「自定义音效要求（真 WAV/PCM）」三段 | 是用户可见契约，改写时必须与新行为逐条对齐 |
| `Config` 的 5 个键名（BC12） | 用户 profile 已写入这些键 |
| 平台播放的 OS 兜底音效表（`SYSTEM_SOUNDS`） | 非 Windows/无包内文件时的最后可用性；是 BC6 的第 4 档 |

### C.4 重构后应当删除的东西（含判断依据）

| 删除项 | 判断依据 |
|---|---|
| 自建 HTTP 桥（`index.mjs:372-446,450-457`）+ `lib/client.js` 的 `request()` 与轮询重试 | `deletion test`：删掉后复杂度不回流到任何调用者（宿主已提供 `settings`/remote 通道与 `settings/document-updated` 推送），但安全面（K2/N8/N11/N16）整体消失 —— 典型的"删掉即净收益" |
| `registerVolumeSettings` / `volumeScope` / `runtimeVolume` 三件套（`index.mjs:237-278`） | 建立在 0.2 不存在的 `settings.register` 之上（K1）；对应能力由 volatile Config + `settings.update` 替代 |
| `readJsonBody`、`KINDS` 作为 API 白名单的那一半用途 | 只有桥在用；四档枚举本身保留在播放模块内部 |
| `scripts/verify-*.mjs` 旧断言（K1 假绿来源） | 用契约测试替换（N1）；`files` 白名单问题（K9）随之消失 |
| `package.json` 的 `dsh.client.inject`（若迁到 dsh-std manifest，由 `LocalModule.requirements` 表达） | `ui-browser.zh.md:29-38`：client facet 的协议要求写在 facet 自己的 `requirements` 里，不合并 host 的；且当前值本身是假的（N21） |
| `bundle` 入口 | **保留**，依据：`dsh.bundle.patch` 是 0.2 线装载外部 bundle 的正式机制（`boot/app-boot/src/profile.ts:8-11`、`plugin-manager` 走 `bundlePatchPaths`），删掉等于放弃即刻可用性；迁移应保留它作为"旧宿主兼容层"，而不是删除 |

---

## D. 风险清单

| # | 风险 | 触发方式 | 后果 | 缓解 |
|---|---|---|---|---|
| D1 | 配置键名/来源漂移 | 迁移把音量改存 dsh-std storage 却不读旧 `volume` | 老用户音量静默重置；与 README「高级配置」矛盾 | C.2 的 adapter + 一次回填；`volume/debounceMs/soundDir/execTools/enabled` 五个键名冻结 |
| D2 | `soundDir` 语义变化 | K3 修好工作区解析后，用户原来靠 `process.cwd()`（=profile 目录）意外命中的文件不再命中 | 极小概率的"以前能响、以后不响" | 迁移说明里显式写出解析顺序变更；保留 `soundDir` 绝对路径能力 |
| D3 | 已有缓存目录残留 | 旧键 `basename-v{vol}-{bytes}.wav` 与新内容摘要键并存于 `%TEMP%\dsh-perlica-ding` | 换键后旧文件变孤儿（不占空间但永久残留）；若沿用同名键则读到旧内容 | 换键**同时**改缓存目录（如 `dsh-perlica-ding-v2`），或在启动时清理旧前缀 |
| D4 | 已发布 `npm dsh-perlica-ding@0.1.0` 的兼容面 | 由 `npm view` 实测：0.1.0 只有 host 半（`exports` 无 `./client`、`dsh` 无 `client`、`files` 为空、`scripts.verify` 指向不存在的脚本） | 任何新包的 `dsh.client` 声明对 0.1.0 装机是新增面；不能假设"所有装机都有浏览器客户端" | 保留 host-only 可用路径（N11）；dsh.client 声明为可选，缺失时只降级不报错 |
| D5 | 测试替身与真实 API 分叉 | 迁移后仍用 mock ctx（如现有 `verify-*.mjs`） | K1 那类"假绿"复发；重构引入的新不兼容同样测不出来 | 契约测试对齐真实 `SettingsForms`/`storage` 表面；至少一条 E2E 走真插件加载 |
| D6 | plan 判定依赖 session 事件内部形状 | `foldPlanModeFromEvents` 读 `agent.session.events` + `plan/mode`（`index.mjs:209-219,511-513`） | session 格式演进时静默失效（被 catch 吞掉）→ 计划回合误响 `done` | 迁移到显式的 agent/plan 状态来源；保留一条"服务可得时绝不折叠"的断言（并修 N4） |
| D7 | 音效时长与超时/排空参数耦合 | 换更长 TTS 或把 `graceMs` 当真超时用 | 声音被截断且无日志（N5/N7） | 注释 + 打包约束（`sounds/*.wav ≤ 3s`）+ 启动自检打印时长 |
| D8 | 无鉴权面在迁移前仍在线 | 迁移未落地前，`/perlica-ding/api` 仍可被本机任意页面驱动（K2） | 演示/录屏环境被任意网页"叮"或静音 | 若迁移期需要止血：仅 127.0.0.1 绑定 + 校验 `Origin`/`Sec-Fetch-Site` 属于同一 shell（不构成永久方案） |

---

## E. 未解决项 / 待 T4 决策

1. **C.2 双通道 vs 单通道**：storage.dsh 是否作为唯一权威？我给出的最小风险解是"读 A 写 B + 一次回填"，但最终归属需要 T4 明确（涉及 dsh-std 是否已有 LocalStorage provider 实装）。
2. **`enabled` 是否也 volatile**：当前非 volatile ⇒ 迁移后设置页无法实时开关（只能改配置 + 重启）。我倾向保持非 volatile（README 未承诺实时生效），但需与 T4 对齐。
3. **N3 的 `turn` 号是否在 messages 观测通道可得**：`agent/turn-stopping` 载荷带 `turn`（`dsh-agent/src/runtime-types.ts:381`），但 dsh-std 的 `MessageObserver` 是否携带回合号未核实 —— 决定"时间戳 vs 回合号"改造能否落到目标形态。
4. **`SYSTEM_SOUNDS` 在 dsh-std 形态的归属**：属于 host facet 的实现细节还是配置？未定。
5. **N14（24bit/float WAV）**：是补实现还是明确拒绝+提示？需要产品口径（会不会有人用专业 TTS 导出）。

## F. 本次取证的复现命令（只读）

```powershell
# K1：证明 0.2 的 ctx.settings 没有 register
node -e "const S='Q:/PROJ/deepseek-harness/packages/settings/settings/lib/index.js';import(S).then(m=>{const F=m.SettingsForms;console.log(Object.getOwnPropertyNames(F.prototype).join(','))})"
# 输出：constructor,importLegacyDocument,configure,invalidate,writable,documentPath,prepareDocument,describe,update,replace,mutate,write,schema

# K9：证明安装副本没有 scripts/
Get-ChildItem 'C:\Users\INAGN\.dsh\profiles\desktop\node_modules\dsh-perlica-ding' -Recurse -Depth 1 | Select-Object -ExpandProperty FullName

# K3：桌面宿主子进程 cwd = profile 目录
Select-String -Path 'Q:\PROJ\deepseek-harness\apps\desktop\src\host-process.ts' -Pattern 'cwd: this.projectDir'

# N5：包内音频时长（自测 WAV 头）
node -e "const b=require('fs').readFileSync('sounds/ask.wav');const r=b.readUInt32LE(24);let o=12,s=-1;while(o+8<=b.length){const id=b.toString('ascii',o,o+4),z=b.readUInt32LE(o+4);if(id==='data'){s=b.readUInt32LE(o+4);break}o+=8+z+(z%2)}console.log((s/2/r).toFixed(3)+'s')"
```

## G. 结论

- **唯一必须外部修的根本原因**：K1（`settings.register` 不存在）+ K4（不重试）+ K8（无 volatile 字段/无 `configure({auto:false})`）三者构成"0.2 线无任何可写通道"。其余 8 条已知缺陷与 21 条新发现都可在同一轮迁移里顺手消除，其中 K2/N8/N10/N11/N16/N17/N18 会被"删除自建 HTTP 桥"一次性带走。
- **最容易被忽略的功能缺口**：`job_output`（N6 同级）—— 0.2 线把"后台启动 + 后续回合收口"当主流用法（`dsh-tool-jobs/src/index.ts:125-126,253` 直接把 `job_output` 写进系统提示），而白名单收了控制类的 `job_kill`、漏了执行/收口类的 `job_output`，长任务的收尾回合会**稳定静音**。
- **最高性价比的动作**：先把"四档判定 + 播放"抽成一个深模块（BC1/BC2/BC3/BC4/BC5），再把音量持久化换成 volatile Config（通道 A）。这两步不动音频资源、不动配置键名，风险最低。
- **不可逆项**：配置键名、`sounds/` 资源、`npm 0.1.0` 的 host-only 装机面，三者都必须无损保留。
