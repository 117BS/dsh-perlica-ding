# 01 — dsh-std 契约取证（T1）

- 工作流：把 `dsh-perlica-ding` 从私有 `ctx.settings` namespace API 改造成基于 `dsh-std` 标准组件
- 状态：**取证完成 / 存在一处目标级冲突待裁决**（见 §7）
- 日期：2026-10-07
- 取证者：std-recon（只读取证；本文件是全任务唯一写入）

## 0. 证据来源与方法

| 来源 | 位置 | 性质 |
| --- | --- | --- |
| `dsh-std` 源码 | `C:\Users\INAGN\Documents\GitHub\Ætherside\dsh-std` @ `2c131ba`（`T-Auto/dsh-std`） | 静态，可复现 |
| `dsh-perlica-ding` 源码 | `C:\Users\INAGN\Documents\GitHub\Ætherside\dsh-perlica-ding` @ `142c17b` | 静态，可复现 |
| 已安装插件 | `C:\Users\INAGN\.dsh\profiles\desktop\node_modules\dsh-perlica-ding`（`0.2.0`） | 静态，机器现状 |
| 桌面版 DSH 运行时 | `Q:\DeepSeek Harness\resources\app.asar`（`@deepseek-ai/dsh-base@0.2.0-rc.2`） | 静态，需解包 |
| Live 服务契约 | MCP `cordis_inspect_query`（host / Service / Config） | 运行时观测 |
| Live 持久化产物 | `C:\Users\INAGN\.dsh\storages\` | 运行时观测 |

解包与查询命令（复现用）：

```powershell
node C:\Users\INAGN\.dsh\profile-noise\asar-tool.mjs "Q:\DeepSeek Harness\resources\app.asar" --list <子串>
node C:\Users\INAGN\.dsh\profile-noise\asar-tool.mjs "Q:\DeepSeek Harness\resources\app.asar" --cat <路径>
```

下文凡标注 `asar!<路径>:<行号>` 者，行号指**该路径经上述 `--cat` 解包后的文本行号**（asar 内文件本身无独立行号），命令与行号合起来可精确复现。

**未执行**：没有运行任何 DSH 进程内的组件装载实验（无法在离线条件下复现 adapter 的真实装载路径）。§4 的双模结论是**代码路径判定**（跨三个独立代码位置的交集推理），不是运行时实验，已在 §4.4 显式标注。

---

## 1. 组件清单格式：`dsh-plugin.json`

### 1.1 草案 schema（`packages/manifest/schema/dsh-plugin-0.15.schema.json`）

- `additionalProperties: false`，`patternProperties: {"^x-": {}}` —— 顶层只允许已知字段 + `x-` 扩展字段（:5, :95）
- **必填**：`["$schema", "manifestVersion", "id", "name", "version", "facets"]`（:6）
- `manifestVersion`：`const "0.15"`，唯一取值（:9）
- `id`：`^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)+$`（`$defs.namespacedId`，:97）
- `facets`：`additionalProperties: false`，`required: ["host"]` —— **只有 `host` 一个 facet 槽位**（:13-17）
  - `facets.host.entry`：必须 package-relative，禁止绝对路径/盘符/`..`（:23）
  - `facets.host.apiVersion`：`^v[1-9][0-9]*(?:(?:alpha|beta)[1-9][0-9]*)?$`（:24）
- `requires.contracts[]`：`{apiVersion, kind, optional?, fallback?}`（:29-36, :100-110）；**`requires.services` 为 `maxItems: 0`**（:34，v0.15 里必须为空数组/省略）
- `permissions[]`：`{name(→namespacedId), scope, reason?}`（:37, :111-120）
- `contributes`：`commands[]`、`panels`（`maxItems: 0`）、`patternProperties {"^x-": {"type":"array"}}`（:38-46）
- `subscriptions` / `license` / `source` / `artifact` / `compat.hosts[]` / `overrides[]`（:47-93）

运行时校验与之等价，并且**只接受 0.15**：

- `packages/manifest/src/index.ts:276-283` — `validateManifest` 只认 `manifestVersion === '0.15'`，否则 `TypeError`
- `packages/manifest/src/index.ts:286-289` — 允许字段的**精确白名单**（多一个字段即抛错）
- `packages/manifest/src/index.ts:260-269` — `parseManifest`：不执行插件代码、不拉取 schema
- `packages/manifest/src/index.ts:455-466` — `validateCommunityFacets`：`exact(value, ['host'], label, false)`，**确认 v0.15 没有 client facet 字段**

### 1.2 `facets.host` + `requires.contracts` 的投影

`projectCommunityManifest`（`packages/manifest/src/index.ts:346-405`）：

```ts
facets: [{
  name: 'host',
  activation: { apiVersion: 'lifecycle.dsh/v1alpha1', kind: 'FacetModule', spec: { module: manifest.facets.host.entry } },
  ...(requirements.length === 0 ? {} : { protocols: { requires: requirements } }),
  ...(extensions.length === 0 ? {} : { extensions }),
  ...(permissions.length === 0 ? {} : { permissions }),
}]
```

- `requires.contracts` → `protocols.requires`（:399, :407-414）；`fallback` 文本被改写成 `'x-community-fallback'`（:412）
- `permissions` → `PermissionRequest`，`action = permission.name`、`spec = { scope }`（:380-386）
- host facet apiVersion 硬门：`packages/adapter-dsh/src/index.ts:1973-1977` —— 不是 `v1alpha1` 就抛错

### 1.3 extension lane：无 client-facet 字段时如何声明 `browser.ui.dsh/v1alpha1 LocalModule`

v0.15 没有 `facets.browser`，`browser` 半的声明方式是 **`contributes` 的 `x-` 扩展点**：

1. schema 层的入口：`contributes` 的 `patternProperties {"^x-": {"type":"array"}}`（`dsh-plugin-0.15.schema.json:44`）；`validateCommunityContributions` 对 `x-` 只校验"是数组"（`packages/manifest/src/index.ts:529-532`）
2. 投影层把每个 `x-` 数组项转成 `ManifestExtension`，要求字段 `{apiVersion, kind, id, name, spec}`（`packages/manifest/src/index.ts:359-378`）；`metadata.name` 保留 `name` 原值，`metadata.labels['dsh.std/contribution-id']` 记 `id`（:371-374, :18）
3. 扩展点定义由 `@dsh-std/ui-browser` 提供：`apiVersion: 'browser.ui.dsh/v1alpha1'`、`kind: 'LocalModule'`、`spec: { module, requirements? }`（`packages/ui-browser/src/index.ts:6, :9, :69-96`）；`module` 必须 package-relative（:81, :143-149）
4. 适配器 host 半扫描 extension 并挂载：`packages/adapter-dsh/src/index.ts:1283-1291`

**两个硬约束（易踩）**：

- extension 的 `name` 会成为 browser facet 的 facet 名（`packages/adapter-dsh/src/index.ts:1521`），随后被 `defineComponentManifest` 按 `localName` 校验 → 必须匹配 `^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)*$`（`packages/manifest/src/index.ts:21`）
- 每个包**最多一个** LocalModule extension：`moduleId = packageName`，第二个会抛 `browser module id ... is already registered`（`packages/adapter-dsh/src/index.ts:1517-1520`）
- `spec.requirements` 里**只能声明 ContributionHost**（原因见 §5.4）

### 1.4 可直接使用的清单样例

```json
{
  "$schema": "https://raw.githubusercontent.com/T-Auto/dsh-std/main/packages/manifest/schema/dsh-plugin-0.15.schema.json",
  "manifestVersion": "0.15",
  "id": "com.example.perlica-ding",
  "name": "Perlica Ding",
  "version": "0.3.0",
  "facets": {
    "host": { "entry": "lib/standard/host.js", "apiVersion": "v1alpha1" }
  },
  "requires": {
    "contracts": [
      { "apiVersion": "commands.dsh/v1alpha1", "kind": "Command" },
      {
        "apiVersion": "storage.dsh/v1alpha1",
        "kind": "LocalStorage",
        "optional": true,
        "fallback": "音量不跨重启保留（无 LocalStorage provider 时）"
      }
    ]
  },
  "permissions": [
    { "name": "storage.local.read", "scope": "com.example.perlica-ding", "reason": "读取音量设置" },
    { "name": "storage.local.write", "scope": "com.example.perlica-ding", "reason": "保存音量设置" }
  ],
  "contributes": {
    "x-browser-ui": [
      {
        "id": "com.example.perlica-ding.settings",
        "apiVersion": "browser.ui.dsh/v1alpha1",
        "kind": "LocalModule",
        "name": "browser",
        "spec": { "module": "lib/standard/browser.js" }
      }
    ]
  }
}
```

- `$schema` 只被要求是**绝对 URI**（`validateSchemaIdentifier`：`nonEmpty` + `new URL()` 成功，`packages/manifest/src/index.ts:557-562` 区域；声明见 :43-44"不拉取"），因此 `urn:` 亦可（官方测试用 `urn:example:dsh-plugin:0.15`，`packages/manifest/tests/manifest.spec.ts:23`）
- 该形状可从官方测试样例交叉验证：`packages/manifest/tests/manifest.spec.ts:24-47`（含 `x-dev.dsh-std.extensions` 扩展点写法）

---

## 2. facet 模块 ABI

### 2.1 `defineFacet`（`@dsh-std/sdk`）

`packages/sdk/src/index.ts:13-47`：

```ts
interface FacetModule {
  activate(context: ActivationContext): void | Promise<void>
  deactivate?(reason: string): void | Promise<void>
  snapshot?(): FacetProjection | Promise<FacetProjection>
}
function defineFacet(activate, deactivate?, snapshot?): FacetModule   // 三项都做函数类型校验，返回 freeze
```

`FacetProjection = { state?: 'active'|'degraded', message?: string, extensions?: ExtensionStatusProjection[] }`（:19-30）。

协议客户端取用：`defineProtocolKey`（:49-57）、`protocol()`（:59-66，缺失即抛）、`optionalProtocol()`（:68-77，返回 `{available:false}` 而非抛错）。`protocol()` 会做 WeakSet 来源校验（:79-81）。

### 2.2 `ActivationContext`（`@dsh-std/lifecycle`）

`packages/lifecycle/src/index.ts:81-93`：

| 成员 | 语义 |
| --- | --- |
| `identity` | `{component, version, facet, generation, instanceId, participantId}`，**participantId 是 generation 作用域、禁止复用**（:45-54） |
| `plan` | 冻结的 `CompositionPlan` |
| `scope` | `CleanupScope`，见 §2.4 |
| `protocols.agreement(ref)` | 只对**本 facet 声明过**的 requirement 返回协议 | 
| `protocols.client(ref)` | 已中止则返回 `undefined`（:278-281） |
| `protocols.implement(support, impl)` | 只能在 `'activating'` 期间调用（:346-348），且 support 必须在该 facet 的 `protocols.supports` 里声明过（:348-351） |
| `extensions.publish(ref, name, handler)` | 同上，必须匹配已声明 extension 名（:366-372） |

### 2.3 生命周期、publication barrier、cleanup

- 状态机：`'planned'|'activating'|'active'|'deactivating'|'inactive'|'failed'`（:18）
- `activate(plan)` 批量激活 + 失败整体回滚（:208-229）
- **activation 前 gate**：用"声明 + 已发布声明"做一次 negotiate，缺 required support 直接 `failed` + 抛错，**不调用 driver.activate**（:249-260）
- **publication barrier**（:294-307）：`driver.activate()` 返回后，才把 `protocols.supports` + 已 stage 的 extensions 组成声明，再 negotiate 一次；不兼容 → 抛错（:299-300）；兼容才 `publications.publish(...)`（:301-305），随后 `transition(active)`（:307）；`unpublish` 被登记进 scope（:306）——**因此消费者只能看到已 `active` 的 facet 的协议/扩展**
- 停用（:333-344）：`scope.abort(reason)` → `driver.deactivate(reason)` → `scope.close()`；成功转 `'inactive'`，任一失败转 `'failed'` 并把失败继续抛出
- `ActivationHandle.deactivate()` 幂等，共享同一个 settlement（:322-329）

### 2.4 cleanup 契约（`Scope`，`packages/lifecycle/src/index.ts:396-444`）

- `scope.add(dispose)` 返回**幂等 disposer**，多次调用共享同一 settlement（:404-422）
- **scope 关闭后再 `add` 会抛** `cleanup scope is closed`（:405）——异步 activate 里做延迟注册必须放在 scope 内
- `close()`：先 `abort()`，再 **LIFO 逆序 drain**，全部收集错误，最后 `AggregateError`（:428-443）
- `signal` 在 deactivate 一开始就 abort（:336）

### 2.5 两个 realm 的入口字段

| realm | 声明处 | 入口字段 | 加载者 |
| --- | --- | --- | --- |
| host | `facets.host` | `facets.host.entry`（→ 投影成 `lifecycle.dsh/v1alpha1 FacetModule` 的 `spec.module`） | adapter host 半：`resolveFacetModule` + `import()`，取 `namespace.default ?? namespace.facet`，`assertFacetModule` 校验三方法（`packages/adapter-dsh/src/index.ts:1292-1308`, :1961-1971） |
| browser | `contributes['x-...'][n]` → extension `browser.ui.dsh/v1alpha1 LocalModule` | `spec.module` | adapter client 半：`modules.import(moduleId, ...)`，同样取 `default ?? facet`（`packages/adapter-dsh/src/client.ts:133-153`） |

两者的 `deactivate`/`snapshot` 都是**可选**，缺失时 adapter 不注册对应 hook（host：:1305-1306）。

---

## 3. 适配器发现、激活与安装

### 3.1 `@dsh-std/adapter-dsh` 在真实 profile 上的扫描方式

`mountProfileComponents(profileDir)`（`packages/adapter-dsh/src/index.ts:1269-1315`）：

1. 读 `<profileDir>/package.json`；不存在则返回空数组（:1270-1271）
2. 只遍历 **`dependencies`**，按名字排序（:1272-1275）
3. 逐包解析目录，**唯一判定条件：`<packageDir>/dsh-plugin.json` 存在**（:1276-1279）
4. `parseManifest` → `assertHostCompatibility` → `projectManifest`（:1280-1282）
5. 先处理 browser lane：扫 extension 里 `browser.ui.dsh/v1alpha1 LocalModule`（:1283-1291）
6. 再处理 host lane：扫 `activation.apiVersion/kind === lifecycle.dsh/v1alpha1 FacetModule`，`import()` 并 `mount()`（:1292-1308）
7. 任一失败：逆序 dispose 已挂载项后抛出（:1311-1314）

`profileDir` 来源是 `ctx.baseUrl` 或显式 `profileBaseUrl`（`packages/adapter-dsh/src/profile-loader.ts:12-21`；README 明确说明必须由 bundle patch 在 root Loader context 注入，见 `packages/adapter-dsh/package.json` 的 `dsh.bundle.patch` + `cordis.patch.yml:1-5`）。

### 3.2 宿主服务依赖

- host 半：`static inject = ['agents', 'llm', 'sessionController']`（`packages/adapter-dsh/src/index.ts:1000`；`apply.inject` 同源，:2025）
- **`sessionController` 是硬依赖**：缺失即构造期抛错（:1038-1039）
- 构造函数里还用了：`skills`（可选，:1054-1057）
- browser 半：`inject = ['slots', 'locale', 'remote', 'sessions', 'modules']`（`packages/adapter-dsh/src/client.ts:105`）
- 本机观测：`sessionController` 存在（MCP host/Service 目录；adapter 若能启动即证明其存在）——**本机未安装 adapter，故为契约级确认而非装载确认**

### 3.3 `dsh plugin --profile X add <pkg>` 的语义（实测自 DSH 0.2.0-rc.2 内部实现）

拆成三段：

1. **在 profile 目录里跑 pnpm**：`runProfilePnpm` 在 profile 目录内执行 pnpm，执行前快照 `package.json` / `pnpm-lock.yaml` 供失败回滚（`asar!dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/types/operations.js:236-263`）
2. **bundle 自动入选**：`reconcile(before, dir, anchor)` 对**每个新增 dependency** 检查 `dsh.bundle.patch`：
   - 有 → 校验 patch 可读，并 **自动 push 进 `dsh.profile.bundles`**（`operations.js:56-66`，写盘 `saveManifest`）
   - 无 → 打印 `dsh: warning: <name> declares no dsh.bundle — installed as a plain dependency, not a profile layer`（`operations.js:57-59`）
3. **原生装载只看 `dsh.profile.bundles`**：`loadProfileDirectory` 遍历 `readProfileManifest(...).dsh?.profile?.bundles`，对每个 bundle 要求 `dsh?.bundle` 存在，否则报 `declares no dsh.bundle in its package.json`，把整包降级进 `skippedBundles` 并**静默跳过**（`asar!dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:920-956`；跳过原因打印见同文件 `reportSkippedBundles`，:515-521）

结论：**两条通道的入选判据是互不相同的包字段**（原生 = `dsh.profile.bundles` + `dsh.bundle`；标准 = `dependencies` + `dsh-plugin.json`），安装器还会把带 `dsh.bundle` 的依赖**自动**写进 `bundles`。

### 3.4 关键判定：双模包会不会被重复加载？

**判定：需互斥。单包同时带 `dsh.bundle`/`cordis.patch.yml` 与 `dsh-plugin.json`，在"装了 adapter-dsh"的 profile 上会被两条通道各装载一次；代码里没有任何去重守卫。**

三条独立依据的交集：

1. **原生通道入选条件** = 该包名出现在 `dsh.profile.bundles`（`dsh-app-boot/lib/index.js:920-956`），且默认由安装器自动写入（`dsh-plugin-manager/lib/types/operations.js:56-66`）
2. **标准通道入选条件** = 该包名出现在 `dependencies` **且** 包目录有 `dsh-plugin.json`（`packages/adapter-dsh/src/index.ts:1275-1279`）
3. **两个条件可同时为真**，且：
   - `mountProfileComponents` 全程**没有**检查 `dsh.bundle` / `cordis.patch.yml` / `dsh.client`（通读 :1269-1315）
   - 原生装载侧**没有**检查 `dsh-plugin.json`（通读 `dsh-app-boot/lib/index.js:920-956`）
   - 唯一可用的去重信号（Loader entry 的 `id` 与 fiber 状态）只在 **plugin-manager 自己的**管理路径被读取，例如卸载前的"in use"检查使用 `this.ctx.loader.entries()` 比对 `entry.options.id`（`asar!dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js:1849-1855`）——adapter 的发现逻辑没有做同类比对

重复装载的实际后果（叠加而非覆盖）：

- 原生入口与标准 host facet 各注册一遍事件/命令/定时器 → 同一提示音触发两次
- 提示音播放路径若按"场景 → 一个 handler"注册，会出现条目冲突或双播
- 持久化会出现两个写入者，且互不可见（见 §7 冲突点）

**反向佐证（观察）**：`@dsh-std/adapter-dsh` 自身就是纯原生包——有 `cordis.patch.yml`、**没有** `dsh-plugin.json`（`packages/adapter-dsh/` 文件清单），因此它不会自我发现挂载。上游对"一个包走一条通道"是有默契的，但**没有把它写成守卫**。

**可用的守卫形态（假设，未实现验证）**：标准 host facet 在 `activate()` 内检查 `ctx.get('loader')` 里是否存在 `options.id === '<native row id>'` 且已挂载 fiber 的 entry；存在则降级为 no-op 并把音量持久化/播放让给原生入口。该信号在 plugin-manager 里被证明可读（同上 :1849-1855），但 adapter 未兜底，故属自建守卫。

### 3.5 本机 profile 现状（观察）

`C:\Users\INAGN\.dsh\profiles\desktop\package.json`：

- `dependencies` 含 `dsh-perlica-ding: github:117BS/dsh-perlica-ding#142c17b8...`
- `dsh.profile.bundles` 含 `dsh-perlica-ding`（原生通道已入选）
- **`@dsh-std/adapter-dsh` 既不在 `dependencies` 也不在 `bundles`** → 标准通道当前完全未启用，插件即便带上 `dsh-plugin.json` 也不会被任何东西读取
- 已安装包 `node_modules\dsh-perlica-ding\package.json`：`dsh.bundle.patch = "./cordis.patch.yml"`、`dsh.client.platform = "web"` + `inject: ["@deepseek-ai/dsh-client-ui-slots"]`、`main = index.mjs`；**无 `dsh-plugin.json`**

