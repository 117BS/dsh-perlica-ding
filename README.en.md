# dsh-perlica-ding · Perlica Terminal

> "We are not the ones who state ideals — we are the ones who carry them out."
> —— Perlica, Supervisor of Endfield Industries

![Perlica - Supervisor of Endfield Industries](assets/avatar.png)

[简体中文](README.md) | **English**

🔔 A **Perlica-themed** (Arknights: Endfield) tiered sound notification plugin for DeepSeek Harness.

Perlica reports your agent's status in her calm, concise, terminal-announcement tone: plan ready, task done, needs your input, error — each with its own sound. Plain conversation stays silent. Custom sounds (TTS voice supported) and audible even when the window is in the background.

## 📖 About Perlica

Perlica is the **Supervisor and official spokesperson of Endfield Industries**, an outstanding Protocol Technology specialist who manages the development and application of Protocol Originium technology and the day-to-day operations of the Dreadnought. She handles crises with **decisive calm**, always moving between bases and strongholds for the stable development of Endfield.

This plugin's sound style is inspired by her — **clean, concise, with a touch of technical bureaucracy**, addressing you as 「Administrator」.

## ✨ Features

| Scenario | Trigger | Sound file |
|---|---|---|
| 🗂️ Plan ready | Turn closes while plan mode is active | `plan.wav` |
| ✅ Task done | Turn closes and **execution-class tools** were used (file writes / commands / subagents / workflows …) | `done.wav` |
| 💬 Plain chat | No tools used, or only lookup tools (read / web_search …) | Silent |
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
dsh plugin --profile web add dsh-perlica-ding
```

Restart the web profile to activate:

```bash
dsh web restart
```

### From GitHub

```bash
dsh plugin --profile web add https://github.com/117BS/dsh-perlica-ding
```

### Local development

```bash
dsh plugin --profile web add /path/to/dsh-perlica-ding
```

## 🎵 Sound files

Drop these files into your **workspace root** (or the configured `soundDir`); the plugin prefers them and falls back to bundled OS sounds:

```
plan.wav   — plan ready
done.wav   — task done
ask.wav    — needs your input
fail.wav   — error (optional)
```

Requirements:

- Must be real **WAV** (PCM). If your TTS tool exports MP3, convert first: `ffmpeg -i input.mp3 -acodec pcm_s16le plan.wav`
- Fixed filenames as above; replacement takes effect immediately, no restart

## ⚙️ Configuration

In the profile's `cordis.yml` or the user patch layer:

```yaml
plugins:
  dsh-perlica-ding:
    enabled: true        # master switch
    debounceMs: 2500     # min gap between same-kind sounds (ms)
    soundDir: ""         # custom sound dir; empty = workspace root
    execTools: []        # tools that count as "executing a task"; empty = every tool counts (legacy)
```

## 🧪 Verify

Ask the agent to run any task (e.g. call a tool); you should hear a sound when it finishes. Or test the audio chain manually:

```powershell
$p = New-Object Media.SoundPlayer 'D:\deepseek\done.wav'; $p.PlaySync()
```

## 📄 License

MIT
