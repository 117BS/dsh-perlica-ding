# dsh-task-ding

🔔 Tiered task-completion sounds for DeepSeek Harness: plan ready, task done, needs your input, error — and silent for plain conversation. Customizable sounds (TTS voice supported), audible even when the window is in the background.

> DeepSeek Harness 分级任务提示音插件：任务完成时响一声，普通问答保持安静。

## ✨ Features

| Scenario | Trigger | Sound file |
|---|---|---|
| 🗂️ Plan ready | Turn closes while plan mode is active | `plan.wav` |
| ✅ Task done | Turn closes and tools were used | `done.wav` |
| 💬 Plain chat | No tools used | Silent |
| 🙋 Needs your input | `ask_user_question` tool / approval request | `ask.wav` |
| ⚠️ Error | Agent turn errored | `fail.wav` |

Also:

- **Root conversation only**: subagents do not beep individually
- **Debounce**: 2.5s per kind, no sound storms
- **Custom sounds**: drop wav files into the sound dir, no code changes
- **Cross-platform**: Windows (SoundPlayer) / macOS (afplay) / Linux (paplay/aplay)
- **Configurable**: master switch, debounce, sound directory

## 📦 Install

### From npm (recommended)

```bash
dsh plugin --profile web add dsh-task-ding
```

Restart the web profile to activate:

```bash
dsh web restart
```

### From GitHub

```bash
dsh plugin --profile web add https://github.com/<your-username>/dsh-task-ding
```

### Local development

```bash
dsh plugin --profile web add /path/to/dsh-task-ding
```

## 🎵 Sound files

Drop these files into your **workspace root** (or the configured `soundDir`); the plugin prefers them and falls back to bundled OS sounds:

```
plan.wav   — plan ready (e.g. "Plan is ready, please review.")
done.wav   — task done (e.g. "Task completed, please verify.")
ask.wav    — needs your input (e.g. "I need your answer.")
fail.wav   — error (e.g. "Something went wrong.") (optional)
```

Requirements:

- Must be real **WAV** (PCM). If your TTS tool exports MP3, convert first: `ffmpeg -i input.mp3 -acodec pcm_s16le plan.wav`
- Fixed filenames as above; replacement takes effect immediately, no restart

## ⚙️ Configuration

In the profile's `cordis.yml` or the user patch layer:

```yaml
plugins:
  dsh-task-ding:
    enabled: true        # master switch
    debounceMs: 2500     # min gap between same-kind sounds (ms)
    soundDir: ""         # custom sound dir; empty = workspace root
```

## 🧪 Verify

Ask the agent to run any task (e.g. call a tool); you should hear a sound when it finishes. Or test the audio chain manually:

```powershell
$p = New-Object Media.SoundPlayer 'D:\deepseek\done.wav'; $p.PlaySync()
```

## 📄 License

MIT