npm 版本元数据（`npm view`）：`@dsh-std/adapter-dsh` 的 `latest = 0.1.1-rc.2`，`rc = 0.1.1-rc.4`；本地克隆 `packages/adapter-dsh/package.json:3` 是 `0.1.1-rc.4`。**结论：直接 `dsh plugin add @dsh-std/adapter-dsh` 会拿到 rc.2，不是被取证的 rc.4**（rc.2 是否含 browser 半 + profile-loader 未核，见 §8.5）。

---

## 4. `ui-browser` 的 `SettingsSection` 与 DSH 槽位映射

### 4.1 声明形状（`packages/ui-browser/src/index.ts`）

```ts
export const API_VERSION = 'browser.ui.dsh/v1alpha1'        // :6
export const SETTINGS_SECTION_KIND = 'SettingsSection'       // :7
export const TOOL_CALL_VIEW_KIND = 'ToolCallView'            // :8
export const LOCAL_MODULE_ACTIVATION_KIND = 'LocalModule'    // :9
export const SETTINGS_SECTION = { apiVersion: API_VERSION, kind: SETTINGS_SECTION_KIND }  // :12

export interface SettingsSectionContent { label: string; order?: number }                 // :15-18
export function settingsSectionRequirement(): UiSurfaceRequirement                        // :114-116
// → { apiVersion: 'browser.ui.dsh/v1alpha1', kind: 'SettingsSection', mode: 'local-module' }
```

