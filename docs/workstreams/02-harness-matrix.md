# 02 — Harness 契约矩阵（0.1.5-rc.2 / 0.2.0-rc.2 / 0.2.1-alpha.1）

> 取证工作流 T2。**只读取证**，不改任何代码、不碰远端、不碰用户 profile 写入。
> 每格标注「存在 / 形状 / 证据」；证据 = 命令 + 可复现产物路径，或 live Inspect 查询。

- 日期锚点：`dsh-base` 0.1.5-rc.2 = 2026-09-10，0.2.0-rc.2 = 2026-09-29，0.2.1-alpha.1 = 2026-10-03（`npm view @deepseek-ai/dsh-base time`）。
- 本机载体：`DSH_PROFILE=desktop`、`DSH_PROFILE_DIR=C:\Users\INAGN\.dsh\profiles\desktop`、`DSH_HOME=C:\Users\INAGN\.dsh`、`DSH_WEB_URL=http://127.0.0.1:19387`。
- 桌面运行时真身：`Q:\DeepSeek Harness\resources\app.asar` → `dsh/node_modules/@deepseek-ai/dsh-settings` **version = 0.2.0-rc.2**（`asar-tool.mjs --cat`）；其 `lib/index.js` 导出 `SettingsForms`，**无 `register`**。
- 三线源码落盘：`%TEMP%\dsh-matrix\{0.1.5-rc.2,0.2.0-rc.2,0.2.1-alpha.1}\x-<pkg>\package\`（`npm pack` + `tar -xzf`）。

## 0. 三线是什么（组合层，不是版本号比较）

| | 0.1.5-rc.2 | 0.2.0-rc.2 | 0.2.1-alpha.1 |
|---|---|---|---|
| `@deepseek-ai/cordis` peer | `^4.0.2` | `~4.0.4` | `~4.0.5-alpha.1` |
| `@deepseek-ai/schemastery` peer | `^3.18.2` | `~3.18.4` | `~3.18.5-alpha.1` |
| `dsh-base` 的 `settings` row | `@deepseek-ai/dsh-settings-file` | `@deepseek-ai/dsh-settings` | `@deepseek-ai/dsh-settings` |
| `dsh-base` 的 `hmr` row | `@deepseek-ai/cordis-plugin-hmr@^1.0.17`（默认 `disabled: true`） | `@deepseek-ai/dsh-hmr`，`disabled: !!js "!ctx.get('profileContext')"` | 同 0.2.0-rc.2 |
| `dsh-base` 是否有 `config-editor` row | **无** | 有（`@deepseek-ai/dsh-config-editor`） | 有 |
| `dsh-base` 是否有 `profileContext` 门控 | **无** | 有 | 有 |

**决定性发现：`0.2.0-rc.2` 与 `0.2.1-alpha.1` 的 `dsh-base/cordis.patch.yml` 逐行 diff 为空**（19615B → 20780B 的差异全部发生在 0.1.5 → 0.2.0 这一步）。

```
Compare-Object (0.2.0-rc.2 cordis.patch.yml) (0.2.1-alpha.1 cordis.patch.yml)  →  无输出
```

含义：**0.2.0-rc.2 与 0.2.1-alpha.1 对插件而言是同一个组合面**；`dsh-settings` 的 `lib/index.js`（22636B，sha `9432B872597B7A31`）与 `lib/types/index.d.ts`（5152B，sha `90B021295CC5D453`）在两条 0.2 线上**字节相同**。真正的断崖只有一条：**0.1.5 线 → 0.2 线**。

---

## 1. `ctx.settings`

| 维度 | 0.1.5-rc.2 | 0.2.0-rc.2 | 0.2.1-alpha.1 |
|---|---|---|---|
| 服务键 | `settings` | `settings` | `settings` |
| 存在 | ✅ | ✅ | ✅ |
| 形状 | `abstract class SettingsProvider extends Service`（`dsh-settings` 抽象 seam；实体提供者 = `dsh-settings-file` 的 `FileSettingsProvider`） | `class SettingsForms extends Service`（`dsh-settings` 自身即实体插件） | 同 0.2.0-rc.2（字节同） |
| 方法集合 | `register(ns, schema, {base, applies, validate})`、`installSection(owner, ns, schema, entry, hooks)`、`describe(opts)`、`get(ns)`、`update(ns, patch, expectedRevision?)`、`replace(ns, section, expectedRevision?)`、`mutate(ns, ops, expectedRevision?)`、`get documentPath`、`prepareDocument()`、`protected publish(doc, source?)`、`[Service.init]()` | `configure({auto?}, owner?)`、`get writable`、`get documentPath`、`prepareDocument()`、`describe(opts)`、`update(ns, patch, expectedRevision?)`、`replace(ns, section, expectedRevision?)`、`mutate(ns, ops, expectedRevision?)` | 同 0.2.0-rc.2 |
| **有 `register` 吗** | **有** | **无** | **无** |
| `ns` 语义 | **命名空间**。由插件自选，必须匹配 `/^[a-z][a-z0-9-]*$/`，重复注册 `throw`「already registered」。值 = schema defaults → 注册者 composition `base` → user section 三层解析 | **条目 Config**。`ns` = **profile entry 的 patch id**，插件**不能自选**；`describe()` 返回 `ns: entry.options.id`，`update/replace/mutate` 用 `configEditor.entries().find(row => row.options.id === ns)` 反查 | 同 0.2.0-rc.2 |
| 语义定位 | 「插件自有设置命名空间 + owner scope + watch 观察者」 | 「把 Loader 条目的 Config schema 投影成表单，并持有可选的实例级 UI 策略」 | 同 |
| 落盘位置 | `@deepseek-ai/dsh-settings-file` → **`$DSH_HOME/settings.yaml`**（`Config.path` / `Config.dshHome` 可改；`documentPath` 暴露绝对路径）。注释保留的 leaf-level diff 写回，跨进程写锁 | **无独立设置文档** → 写进 **active profile patch**，`SettingsForms.documentPath` 直接返回 `ownerContext.configEditor.documentPath`（即 `C:\Users\INAGN\.dsh\profiles\<profile>\cordis.patch.yml`） | 同 0.2.0-rc.2 |
| 硬依赖 | 无（`SettingsProvider` 自足） | `static inject = ["configEditor", "profileContext"]` | 同 |
| 冲突语义 | `SettingsConflictError`（`code = "SETTINGS_CONFLICT"`，`expected` / `actual`）—— **三线都存在，签名一致** | 同 | 同 |

证据：
- `%TEMP%\dsh-matrix\0.1.5-rc.2\x-dsh-settings\package\lib\types\index.d.ts:157,216,228,236-282`（`SettingsProvider` + `register` 签名）
- `%TEMP%\dsh-matrix\0.2.0-rc.2\x-dsh-settings\package\lib\types\index.d.ts:62-117`（`SettingsForms`，无 `register`）
- `0.2.0-rc.2\x-dsh-settings\package\lib\index.js`：`static inject = ["configEditor", "profileContext"];` / `ns: entry.options.id` / `this.ownerContext.configEditor.entries().find((row) => row.options.id === ns)`
- `0.1.5-rc.2\x-dsh-settings\package\lib\index.js`：`const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/;` + `register(ns, schema, options)` 内 `parseSettingsNamespace(ns)`
- live：`cordis_inspect_query(platform=host, provider=Service, method=listService, input={service:"settings"})` → 6 个方法，`update/replace/mutate` 的 `ns` 参数说明逐字为 **"Profile entry id."**；返回值为 `"Forms keyed by unique profile entry ids."`
- live：`Config.listConfigs`（offset 160）→ `{ id: "include:dsh-perlica-ding", patchId: "dsh-perlica-ding", name: "dsh-perlica-ding", status: "schema" }`。**`ns` = `dsh-perlica-ding`**，不是包名、不是自定义命名空间。
- 本机 `Test-Path C:\Users\INAGN\.dsh\settings.yaml` = **False**（0.1.5 时代的文档本机确实不存在）。

**这正是已确诊 bug 的根**：插件 `index.mjs:252` 调 `settingsService.register(ns, z.object({volume}), {base, applies:'live'})`，在 0.2.0-rc.2 上 `SettingsForms` 无 `register` → `TypeError`，被 `index.mjs:261-263` 的 try/catch 吞掉并 `console.error` → `volumeScope` 恒为 `null` → 音量退回 `cfg.volume`（内存）→ `registerBridge` 上报 `persistent: false`。

---

## 2. `ctx.storage` / `ctx.storageDomain` / `storage-json`

**这是三线唯一「字节级同构」的持久化面**——`lib` 目录逐文件 sha256 在 0.1.5-rc.2 与 0.2.0-rc.2 完全一致。

| 维度 | 0.1.5-rc.2 | 0.2.0-rc.2 | 0.2.1-alpha.1 |
|---|---|---|---|
| `ctx.storage` | ✅ `class Storage extends Service`：`readonly backend: BackendRegistry`、`mount(form, facility)`、`form(form)`、`get domain` | 同 | 同（`index.js` sha `1289574C24EC` 三线相同） |
| `ctx.storageDomain` | ✅ `class DomainFacility`：`open<S extends DomainSpec>(spec): Promise<Domain<S>>`、`get(name)`、`closeAll()` | 同 | 同（仅移除 `./invariant` 子路径导出：`invariant.js` / `invariant.d.ts` 在 alpha.1 消失） |
| `storage-json` | ✅ `class JsonStorageBackend implements StorageBackend`，`Config.root` | 同 | 同 |
| 落盘位置 | `dsh-base` row：`storage-json.config.root = !!js dshHomePath('storages')`；`storage-domain.config.backend = json` | 同 | 同 |
| 本机可见 | `C:\Users\INAGN\.dsh\storages\workspace.json`（8161B, 2026/10/7 09:07）+ `C:\Users\INAGN\.dsh\storages\session_projcache\`（目录） | 同 | 同 |
| 插件能直接用来存 KV 吗 | **能，且是三线唯一安全面**。见下 | 同 | 同 |

两条可用路径（都在三线成立）：

1. **推荐（语义层）**：`ctx.storageDomain.open(defineDomain({ name, version, tables: { t: { valueSchema: <zod> } }, global?: { schema, initial } }))` → 返回 `Domain<S>` handle。`Domain.close()` **由调用方负责**（facility 不把 domain 绑到任何 consumer fiber）。
   - record schema 是 **zod**（`ZodType`），**不是** schemastery —— 与插件 `Config` 的 schema 体系分离（`spec.d.ts` 头注释明写这条 split）。
   - `name` / table 名必须匹配 `UNIT_NAME_RE`；`layout: 'single' | 'per-record'`；`compatibleVersions` 支持旧版本读；`invalidRecords: 'backup-and-skip'` 可让坏记录备份跳过而不是整体开失败。
2. **低层（需要自定义 form 时）**：`ctx.storage.mount('<formName>', facility)` 走 `StorageForms` declaration merging（domain 层就是这么挂 `domain: DomainFacility` 的）；或直接 `ctx.storage.backend` 注册表 + `StorageBackend.kv.open(KvUnitDescriptor)` → `KvUnit{ loadAll, putRecord, deleteRecord, backupRecord?, setGlobal, close }`。**hub 自身不做 IO**，`KvUnit` 不序列化并发写（写序是调用方责任）。

证据：
- `%TEMP%\dsh-matrix\{0.1.5-rc.2,0.2.0-rc.2,0.2.1-alpha.1}\x-dsh-storage\package\lib\*` 逐文件 `Get-FileHash` → `index.js=1289574C24EC backend.d.ts=94A444E3CD24 error.d.ts=F49B7B7028B3 index.d.ts=C15111D5F10E registry.d.ts=0BDC63F1AEA1` 三线全同。
- `0.2.0-rc.2\x-dsh-storage-domain\package\lib\types\index.d.ts:20-98`（`StorageForms { domain: DomainFacility }` 合并 + `DomainFacility.open` 生命周期注释）
- `0.2.0-rc.2\x-dsh-storage-domain\package\lib\types\spec.d.ts:24-60`（`DomainTableSpec` 用 zod；`layout`；`compatibleVersions`；`invalid-record` 策略）
- `0.2.0-rc.2\x-dsh-storage\package\lib\types\backend.d.ts:38-130`（`KvFacet.open` / `KvUnit` 完整成员与并发/持久化保证）
- live：`Service.listService` catalog 含 `storage`（`backend` / `mount` / `form`）与 `storageDomain`（`open` / `get` / `closeAll`）。
- 三线 base patch 均含 `storage` / `storage-json` / `storage-domain` 三行（0.1.5-rc.2 dump 第 ~150 行）。

---

## 3. `webServer.register`

| | 0.1.5-rc.2 | 0.2.0-rc.2 | 0.2.1-alpha.1 |
|---|---|---|---|
| 存在 | ✅ | ✅ | ✅ |
| 形状 | `class WebServer extends Service`；`WebRoute { kind: 'exact'\|'prefix'; path: string; handler(req, res): void \| Promise<void> }`；`register(route) → () => void`（disposer） | 同 | 同 |
| 其余成员 | `registerUpgrade(WebUpgradeRoute)`、`registerFallback(handler)`、`tapIndex(transform)`、`applyIndexTaps(html)`、`collectIndexInjections()`、`renderIndex(html)`、`get port` / `get host`、`Config{host,port,compression?,compressionLevel?,compressionThresholdBytes?}` | 同 | 同 |
| 事件 | `webserver/index-inject(table: IndexInjection[])`（`@mode emit`） | 同 | 同 |

证据：`x-dsh-host-webserver\package\lib\types\index.d.ts` sha256 前缀 **`342D45C37BFA` 三线完全相同**（`injections.d.ts` 在 0.1.5→0.2.0 有 5 字节差，`index.js` 有实现差，但契约面字节同）；live catalog 里 `webServer` 在列。

**重要限定**：包头注释明写 —— *"Electron uses file:// plus IPC instead, and this package never prints the URL."* 即 **纯 Electron 桌面载体不保证有监听中的 `webServer`**。本机当前会话是 web shell（`DSH_WEB_URL` 已设）故服务在列；插件已有的 `ctx.get('webServer')` → `ctx.inject(['webServer'], …)` 双路径处理（`index.mjs:452-456`）是对的形状，但**不能把 HTTP 桥当作三线通用前提**。

---

## 4. 客户端模块体系：`dsh.client` / `clientModules` / `slots`

### 4.1 `dsh.client` 元数据

| | 0.1.5-rc.2 | 0.2.0-rc.2 | 0.2.1-alpha.1 |
|---|---|---|---|
| 是否仍被读取 | ✅ 是 | ✅ 是 | ✅ 是 |
| 读取位置 | `package.json` 的 `dsh.client` 字段（`parseDshClient(packageName, pkg.dsh.client)`） | 同 | 同 |
| 必需字段 | `dsh.client.platform: string`（否则 throw） | 同 | 同 |
| 可选字段 | `inject?: string[]`、`external?: string[]`、`immediately?: boolean` | 同 | 同 |
| 硬约束 | 声明了 `dsh.client` 就必须有 `exports["./client"]`，否则 `throw new Error("<pkg> declares dsh.client but exports no './client' bundle")` | 同 | 同 |

### 4.2 `ctx.clientModules`

`ClientModuleRegistry`（node 半）：`graph(): WebBootGraph`、`clientPath(id)`、`fetchBundle(request)`、`artifactBaseline(id)`、`rebuilt(id)`、`onRebuilt(listener)`、`onGraphChanged(listener)` —— **三线成员名一致**。

结构性变化（0.1.5 → 0.2.0，两 0.2 线字节同）：
- 新增 `lib/types/client/entries.d.ts`（3528B，`class ClientEntries`）与 `entry-lifecycle.d.ts`。
- `client/manifest.d.ts` 13517B → 15870B；`client/system.d.ts` 2410B → 4876B。
- `ClientArtifactBaseline` 增加 `readonly ctimeMs`（"Bundle status-change time in milliseconds, including writes that preserve mtime"）。

### 4.3 槽位（尤其 `settings.section`）

| | 0.1.5-rc.2 | 0.2.0-rc.2 | 0.2.1-alpha.1 |
|---|---|---|---|
| `settings.section` | ✅ `{ kind: 'list'; scope: 'root'; owner: SettingsSectionOwnerProps }` | ✅ **逐字相同** | ✅ 逐字相同 |
| 其他 settings 槽位 | `settings.trigger`, `settings.header`, `settings.action`, `settings.close`, `settings.plugins.tab`, `settings.onboarding`, `settings.general.item` | 同 + 新增 **`settings.launcher`**（slot 表 14 行起） | 同 0.2.0-rc.2 |
| `dsh-client-ui-slots` `index.d.ts` | 38954B | 51503B | 51503B（字节同 0.2.0） |

证据：`x-dsh-client-ui-settings\package\lib\types\client\contract\slots.d.ts` 三线同段落比对（0.1.5 行 55-85 vs 0.2.0 行 62-92）——`settings.section` 声明文本逐字一致，含 "Registrant options carry the nav identity: `id` (section key, drives `only` filtering), `order`, `label`"。

本机插件自检：`dsh-perlica-ding/package.json` 已声明 `"dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-slots"] } }` + `"exports": { "./client": "./lib/client.js" }` → 客户端面在**三线都合法**。

---

## 5. `Config` 的 volatile 语义

| 表面 | 0.1.5-rc.2 | 0.2.0-rc.2 | 0.2.1-alpha.1 |
|---|---|---|---|
| `@deepseek-ai/schemastery` 版本 | `^3.18.2` → 实测 3.18.2 | `~3.18.4` → 实测 3.18.4 | `~3.18.5-alpha.1` → 实测 3.18.5-alpha.1 |
| `Schema.prototype.volatile()` | **不存在**（`src/index.ts` 与 `lib/index.mjs` 对 `volatile` 零命中；`lib/types/index.d.ts` 11116B） | **存在**（`volatile()`、`SchemaMode = 'plain'\|'defined'\|'volatile'\|'volatile-defined'`、`validateVolatileSchema` 路径校验、`Volatile<T>` 输出映射；d.ts 12506B） | 存在（d.ts 12506B，sha 与 3.18.4 **相同**） |
| `volatileForm(schema)` / `isVolatilePath(schema, path)` / `projectForm` / `plainConfig` | **不存在**（`dsh-settings` 无 `schema.d.ts`） | **存在** → `@deepseek-ai/dsh-settings/lib/types/schema.d.ts` | 同（文件字节同） |
| Loader「volatile-only 更新不重挂载」 | **不存在**。可用 loader ≤ 1.0.3 | **存在**。`@deepseek-ai/cordis-plugin-loader` 1.0.4/1.0.5 | 同（1.0.6-alpha.1） |

Loader 证据链（决定性）：
- `cordis-plugin-loader@1.0.2` / `1.0.3` → `src/config/entry.ts` 中 `volatile` **0 命中**；`1.0.4` / `1.0.5` → **15 命中**。
- 机制（1.0.5，取自桌面 asar `dsh/node_modules/@deepseek-ai/cordis-plugin-loader/src/config/entry.ts`）：
  ```ts
  const volatileOnly = changes.length === 1 && changes[0] === 'config'
    && equalExceptVolatile(legacy.config, this.options.config, this.fiber.runtime?.Config)
  if (volatileOnly) this.fiber._config = this.options.config
  const pending = volatileOnly && this._commitVolatile() ? [] : changes
  ...
  fiber.ctx.emit(self, 'loader/volatile-update', paths)
  ```
- 时间锚：`cordis-plugin-loader@1.0.4` 发布于 **2026-09-22**，`dsh-base@0.1.5-rc.2` 发布于 **2026-09-10** → **0.1.5 线在时间上不可能具备该语义**（早于首次发布 12 天）。
- 桌面 asar 内 loader 实际版本 = **1.0.5**（`--cat .../cordis-plugin-loader/package.json` → `"version": "1.0.5"`）。

注意区分两个同名概念：`schemastery.volatile()` 是 schema 模式；`@deepseek-ai/cordis` 导出的 `Volatile<T>` 类型来自 `@deepseek-ai/cosmokit` 的 `createVolatile`。0.2.x 的 `dsh-client-ui-settings` 用 `Volatile<boolean>` 作 Config 字段类型。

---

## 6. 事件与服务：`agents` / `planMode` / `subprocess` / `profileContext` / `configEditor`

| 服务键 | 0.1.5-rc.2 | 0.2.0-rc.2 | 0.2.1-alpha.1 | 形状（三线共同的至少） |
|---|---|---|---|---|
| `ctx.agents` | ✅ | ✅ | ✅ | `AgentRegistry extends Service`；`roots(): Agent[]`、`list()`、`get(id)`、`isOwnedBy(id, owner)`、`currentInitiator()`、`requireInitiator()`、`withInitiator`、`withoutInitiator`、`setFactory`、`create`、`resume`、`enter`、`announce`、`register(agent)` |
| `ctx.planMode` | ✅ | ✅ | ✅ | `PlanModeController extends Service`；`get(agent) → {active, pending?}`、`set(agent, active) → 'committed'\|'queued'\|'cancelled'\|'noop'`；常量 `EXIT_PLAN_MODE = "exit_plan_mode"` |
| `ctx.subprocess` | ✅ | ✅ | ✅ | `abstract class SubprocessRuntime extends Service`；`resolveExecutable`、`terminalEnvironment`、`spawn`、`spawnTerminal`；`SENSITIVE_ENV_PATTERN`、`scrubbedParentEnv()`、`DSH_ENV_PREFIX = "DSH_"` |
| `ctx.profileContext` | **⛔ 不存在** | ✅ | ✅ | 见下 |
| `ctx.configEditor` | **⛔ 不存在** | ✅ | ✅ | `class ConfigEditor extends Service`；`get documentPath`、`entries(): Entry[]`、`configuration()`、`edit(entry, change)` |

**`agents.roots()` 三线都有**（`index.d.ts` 中 `roots(): Agent[];` 三线同现，同一上下文块）。

**`subprocess` 差异**：0.1.5-rc.2 **无** `lib/types/control.d.ts`；0.2.x 新增它并导出 `SUBPROCESS_CONTROL_FD = 7`、`SUBPROCESS_CONTROL_ENV = "DSH_SUBPROCESS_CONTROL"`，以及 `SubprocessExecutableNotFoundError`。方法名在 0.1.5 线已经稳定。

**`planMode` 差异**：仅 `index.d.ts` 5850 → 6071 → 6004；`0.2.1-alpha.1` 删除了 `lib/types/invariant.d.ts`（`plan-mode-invariant` 内部检查器）。服务键与两个方法三线一致。

### `profileContext` —— 三线最大的可用性分叉

- **提供者**：`@deepseek-ai/dsh`（CLI / launcher），`hostCtx.provide("profileContext", profileContext)` —— 一个**对象字面量**，不是 Service 类。
- 0.1.5-rc.2 的 `@deepseek-ai/dsh` lib 中 `profileContext` **0 命中**；0.2.0-rc.2 **3 命中**。
- 0.1.5-rc.2 的 `dsh-base/cordis.patch.yml` 完全没有 `ctx.get('profileContext')` 门控；0.2.x 有 5 处（`plugin-manager`、`hmr`、`config-editor`、`settings` + account row 的 `desktopPlatform`）。
- **live 契约只声明了 4 个成员**：`packageManager?`、`startedBundles`、`overlays`、`telemetryDisabledEnv`。
- **但运行时对象实际还有**（`0.2.0-rc.2\package\lib\profile-boot-BZ2ZjNWi.js:259-271`）：`name`（= profile 名，如 `desktop`）、`dir`、`patchPath`、`installAnchor`、`cwd`、`home`。
- 而 `dsh-base` 的 `deepseek-account` row 正是读 **`ctx.get('profileContext')?.name === 'desktop'`** —— 一个 inspect 声明面之外的字段。

→ **`profileContext` 是「存在即用、但只有 4 个字段有契约保证」的典型表面。**插件若要读 `name` / `dir` / `patchPath`，必须当作私有实现细节（见第 8 节）。

---

## 7. 结论：插件可依赖的「公共最小面」

**能在三线都不崩的公共最小面（按可信度降序）：**

| # | 表面 | 三线状态 | 判定 |
|---|---|---|---|
| 1 | **`ctx.storage` + `ctx.storageDomain`（`open(spec)` / `StorageForms` 合并）** | `lib` 逐文件 sha256 三线**完全相同**；三线 base patch 均已启用 | ⭐ **唯一字节级同构的持久化面，应当成为音量持久化的落点** |
| 2 | **`ctx.webServer.register({kind, path, handler})`** | `index.d.ts` sha 三线相同 | ⭐ 契约稳定；但**载体不保证存在**（Electron file:// + IPC），必须 optional |
| 3 | **`dsh.client` 元数据 + `exports["./client"]` + `settings.section` 槽位** | 解析函数、必需/可选字段、槽位声明文本三线一致 | ⭐ 客户端面三线合法 |
| 4 | **`ctx.agents`（`roots()` / `register()` / `get()` / `isOwnedBy()`）** | 三线同现 | ✅ 但现在 `register(agent)` 的**返回类型**从 `() => void` 变为 `ReturnType<Context['effect']>`（0.2 线）——调用点只当 disposer 用则无感 |
| 5 | **`ctx.planMode.get/set`**、**`ctx.subprocess.spawn/resolveExecutable`** | 三线键名与方法名一致 | ✅ 直接依赖；不要依赖 `subprocess.control`（0.2 新增）或 `plan-mode/invariant`（0.2.1 删除） |
| 6 | **`Config` 的**普通**（非 volatile）字段语义** | 三线都是 schemastery，`Config` 作为 Loader 条目配置 | ✅ 用普通 Config 字段持久化的路径**三线通用**——但它写 profile patch，重启才生效 |
| 7 | **`SettingsConflictError`（`code = "SETTINGS_CONFLICT"`）** | 三线同名同 code | ✅ 若未来做 settings 适配层，冲突判别可以共用 |
| 8 | **`@deepseek-ai/cordis` 的 `ctx.get(key)` / `ctx.inject([...], fn)` / `ctx.effect(fn)`** | 三线相同 | ⭐ 这是插件做 feature-detect 的正确工具 |

**一句话结论：三线公共最小面 = `ctx.storageDomain`（落盘）+ `ctx.get()/ctx.inject()`（探测）+ `settings.section` 槽位（UI）。`ctx.settings` 本身不是公共面。**

---

## 8. 必须 optional / feature-detect 的能力清单

以下全部必须走 `ctx.get(key)` 判空 + `ctx.inject([key], scope => …)` 延迟绑定，**不得**放进 `inject` 数组、不得直接 `ctx.<key>` 解引用：

| 能力 | 为什么必须 optional | 探测形状 |
|---|---|---|
| `ctx.settings` | 键名三线都叫 `settings`，但**语义与形状不兼容**：0.1.5 有 `register`，0.2.x 没有。同名不同型 → 只能**运行时探方法** | `const s = ctx.get('settings'); typeof s?.register === 'function'`（0.1.5 路径） vs `typeof s?.update === 'function' && typeof s?.describe === 'function'`（0.2.x 路径） |
| `ctx.configEditor` | **0.1.5 线根本不存在**（npm 首个版本 0.1.7-alpha.1） | `!!ctx.get('configEditor')` |
| `ctx.profileContext` | **0.1.5 线根本不存在** | `!!ctx.get('profileContext')`；且只读 4 个有契约的字段（`packageManager` / `startedBundles` / `overlays` / `telemetryDisabledEnv`），**`name` / `dir` / `patchPath` / `installAnchor` / `cwd` / `home` 是未声明字段**，要用就包一层 try/catch + 默认值 |
| `ctx.webServer` | 三线契约相同，但 **Electron 载体不监听**；且 webServer 未启用时 URL 根本不存在 | `ctx.get('webServer')` → `ctx.inject(['webServer'], …)`（插件现有的双路径就是这个形状） |
| `ctx.clientModules` | 三线都有，但 0.2.0 起内部结构变（`entries` / `entry-lifecycle` / `ctimeMs`）。只读 `graph()` / `onGraphChanged` 是安全的；`artifactBaseline` 的字段会增 | 若只做 UI 注册则无需碰；碰了就判 `typeof cm?.graph === 'function'` |
| `Volatile<T>` / `schemastery.volatile()` / `volatileForm` / `isVolatilePath` | **0.1.5 线整条不存在**（schemastery 3.18.2 无 `volatile()`；loader ≤1.0.3 无 volatile-only 语义） | 不要写进 `Config` schema 顶层；需要「免重启改动」时用 `ctx.storageDomain` + 事件，而不是 `volatile` |
| `@deepseek-ai/dsh-config-editor`（作为依赖 import） | 包在 0.1.5 线未发布 | 只用 `ctx.get('configEditor')`，不要 `import from '@deepseek-ai/dsh-config-editor'` |
| `@deepseek-ai/dsh-hmr` | 0.1.5 线的 row 是 `@deepseek-ai/cordis-plugin-hmr`，且默认 `disabled: true` | 不要假设 HMR 在跑 |
| `subprocess` 的 control fd / `SubprocessExecutableNotFoundError` | 0.2 新增 | 真要错误分类就 `error?.name === 'SubprocessExecutableNotFoundError'` 或看 `code`，不要 `instanceof` 跨包类 |
| `plan-mode` 的 `invariant` 子路径 | 0.2.1-alpha.1 已删除 | 不引用 |

**反例（看似可用、实际危险）**：`ctx.settings.register` 的名字在 0.1.5 与 0.2.x **都"读得通"**（0.2.x 上是 `undefined`，只有调用时才 `TypeError`），所以**静态检查通不过时不会有编译期信号**——必须显式 `typeof x.register === 'function'`。这正是 dsh-perlica-ding 当前踩的坑。

---

## 9. 未解决项 / 未验证项

1. **`0.1.5-rc.2` 线上 loader 的确切版本未能直接观测**。`dsh-base@0.1.5-rc.2` 只声明 `@deepseek-ai/cordis-plugin-hmr@^1.0.17`，而 hmr 不携带 loader 依赖；库里没有任何 0.1.5 线的 profile 可查。结论用**时间锚 + 版本序列**推断（loader 1.0.4 首发 2026-09-22 > 0.1.5-rc.2 发布 2026-09-10）。若需要铁证，应安装一个 0.1.5-rc.2 隔离 profile 后读 `node_modules/.pnpm` 解析结果——**本轮明确未做**（禁用改用户 profile）。
2. **`profileContext` 的完整运行时形状**来自 launcher 打包产物（`profile-boot-*.js`）的对象字面量，**不是** inspect 声明的契约。`name`/`dir`/`patchPath`/`installAnchor`/`cwd`/`home` 六字段三线是否都存在，只验了 0.2.0-rc.2 一处。
3. **`0.2.1-alpha.1` 的运行时未激活验证**。alpha.1 的所有结论均来自 npm tarball 静态比对（`dsh-settings`、`dsh-base` patch 与 0.2.0-rc.2 字节相同），**没有**在 alpha.1 上实跑过任何插件。
4. **`0.2.1-alpha.1` 的 `dsh-client-ui-slots` / `client-modules` 只是 `index.d.ts` 尺寸相同**，未做逐字节 sha 比对（0.2.0/0.2.1 之间仅对 `dsh-settings`、`dsh-base`、`host-webserver`、`storage-*`、`subprocess`、`config-editor`、`storage-domain/index.d.ts` 做过 sha）。
5. **本机 `profiles/web` 的 `pnpm-lock.yaml` 未解析出 loader/settings 解析版本**（lockfile 中只有 peer 约束行 `'@deepseek-ai/dsh-settings': ^0.1.0-rc.7 || ^0.1.1-rc.2 || ^0.1.2-alpha.2 || ^0.2.0-rc.1`，无 `version:` 行）。web profile 属哪条线**未确认**。
6. **`ctx.settings.describe()` 的实跑输出未取**（`describe` 是业务方法，`cordis_inspect_query` 明确不能调用业务 Service 方法）。`ns = entry patch id` 的结论由 **`.d.ts` 注释 + `lib/index.js` 源码 `ns: entry.options.id` + live `Config` 目录的 `patchId`** 三点合成，不是直接观测 `describe()` 返回值。
7. **`storage-json` 的 `Config.root` 是 `!!js dshHomePath('storages')`** —— 本机 `storages\` 下只看到 `workspace.json` 与 `session_projcache/`。**没有**做「写入一个测试 domain 并观察文件落地」的实证（本轮只读取证）。

---

## 附录 A — 复现命令

```powershell
# 三线源码拉取
$t="$env:TEMP\dsh-matrix"
$pkgs=@("dsh-settings","dsh-storage","dsh-storage-domain","dsh-storage-json","dsh-config-editor",
        "dsh-host-webserver","dsh-client-modules","dsh-plan-mode","dsh-subprocess",
        "dsh-client-ui-slots","dsh-agent","dsh-base","dsh-client-ui-settings")
