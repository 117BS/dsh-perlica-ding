# dsh-task-ding · 佩丽卡终端 (Perlica Terminal)

> 「我们不是理想的陈述者，而是理想的践行者。」
> —— 佩丽卡，终末地工业监督

![佩丽卡 - 终末地工业监督](assets/avatar.png)

🔔 **佩丽卡主题** DeepSeek Harness 分级任务提示音插件。

由终末地工业监督佩丽卡为您播报任务状态：计划出方案、任务执行完成、需要您回应、执行出错时，以**终端播报**的口吻播放不同提示音；普通问答保持安静。声音文件可自定义（含佩丽卡风格 TTS 语音文案），窗口在后台也能听到。

> A Perlica-themed (Arknights: Endfield) tiered sound notification plugin for DeepSeek Harness: plan ready, task done, needs your input, error — silent for plain conversation. Customizable TTS sounds, audible even in the background.

## 📖 关于佩丽卡 / About Perlica

佩丽卡（Perlica），《明日方舟：终末地》登场角色，**终末地工业的监督和官方发言人**，杰出的协议技术专家。负责管理和推进协议源石技术的开发与应用，承担帝江号的管理工作，同时也是一名危机处理小组成员。

她**果断而冷静**地应对各种危机，来回奔波于文明环带各处。本插件的提示音风格即取材于她——**简洁、干练、带技术官僚感的终端播报**，称呼您为「管理员」。

## ✨ 功能 / Features

| 场景 Scenario | 触发条件 Trigger | 音效文件 Sound file |
|---|---|---|
| 🗂️ 计划出方案 Plan ready | 回合结束时仍处于计划模式 (plan mode active) | `plan.wav` |
| ✅ 任务完成 Task done | 回合结束且本回合调用过工具 (tools were used) | `done.wav` |
| 💬 普通问答 Plain chat | 纯对话、没用工具 (no tools used) | 静音 Silent |
| 🙋 需要你回应 Needs your input | agent 提问 / 审批请求 (ask_user_question / approval) | `ask.wav` |
| ⚠️ 出错 Error | 回合报错 (agent error) | `fail.wav` |

其他特性：

- **只响主对话**：子代理/后台任务完成时不单独响，随主回合统一收尾
- **防抖**：每档独立 2.5 秒间隔，不会连响
- **可自定义音效**：把 wav 文件放到指定目录即可，无需改代码
- **跨平台**：Windows (SoundPlayer) / macOS (afplay) / Linux (paplay/aplay)
- **可配置**：总开关、防抖间隔、音效目录

## 🎙️ 推荐语音文案（佩丽卡风格）/ Recommended voice lines

佩丽卡风格的 TTS 语音文案，挑选顺口的用 AI 语音合成（如 Edge TTS / 剪映 / 魔音工坊）生成 wav 即可：

**plan.wav —— 计划出方案**

> ① 「作战计划已确认完毕。接下来，按这个执行。」
> ② 「方案已生成，数据完整。确认后即可推进。」
> ③ 「方案部署就绪。确认后，进入执行阶段。」

**done.wav —— 任务完成**

> ① 「任务执行完毕，所有指标正常。」
> ② 「任务完成，结果已归档，可以验收了。」
> ③ 「作业完成，终端已归档。本次任务无异常。」

**ask.wav —— 需要你回应**

> ① 「终端上报：存在待决事项，需要操作员裁决。」
> ② 「检测到待确认项目。本终端无权决定，请操作员指示。」
> ③ 「权限校验失败：该项决定超出本机权限。请操作员授权。」

**fail.wav —— 出错**

> ① 「警告：执行异常，任务中断。原因已记录，请检查。」
> ② 「任务失败。系统已停止本次作业，等待处理指令。」
> ③ 「故障检测：任务未完成。终端已锁定，请排查。」

**练音小建议**：语气放平、语速偏稳、尾音收干净；科技感可以靠一点点"机械感"的停顿（如「确认完毕。」后顿一下）。

## 📦 安装 / Install

### 方法一：从 npm 安装（推荐）

```bash
dsh plugin --profile web add dsh-task-ding
```

安装后**重启 dsh web profile** 生效：

```bash
dsh web restart
```

### 方法二：从 GitHub 安装

```bash
dsh plugin --profile web add https://github.com/<你的用户名>/dsh-task-ding
```

### 方法三：本地开发安装

```bash
dsh plugin --profile web add D:\deepseek\dsh-task-ding
```

## 🎵 音效文件 / Sound files

把以下文件放到**当前工作区根目录**（或配置的 `soundDir`），插件会优先使用；找不到时回退系统自带提示音：

```
plan.wav   — 计划出方案
done.wav   — 任务完成
ask.wav    — 需要你回应
fail.wav   — 出错（可选）
```

要求：

- 必须是真正的 **WAV** 格式（PCM）。TTS 工具如果导出 MP3，需要转码（可用 ffmpeg：`ffmpeg -i input.mp3 -acodec pcm_s16le plan.wav`）
- 文件名固定为上面四个，放到 `D:\deepseek\`（即你的工作区）即可
- 替换后立即生效，无需重启

## ⚙️ 配置 / Configuration

在 profile 的 `cordis.yml` 或用户 patch 层中配置：

```yaml
plugins:
  dsh-task-ding:
    enabled: true        # 总开关
    debounceMs: 2500     # 同档音效最小间隔（毫秒）
    soundDir: ""         # 自定义音效目录，留空则用当前工作区
```

## 🧪 验证 / Verify

安装后随便让 agent 执行一个任务（比如让它调用一次工具），任务完成时应该听到提示音。或者先手动测试声音链路：

```powershell
$p = New-Object Media.SoundPlayer 'D:\deepseek\done.wav'; $p.PlaySync()
```

## 📄 License

MIT