`UiSurfaceRequirement` 的定义与 `mode` 取值在 `packages/ui/src/index.ts:13-17`：`API_VERSION = 'ui.dsh/v1alpha1'`、`CONTRIBUTION_HOST_KIND = 'ContributionHost'`、`UiContentMode = 'host-rendered' | 'local-module'`。

`mode` 是**强校验**的：provider 必须支持请求的 mode（`packages/ui/src/index.ts:189-190`），`local-module` 必须带 `localModule`（:207-208），`host-rendered` 必须不带（:210）。

### 4.2 browser facet 模块的形态（`BrowserUiView`）

`packages/ui-browser/src/index.ts:46-60`：`{ component, inject?, locale?, label?, dispose?, setup?(host) }`；`setup` 拿到 `BrowserUiHost { locale, executeCommand, readAttachment }`（:40-44）。`defineBrowserUiFacet` 把它包成普通 DSH client plugin（`inject: ['dshStdBrowserUi']`，:123-141）。

### 4.3 适配器 browser 半的实际槽位映射（`packages/adapter-dsh/src/client.ts`）

| 标准面 | provider participantId | DSH 槽位名 | 注册字段 | 位置 |
| --- | --- | --- | --- | --- |
| `browser.ui.dsh/v1alpha1 SettingsSection` | `dsh/browser/settings-section` | `settings.section`（`kind: list`） | `id` = 贡献 id，`order` = `content.order ?? 100`，`label`，可选 `locale`/`inject` | :334-357（`slots.inject` :342，`slots.register` :343-349） |
| `browser.ui.dsh/v1alpha1 ToolCallView` | `dsh/browser/tool-call-view` | `tool.call.toolview`（keyed） | `key` = `content.tool` | :359-379 |
| 组件清单（非标准协议面） | — | `settings.plugins.tab` | locale 命名空间 `settings.dshStdComponents` | :577-596 |