foreach($v in @("0.1.5-rc.2","0.2.0-rc.2","0.2.1-alpha.1")){
  $d=Join-Path $t $v; New-Item -ItemType Directory -Force -Path $d | Out-Null
  foreach($p in $pkgs){
    $out = npm pack "@deepseek-ai/$p@$v" --pack-destination "$d" --silent 2>&1 | Out-String
    $tgz = ($out -split "`n" | Where-Object { $_ -match '\.tgz\s*$' } | Select-Object -First 1)
    if($tgz){ $tgz=$tgz.Trim(); $od=Join-Path $d ("x-"+$p)
      New-Item -ItemType Directory -Force -Path $od | Out-Null
      tar -xzf (Join-Path $d $tgz) -C $od }
  }
}
# schemastery 三线对应版本
#   0.1.5-rc.2 -> 3.18.2 ; 0.2.0-rc.2 -> 3.18.4 ; 0.2.1-alpha.1 -> 3.18.5-alpha.1

# 组合层 diff
Compare-Object (Get-Content "$t\0.1.5-rc.2\x-dsh-base\package\cordis.patch.yml") `
               (Get-Content "$t\0.2.0-rc.2\x-dsh-base\package\cordis.patch.yml")
Compare-Object (Get-Content "$t\0.2.0-rc.2\x-dsh-base\package\cordis.patch.yml") `
               (Get-Content "$t\0.2.1-alpha.1\x-dsh-base\package\cordis.patch.yml")   # 空

