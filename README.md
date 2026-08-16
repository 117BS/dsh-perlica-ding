# dsh-task-ding

🔔 DeepSeek Harness 分级任务提示音插件：任务完成时响一声，普通问答保持安静。

计划出方案、任务执行完成、需要你回应、执行出错时，播放**不同**的提示音。声音文件可自定义（支持 TTS 语音），窗口在后台也能听到。

> Tiered sound notifications for DeepSeek Harness: plan ready, task done, needs your input, error. Customizable sounds, silent for plain conversation.

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
plan.wav   — 计划出方案（如："计划已生成，请查收"）
done.wav   — 任务完成（如："任务已完成，请验收"）
ask.wav    — 需要你回应（如："需要你回复一下"）
fail.wav   — 出错（如："任务出错了"）（可选）
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