内容校验：`settingsContent` 要求 `label` 非空、`order` 为 safe integer（:382-389）。

槽位名在 DSH 侧确实存在（**独立核验，非推定**）：

- `settings.section` 的声明与占用者清单在 `@deepseek-ai/dsh-client-ui-settings-general`：children 表 `"settings.section": {...}`（`asar!dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js:1136`），渲染于 :337，占用者读取于 :1018-1033，自身也 `slots.inject('settings.section', ...)`（:1171-1172）
- `settings.plugins.tab` 由 `@deepseek-ai/dsh-client-ui-settings-plugins` 作为 `settings.section` 的子槽位声明（`asar!.../dsh-client-ui-settings-plugins/lib/client.js:201-208`），标签页也由它消费（:68, :124）

### 4.4 `slots.inject` 的等待逻辑（实测自 DSH 内部实现）

`slots` 服务实现于 `@deepseek-ai/dsh-client-ui-renderer/lib/client.js`：类构造 `super(ctx, "slots")`（`asar!` 该文件 :1323），`inject(key, callback)`（:1343 起）。契约（同处 JSDoc + 实现）：

- 槽位**已声明**时，callback **同步执行**
- 未声明时，注册到 declaration change 订阅，**等声明方 `register()` 提交声明后**再执行（`reconcile()` 读 `specDynamic(key)` 与 `declarationEpoch(key)`；`:1354-1373`）
- 绑定在**调用方 fiber**：插件卸载会取消等待并回收已生效贡献（`ctx.effect` 包装，`:1345`、`:1390-1395`）
- 返回**幂等 disposer**（`:1391-1394`）
- 声明被 collapse 时先 dispose 已生效效果，日后重新声明会**再次执行** callback（`activeEpoch` 比对，`:1359-1372`）
- `INACTIVE_EFFECT` 在 `changed()` 里被特判为"停止等待"而非报错（`:1375-1386`）