# 逐文件 sha 比对（storage 栈 / webserver / plan-mode）
Get-ChildItem "$t\0.2.0-rc.2\x-dsh-storage\package\lib" -Recurse -File |
  ForEach-Object { $_.Name + "=" + (Get-FileHash $_.FullName -Algorithm SHA256).Hash.Substring(0,12) }

# loader volatile 探测
#   npm pack @deepseek-ai/cordis-plugin-loader@{1.0.2,1.0.3,1.0.4,1.0.5} 解包后：
Select-String -Path "<unpacked>\package\src\config\entry.ts" -Pattern 'volatile' -SimpleMatch

# 桌面 asar
node C:\Users\INAGN\.dsh\profile-noise\asar-tool.mjs "Q:\DeepSeek Harness\resources\app.asar" --list "dsh/node_modules/@deepseek-ai/dsh-settings"
node C:\Users\INAGN\.dsh\profile-noise\asar-tool.mjs "Q:\DeepSeek Harness\resources\app.asar" --cat  "dsh/node_modules/@deepseek-ai/cordis-plugin-loader/src/config/entry.ts"
node C:\Users\INAGN\.dsh\profile-noise\asar-tool.mjs "Q:\DeepSeek Harness\resources\app.asar" --cat  "dsh/node_modules/@deepseek-ai/dsh-settings/package.json"
```

live 契约查询（本轮实际执行）：

| 查询 | 结果要点 |
|---|---|
| `Service.listService`（无参） | 全量 Service 目录；`settings` / `storage` / `storageDomain` / `webServer` / `clientModules` / `configEditor` / `agents` / `planMode` / `subprocess` / `profileContext` 均在列 |
| `Service.listService {service:"settings"}` | 6 方法；`ns` 参数说明 = "Profile entry id."；`inject: ["settings"]` |
| `Service.listService {service:"profileContext"}` | 4 个只读成员；无 `name` |
| `Config.listConfigs {name:"@deepseek-ai/dsh-perlica-ding"}` | `total: 0`（**包名不是条目名**） |
| `Config.listConfigs {offset:160,limit:60}` | `{"id":"include:dsh-perlica-ding","patchId":"dsh-perlica-ding","name":"dsh-perlica-ding","status":"schema"}` |

## 附录 B — 版本时间线（`npm view <pkg> time`）

| 包 | 版本 | 发布日 |
|---|---|---|
| `@deepseek-ai/dsh-base` | 0.1.5-rc.2 | 2026-09-10 |
| `@deepseek-ai/dsh-base` | 0.2.0-rc.2 | 2026-09-29 |
| `@deepseek-ai/dsh-base` | 0.2.1-alpha.1 | 2026-10-03 |
| `@deepseek-ai/cordis-plugin-loader` | 1.0.2 | 2026-08-13 |
| `@deepseek-ai/cordis-plugin-loader` | 1.0.3 | 2026-08-30 |
| `@deepseek-ai/cordis-plugin-loader` | **1.0.4** | **2026-09-22** ← volatile-only 语义首发 |
| `@deepseek-ai/cordis-plugin-loader` | 1.0.5 | 2026-09-22 |
| `@deepseek-ai/cordis-plugin-loader` | 1.0.6-alpha.1 | — |

首次发布序列锚：`dsh-base` / `dsh-settings` created `2026-08-10`。
