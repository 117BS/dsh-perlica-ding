# dsh-task-ding · Perlica Terminal

> "We are not the ones who state ideals — we are the ones who carry them out."
> —— Perlica, Supervisor of Endfield Industries

![Perlica - Supervisor of Endfield Industries](assets/avatar.png)

🔔 A **Perlica-themed** (Arknights: Endfield) tiered sound notification plugin for DeepSeek Harness.

Perlica reports your agent's status in her calm, concise, terminal-announcement tone: plan ready, task done, needs your input, error — each with its own sound. Plain conversation stays silent. Custom sounds (TTS voice supported) and audible even when the window is in the background.

## 📖 About Perlica

Perlica is the **Supervisor and official spokesperson of Endfield Industries**, an outstanding Protocol Technology specialist who manages the development and application of Protocol Originium technology and the day-to-day operations of the Dreadnought. She handles crises with **decisive calm**, always moving between bases and strongholds for the stable development of Endfield.

This plugin's sound style is inspired by her — **clean, concise, with a touch of technical bureaucracy**, addressing you as 「Administrator」.

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

## 🎙️ Recommended voice lines (Perlica style)

Pick your favorites and generate them with any TTS tool (Edge TTS / CapCut / Azure):

**plan.wav — Plan ready**

> ① "The operation plan is confirmed. Execute accordingly."
> ② "The plan is ready, data complete. Confirm to proceed."
> ③ "Deployment ready. On your confirmation, entering execution phase."

**done.wav — Task done**

> ① "Task executed. All indicators normal."
> ② "Task complete. Results archived. Ready for review."
> ③ "Operation finished, terminal archived. No anomalies this run."

**ask.wav — Needs your input**

> ① "Terminal report: pending decision requires the Administrator's ruling."
> ② "Pending confirmation. This terminal cannot decide. Please instruct."
> ③ "Authorization check failed: this decision exceeds local permissions. Please authorize."

**fail.wav — Error**

> ① "Warning: execution anomaly, task interrupted. Cause recorded. Please inspect."
> ② "Task failed. System halted. Awaiting your instruction."
> ③ "Fault detected: objective not reached. Terminal locked. Please troubleshoot."

**Voice tips**: flat tone, steady pace, clean ending; a slight mechanical pause after statements adds the tech feel.

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