对插件的可操作含义：`slots.inject` 是**安全的**（不会因槽位未声明而抛 `slot "x" is not declared`），代价是**静默不出现**——`slots.register` 才是抛错点（`asar!@deepseek-ai/dsh-client-ui-slots/lib/index.js:163-166` 对未声明的槽位抛错）。

### 4.5 ContributionHost 协商

`packages/adapter-dsh/src/client.ts:231-314`：

1. facet 必须是 `browser.ui.dsh/v1alpha1 LocalModule` 激活，模块必须提供 `activate`（:235-239）
2. **该 facet 的 `protocols.requires` 里每一条都必须是 `ui.dsh/v1alpha1 ContributionHost`，否则直接抛 `DSH browser UI adapter cannot provide <apiVersion> <kind>`（:241-246）** —— 这是 §1.3 那条"`spec.requirements` 只能声明 ContributionHost"的依据
3. 用只含本地 provider（settings-section / tool-call-view）的声明做 `compose`（:249-266），再 `negotiate`（:278-283），取 `ContributionHost` 的 `agreement`（:284-288）
4. `bindContributionHosts(agreement, identity, providers)` 得到**作用域化的 client**（:289-299），作为 `context.protocols.client(...)` 暴露给标准 facet
5. 失败路径调用 `closeFacet(...)` 做清理（:302-307）

UI provider 的协商规则（`packages/ui/src/index.ts:280-330`）：按 surface+mode 过滤，**0 个候选或 ≥2 个候选都是 error**（`no provider supports ...` / `multiple providers support ...`），即同一 surface 不允许双 provider。

---

## 5. LocalStorage 现状与合规 provider 义务

### 5.1 复核结论：适配器只注册协议声明，没有 DSH 侧 provider（**确认**）

`grep -n storage packages/adapter-dsh/src/*.ts` 全量命中只有 4 行：

```
packages/adapter-dsh/src/index.ts:133   import { register as registerStorage } from '@dsh-std/storage'
packages/adapter-dsh/src/index.ts:418   ... 'the Runtime does not provide image attachment storage'（无关，attachment）
packages/adapter-dsh/src/index.ts:430   ... 同上
packages/adapter-dsh/src/index.ts:1797  registerStorage(catalog)
```

- `:1797` 位于 `createDshProtocolCatalog()`（:1791-1804），语义是**把协议定义装进 ProtocolCatalog**，不实现它
- 实际提供实现的集合是 `standardImplementations()`（:1768-1780）：`CommandRuntime`、`ModelCatalog`、`sessionProtocols`（SessionCatalog/SessionHistory）+ 构造期的 command/skill 类 support；**没有 LocalStorage**
- 跨仓库搜索 `localStorageSupport|storage.local.read|storage.local.write|LocalStorageBindings`：只有 `packages/storage/src/index.ts` 与 `packages/storage/tests/storage.spec.ts` 命中 → **dsh-std 树内不存在任何 LocalStorage provider**
- adapter README 自述一致："在协议目录中装载 `MessageObserver`、`LocalStorage` 与 Presentation definitions"（`packages/adapter-dsh/README.zh.md:28`），即**只装定义**

### 5.2 因此：硬 require `LocalStorage` 会装载失败

链条（三段，均为代码事实）：

1. 协商时无候选 → `required-support-missing`，severity `error`（`packages/storage/src/index.ts:222-228`；`optional: true` 时降为 `warning`）
2. 任一 error issue 即 `compatible: false`（`packages/composition/src/index.ts:352`）
3. `mount()` 在 compose 阶段就抛 `facet ... cannot be composed`（`packages/adapter-dsh/src/index.ts:1361`）；即使漏过，activate 前的 gate 也会失败（`packages/lifecycle/src/index.ts:254-260`）

**可操作结论：v0.15 清单里 `storage.dsh/v1alpha1 LocalStorage` 必须写 `optional: true` + `fallback`**，除非同时交付一个 provider。

另两条协商约束（决定 provider 的可行位置）：

- 候选 provider 不能是消费者自己：`candidate.participant !== row.participant`（`packages/storage/src/index.ts:220`）
- **同一协议上出现 ≥2 个候选 = `support-ambiguous` error**（:229-235）→ 一个组合里只能有一个 LocalStorage provider，且"每个组件自带一个 provider"的方案会让**所有**消费者的协商一起失败

### 5.3 合规 provider 必须实现什么（`docs/proposals/storage.zh.md` + `packages/storage/src/index.ts`）

操作面（`packages/storage/src/index.ts:86-98, :100-107`）：

| 面 | 形状 | 义务 |
| --- | --- | --- |
| 基础 | `get{key}→{value:JsonValue|null}` / `set{key,value}→{stored:true}` / `delete{key}→{deleted:boolean}` | 省略 `spec` 即基础 profile（proposal:20） |
| `presence` | `has{key}→{exists:boolean}` | 显式存 JSON `null` 必须返回 `true`（proposal:83） |
| `list` | `list{limit,prefix?,cursor?}→{keys,nextCursor?}` | 声明 `list` 时必须同时声明正整数 `maxListPageSize`，否则 support 校验抛错（`storage/src/index.ts:272-277`） |

