# dsh-perlica-ding · 佩丽卡终端 (Perlica Terminal)

> 「我们不是理想的陈述者，而是理想的践行者。」
> —— 佩丽卡，终末地工业监督

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

![佩丽卡 - 终末地工业监督](assets/avatar.png)

[English](README.en.md) | **简体中文**

🔔 **佩丽卡主题** DeepSeek Harness 分级任务提示音插件。

由终末地工业监督佩丽卡为您播报任务状态：计划出方案、任务执行完成、需要您回应、执行出错时，以**终端播报**的口吻播放不同提示音；普通问答保持安静。声音文件可自定义（含佩丽卡风格 TTS 语音文案），窗口在后台也能听到。

## 📖 关于佩丽卡

佩丽卡（Perlica），《明日方舟：终末地》登场角色，**终末地工业的监督和官方发言人**，杰出的协议技术专家。负责管理和推进协议源石技术的开发与应用，承担帝江号的管理工作，同时也是一名危机处理小组成员。

她**果断而冷静**地应对各种危机，来回奔波于文明环带各处。本插件的提示音风格即取材于她——**简洁、干练、带技术官僚感的终端播报**，称呼您为「管理员」。

## ✨ 功能

| 场景 | 触发条件 | 音效文件 |
|---|---|---|
| 🗂️ 计划出方案 | 回合结束时仍处于计划模式 | `plan.wav` |
| ✅ 任务完成 | 回合结束且本回合调用过**执行类工具**（改文件/跑命令/子代理/工作流等） | `done.wav` |
| 💬 普通问答 | 纯对话，或只用了查询类工具（读文件/搜索网页等） | 静音 |
| 🙋 需要你回应 | agent 提问 / 审批请求 | `ask.wav` |
| ⚠️ 出错 | 回合报错 | `fail.wav` |

其他特性：

- **只响主对话**：子代理/后台任务完成时不单独响，随主回合统一收尾
- **防抖**：每档独立 2.5 秒间隔，不会连响
- **可自定义音效**：把 wav 文件放到指定目录即可，无需改代码
- **跨平台**：Windows (SoundPlayer) / macOS (afplay) / Linux (paplay/aplay)
- **可配置**：总开关、防抖间隔、音效目录

## 📦 安装

### 方法一：从 GitHub 安装（推荐，无需 npm 账号）

```bash
dsh plugin --profile web add https://github.com/117BS/dsh-perlica-ding
```

安装后**重启 dsh web profile** 生效：

```bash
dsh web restart
```

### 方法二：从 npm 安装（npm 发布后可用）

```bash
dsh plugin --profile web add dsh-perlica-ding
```

### 方法三：本地开发安装

```bash
dsh plugin --profile web add D:\deepseek\dsh-perlica-ding
```

## 🎵 音效文件

**开箱即用**：佩丽卡语音已打包进插件（`sounds/` 目录随包分发），安装后无需任何配置，四个场景各有专属声音：

```
plan.wav   — 计划出方案（"作战计划已确认完毕"）
done.wav   — 任务完成（"任务执行完毕，所有指标正常"）
ask.wav    — 需要你回应（"终端上报：存在待决事项，需要操作员裁决"）
fail.wav   — 出错（"警告：执行异常，任务中断"）（可选）
```

**想换自己的声音**：用 AI 语音合成生成 wav，放到你的**工作区根目录**（或配置的 `soundDir`），同名文件会覆盖内置声音，立即生效无需重启。查找顺序：配置目录 → 工作区 → 包内自带 → 系统回退。

要求：必须是真正的 **WAV** 格式（PCM）。TTS 工具如果导出 MP3，需要转码（可用 ffmpeg：`ffmpeg -i input.mp3 -acodec pcm_s16le plan.wav`）。

## ⚙️ 配置

在 profile 的 `cordis.yml` 或用户 patch 层中配置：

```yaml
plugins:
  dsh-perlica-ding:
    enabled: true        # 总开关
    debounceMs: 2500     # 同档音效最小间隔（毫秒）
    soundDir: ""         # 自定义音效目录，留空则用当前工作区
    execTools: []        # 哪些工具算"执行任务"；空数组 = 所有工具都算（旧行为）
```

## 🧪 验证

安装后随便让 agent 执行一个任务（比如让它调用一次工具），任务完成时应该听到提示音。或者先手动测试声音链路：

```powershell
$p = New-Object Media.SoundPlayer 'D:\deepseek\done.wav'; $p.PlaySync()
```

## 📄 License

MIT