必须满足的语义（逐条来自 proposal，行号见 `docs/proposals/storage.zh.md`）：

1. **命名空间隔离**：为每个 Component 分配互相隔离的命名空间；命名空间必须由**已验证的调用身份**推出，禁止从请求参数取（:33-35）；activation instance 可共享所属 Component 的存储，但不得因此获得跨 Component 访问（:35）
2. **key 语义**：非空字符串、无文件路径语义，禁止把 `.` / `..` / 路径分隔符 / Unicode 规范化解释成跨命名空间访问；可自定义长度/容量/单值上限，但必须**在写入前稳定拒绝**（:37）
3. **value 模型**：JSON value（null / boolean / 有限 number / string / 数组 / string-key 对象）；`undefined`、`bigint`、非有限数、函数、symbol、循环引用、带运行时原型的对象非法（:41）；返回 value 与已提交 value 在 JSON 模型下等价，调用方不得依赖 identity/prototype/描述符/key 顺序（:43）
4. **原子 set**：`set` 原子替换；成功返回前后续同 key 操作必须能看到新值；失败不得留下部分 value（:65）
5. **并发**：同一命名空间内同一 key 的操作必须串行化，顺序以 provider 接纳顺序为准；不同 key 可并发（:98）；基础 profile 不提供多 key 事务/CAS/watch（:100）
6. **权限**：读需 `storage.local.read`，写/删需 `storage.local.write`；scope 绑定该 Component 的命名空间，**默认拒绝、可撤销**；**每次操作都要检查当前 grant**，撤销后新操作必须失败（:104-106）
7. **生命周期与保留**：facet deactivate **不删除**数据；provider 必须声明 uninstall 后的保留规则；显式 purge 删整个命名空间且应要求产品层确认；cleanup 与 purge 必须**可重复执行**，失败的 cleanup 不得报告为已完成（:110-112）
8. **错误码**：必须稳定区分 `PERMISSION_NOT_GRANTED` / `INVALID_KEY` / `INVALID_CURSOR` / `INVALID_VALUE` / `FEATURE_NOT_NEGOTIATED` / `QUOTA_EXCEEDED` / `STORAGE_UNAVAILABLE`（:118-124；枚举同步在 `packages/storage/src/index.ts:100-107`）；错误可带不敏感诊断，但不得泄露其他 Component 的 key/value/路径/配额明细（:126）
9. **不构成沙箱**：协议是访问与互操作协议，产品不得把它描述成隔离保证（:130）
10. **日志**：禁止把 value/凭据/secret 写入普通日志；备份、同步、诊断导出必须遵守同一访问边界（:132）
11. **兼容性**：改命名空间归属、JSON value 模型、操作原子性、权限动作或错误含义 → 必须换 `apiVersion`（:136-139）

### 5.4 browser 侧不能用来"补"存储

browser facet 的 `protocols.requires` 只能是 ContributionHost（§4.5 第 2 点）。**想通过 local-module 里 `requires` 声明 `LocalStorage` 来持久化，会在 `mountFacet` 直接抛错**。存储只能走 host facet。

---

## 6. 推荐包布局与 seam 结论

### 6.1 seam 判断（`codebase-design` 词汇）

- **真正的 seam 是"音量持久化"**，跨它变化的是两个 realm/两套宿主：原生 DSH host（`ctx.storageDomain`）与标准 dsh-std host facet（`storage.dsh/v1alpha1 LocalStorage`）。
- 但**第二个 adapter 目前不存在**（§5.1）：dsh-std 侧没有 provider，标准通道装不了任何东西。→ 按"一个 adapter 只是假想 seam，两个才是真 seam"，**现在给存储抽双向 seam 是不成立的**，唯一真实可用的实现是原生 `storageDomain`。
- 于是正确切分是：**核心逻辑（场景判定 + 音量模型 + WAV 缩放）抽成无依赖 module，宿主持久化放在一个窄 adapter 里**；标准通道只作为"能装上时"的第二 adapter 预留，不与原生通道在同一包内共存。

### 6.2 宿主原生持久化 seam（**建议采用，已核验存在且在本机运行中**）

- DSH 0.2.0-rc.2 base bundle 已装载持久化栈：`id: storage`（`@deepseek-ai/dsh-storage`）、`id: storage-json`（`config.root = dshHomePath('storages')`）、`id: storage-domain`（`config.backend: json`）——`asar!dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml`（"Durable KV storage" 段）
- Live 契约（MCP host/Service）：`storageDomain.{open(spec), get(name), closeAll()}`；`storage.{backend, mount(form, facility), form(form)}`
- 用法（`asar!.../dsh-storage-domain/lib/index.js`）：
  - `ctx.inject(['storageDomain'], ctx => …)`（`inject` 常量在包顶层）
  - `const domain = await ctx.storageDomain.open(defineDomain({ name, version, tables: { settings: domainTable(z.object({...})) }, global?, layout?, compatibleVersions?, invalidRecords? }))`
  - `await domain.table('settings').put(key, value)` / `domain.table('settings').get(key)`（同步读内存，写经**单条串行链**：先落盘、后改内存、再 `emit('domain/changed')`）
  - `await domain.close()`（幂等，通常挂进 `ctx.effect`）
  - `defineDomain` 在**模块加载期**就校验：name/table 需匹配 `UNIT_NAME_RE`、version 为非负整数、`compatibleVersions` 必须严格小于 version、`global.schema` **不得接受 null**（null 是介质的"从未写入"哨兵）
  - 错误：`DomainError`，code ∈ `already-open | facet-unsupported | invalid-record | missing-key | closed | …`；`invalidRecords: 'backup-and-skip'` 可让坏记录旁置而非中断打开
- **本机运行证据**：`C:\Users\INAGN\.dsh\storages\workspace.json`（8161 B）与 `C:\Users\INAGN\.dsh\storages\session_projcache\sessions\*.json` 已存在 → `workspace`、`session_projcache` 两个 domain 正在使用该栈
- 现有故障的对照：已安装 `dsh-perlica-ding@0.2.0` 在 `index.mjs:245-264` 调 `settingsService.register(ns, zodSchema, {base, applies:'live'})`，并用 try/catch 吞掉失败打印 `settings registration failed`；`currentVolume()`（:267-278）在 `volumeScope` 为空时回落到内存值与 Config → **正是"不跨重启"的根因**。运行时契约确认 `ctx.settings` 只有 `configure / describe / update / replace / mutate / prepareDocument`（MCP host/Service `settings`），**没有 `register`** → `settingsService.register is not a function`

### 6.3 建议包结构（文件清单级）

**方案 A（推荐，单仓两包 + 共享 core）**

```
dsh-perlica-ding/                      # 仓库不变
├─ package.json                        # 私有 workspace root（pnpm）
├─ packages/
│  ├─ core/                            # 无宿主依赖的共享 module
│  │  ├─ package.json                  # name: "@perlica-ding/core", exports "./scenarios.js" 等
│  │  └─ src/
│  │     ├─ scenarios.ts               # 回合结束场景判定（planReady / done / needsInput / error）
│  │     ├─ volume.ts                  # 音量模型：clamp 0..100、整数化、默认值
│  │     └─ wav.ts                     # PCM 增益缩放（现 index.mjs 的 scaleWavVolume）
│  ├─ native/                          # ← 始终可用的那条通道
│  │  ├─ package.json                  # name "dsh-perlica-ding"; dsh.bundle.patch = "./cordis.patch.yml"; dsh.client
│  │  ├─ cordis.patch.yml              # - insert: [{ id: dsh-perlica-ding, name: dsh-perlica-ding }]
│  │  ├─ index.mjs                     # host: 场景订阅 + 播放 + storageDomain 持久化
│  │  ├─ lib/client.js                 # browser: 现有设置页/预览（dsh.client 已有）
│  │  ├─ sounds/  assets/              # 原样保留
│  │  └─ (禁止 dsh-plugin.json)
│  └─ standard/                        # ← 标准通道，独立包名，独立安装
│     ├─ package.json                  # name "dsh-perlica-ding-std"; 无 dsh.bundle、无 cordis.patch.yml
│     ├─ dsh-plugin.json               # §1.4 形状（LocalStorage 必须 optional: true）
│     ├─ lib/host.js                   # defineFacet(activate, deactivate, snapshot)
│     └─ lib/browser.js                # LocalModule：SettingsSection 视图
└─ docs/workstreams/01-std-contract.md
```

**加载与持久化在两种宿主下的行为**

| 宿主 | 装什么 | 谁加载 | 持久化 |
| --- | --- | --- | --- |
| 只有原生 DSH（**本机现状**） | `dsh-perlica-ding`（bundles 里，已在） | 原生 Loader（`dsh.profile.bundles`） | `ctx.inject(['storageDomain'])` → `open(defineDomain({name:'perlica_ding', version:1, tables:{settings: domainTable(z.object({volume: z.number().int().min(0).max(100)}))}}))`；无 `storageDomain` 时回落 `ctx.settings`（只读展示）→ 插件 `Config` → 默认 100 |
| 只有原生 DSH，用户也想用标准通道 | 追加 `@dsh-std/adapter-dsh`（bundle）+ `dsh-perlica-ding-std`（普通依赖） | adapter discover 后者 | 标准侧**声明** `LocalStorage optional:true` 但**没有 provider → 拿不到**，仍回落 `Config`；此路径今日不能持久化（§7.1） |
| 两个包都装 | 两者并存 | 各自通道、互不重叠 | 两个写入者可能写不同介质 → **必须只让一个包持久化**：建议 `standard` 包不持久化（纯 UI/播放示范），或让 `standard` 包查 `ctx.get('storageDomain')` 写同一 domain 以避免分叉 |

**方案 B（不推荐，仅记录）：单包双模 + 自建守卫**。需要 (a) `dsh-plugin.json` + `dsh.bundle` 并存，(b) 在标准 host facet 里读 `ctx.loader.entries()` 判断原生 row 是否已挂载并 no-op，(c) 承担 §3.4 的双写与双播风险。收益是少一个包，代价是把"两条通道"的互斥从**结构上排除**降级为**运行期约定**。

### 6.4 与 dsh-perlica-ding 现状的对接点

- `index.mjs` 只需替换 `registerVolumeSettings`（:245-264）与 `currentVolume()`（:267-278）两处；场景判定/播放不动
- `package.json` 增加 `@deepseek-ai/dsh-storage-domain`、`@deepseek-ai/dsh-storage`、`zod` 的 peer/dev 依赖；**不要**引入 `@dsh-std/*`（原生包保持零 dsh-std 依赖，避免把标准通道的失败面带进主路径）
- `scripts/verify*.mjs`（package.json `verify` 脚本）需新增"重启后音量保持"的仿真断言——当前脚本无法捕捉本次故障

---

## 7. 目标级冲突与待裁决

### 7.1 【目标级冲突，必须先裁决】"改造成基于 dsh-std 标准组件"与"音量持久化"当前不可同时满足

- `dsh-std` 的持久化 agent 是 `storage.dsh/v1alpha1 LocalStorage`，而**该协议在 dsh-std 树内、在 DSH 0.2.0-rc.2 宿主内都没有 provider**（§5.1；宿主侧 `ctx.storage` 是另一套 DSH 原生栈，不是这个协议）
- 且 provider 不能是消费者自己（`storage/src/index.ts:220`），一个组合里只允许一个（:229-235）
- 所以"纯标准组件"版本**无法持久化音量**；要持久化就必须让标准 host facet 落到 DSH 原生 `storageDomain`，即**混合实现**——这偏离了"基于 dsh-std 标准组件"的字面目标

可选收口（需 YG/Lead 选一）：

1. **目标修正为"原生 storageDomain 持久化 + 标准组件化只作用于 UI/播放层"** ← 我建议这条，它在最小改动上真正修复故障
2. 先交付一个 `LocalStorage` provider 组件（substantial 新工作，且 provider 必须与消费者分属不同包）
3. 接受"标准版不持久化"，把持久化留在原生包（§6.3 表格第 3 行）

### 7.2 双模形态裁决

按 §3.4，**单包双模需互斥**。请裁决走 §6.3 方案 A（两包互斥，结构上安全）还是方案 B（单包 + 自建 Loader 守卫）。

### 7.3 安装前置是否可接受

标准通道在本机**完全未启用**（profile 的 `dependencies` / `dsh.profile.bundles` 均无 `@dsh-std/adapter-dsh`）。启用它需要改动 `C:\Users\INAGN\.dsh\profiles\desktop\package.json`（安装 `@dsh-std/adapter-dsh`）。这超出我的授权范围（禁改 profile），需要 YG 明确批准；并注意 §3.5 的版本陷阱（`latest`=rc.2，被取证的是 rc.4）。

### 7.4 待核项（我无法离线确认）

- `@dsh-std/adapter-dsh@0.1.1-rc.2`（npm `latest`）与本地 rc.4 的功能差：是否含 `./client` 与 `./profile-loader` 出口。rc.4 的 `package.json:10-29` 两者都有；rc.2 未核
- adapter 在真实 desktop profile 上装载的**运行时**行为（我只做了代码路径判定 + 契约级确认，没有装载实验）
- 现有 `index.mjs` 的场景判定是否依赖 `ctx.settings` 之外的其他私有 API（本次只审计了持久化路径）

---

## 8. 观察 / 假设 分界

**已核实的观察（file:line 或命令可复现）**

1. `dsh-plugin.json` v0.15 必填字段、`facets` 只有 `host`、extension lane 走 `contributes['x-…']`（§1）
2. `assertHostCompatibility` 只接受 `facets.host.apiVersion === 'v1alpha1'`（`packages/adapter-dsh/src/index.ts:1973-1977`）
3. `defineFacet` / `ActivationContext` / 生命周期状态机 / publication barrier / `Scope` LIFO 幂等 cleanup（§2）
4. 发现条件 = `dependencies` × `dsh-plugin.json` 存在（`packages/adapter-dsh/src/index.ts:1269-1315`）
5. 原生装载条件 = `dsh.profile.bundles` × `dsh.bundle`（`asar!@deepseek-ai/dsh-app-boot/lib/index.js:920-956`）
6. 安装器会把带 `dsh.bundle.patch` 的新依赖**自动**写进 `dsh.profile.bundles`（`asar!@deepseek-ai/dsh-plugin-manager/lib/types/operations.js:56-66`）
7. adapter host 半的浏览器与存储能力缺口（`standardImplementations()` 无 storage；`registerStorage` 只装定义）—— 且全树无 provider
8. `slots.inject` 的等待/幂等/声明期重放语义（`asar!@deepseek-ai/dsh-client-ui-renderer/lib/client.js:1343-1395`）
9. `settings.section` / `settings.plugins.tab` 是 DSH 真实槽位名（`asar!@deepseek-ai/dsh-client-ui-settings-general/lib/client.js:1136`、`…settings-plugins/lib/client.js:208`）
10. `ctx.settings` 无 `register`（MCP host/Service `settings`，方法表 6 项）
11. DSH 原生持久化栈在本 profile 装载并已产生数据（base patch 三行 + `C:\Users\INAGN\.dsh\storages\*.json`）
12. 现有插件失效点：`index.mjs:245-264` 调 `settingsService.register`，失败被 try/catch 吞掉

**假设（未实现验证）**

- A1 §3.4 的"重复装载"是**代码路径判定**：三条入选条件在代码里可同时为真且无去重守卫。未做运行时装载实验；若上游在别处（例如 Loader 层按 entry id 去重）另有守卫，结论会变——但我在 adapter 与 app-boot 两侧都未找到该守卫
- A2 §3.4 里给出的守卫形态（读 `ctx.loader.entries()` 比对 id）只在 plugin-manager 的管理路径被证明可用，未在 adapter 语境验证
- A3 §6.2 的 `storageDomain` 用法取自 `dsh-storage-domain` 的 lib 与 `workspace` domain 的既有产物，未亲手写过 domain
- A4 §6.3 的包结构是可落地建议，未实现

---

## 附：证据索引速查

| 结论 | 证据 |
| --- | --- |
| v0.15 必填/字段白名单 | `packages/manifest/schema/dsh-plugin-0.15.schema.json:5-6,95`；`packages/manifest/src/index.ts:276-289` |
| facets 只有 host | `dsh-plugin-0.15.schema.json:13-17`；`packages/manifest/src/index.ts:455-466` |
| extension lane 投影 | `packages/manifest/src/index.ts:359-378`；`packages/manifest/tests/manifest.spec.ts:38-46` |
| LocalModule 形状 | `packages/ui-browser/src/index.ts:6,9,69-96` |
| host 兼容门 | `packages/adapter-dsh/src/index.ts:1973-1977` |
| facet ABI | `packages/sdk/src/index.ts:13-47`；`packages/lifecycle/src/index.ts:81-93` |
| publication barrier | `packages/lifecycle/src/index.ts:294-307` |
| cleanup 契约 | `packages/lifecycle/src/index.ts:396-444` |
| 发现算法 | `packages/adapter-dsh/src/index.ts:1269-1315` |
| adapter 注入 | `packages/adapter-dsh/src/index.ts:1000,1038-1039`；`client.ts:105,241-299` |
| bundle 自动入选 | `asar!@deepseek-ai/dsh-plugin-manager/lib/types/operations.js:235-263` |
| 原生装载只看 bundles | `asar!@deepseek-ai/dsh-app-boot/lib/index.js:920-956` |
| 槽位映射 | `packages/adapter-dsh/src/client.ts:334-379,577-596` |
| `slots.inject` | `asar!@deepseek-ai/dsh-client-ui-renderer/lib/client.js:1323,1343-1395` |
| 无 storage provider | `packages/adapter-dsh/src/index.ts:133,1768-1780,1797`；全树 grep |
| LocalStorage 语义 | `docs/proposals/storage.zh.md:20-139`；`packages/storage/src/index.ts:86-107,213-258` |
| 原生持久化栈 | `asar!@deepseek-ai/dsh-base/cordis.patch.yml`（Durable KV storage 段）；`asar!@deepseek-ai/dsh-storage-domain/lib/index.js`；`C:\Users\INAGN\.dsh\storages\` |
| 现有故障点 | `…\profiles\desktop\node_modules\dsh-perlica-ding\index.mjs:245-278` |
