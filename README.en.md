# dsh-perlica-ding · Perlica Terminal

> "We are not the ones who state ideals — we are the ones who carry them out."
> —— Perlica, Supervisor of Endfield Industries

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

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
| ✅ Task done | Turn closes and **execution-class tools** ran (tools that produce or change a side effect outside the conversation: commands / file writes / subagents / workflows / terminals / background jobs …) | `done.wav` |
| 💬 Plain chat | No tools used, or only lookup tools (read / web_search …) | Silent |
| 🙋 Needs your input | `ask_user_question` tool / approval request | `ask.wav` |
| ⚠️ Error | Agent turn errored | `fail.wav` |

Also:

- **Root conversation only**: subagents do not beep individually
- **Debounce**: 2.5s per kind, no sound storms
- **Custom sounds**: drop wav files into the sound dir, no code changes
- **Cross-platform**: Windows (SoundPlayer) / macOS (afplay) / Linux (paplay/aplay)
- **Configurable**: master switch, starting volume, debounce, sound directory, execution-tool whitelist
- **Persistent volume**: what you set in the settings page is stored and survives a restart (see "Persistence and compatibility")

## 📦 Install

### From GitHub (recommended, no npm account needed)

```bash
dsh plugin --profile web add https://github.com/117BS/dsh-perlica-ding
```

Restart the web profile to activate:

```bash
dsh web restart
```

### From npm (once published)

```bash
dsh plugin --profile web add dsh-perlica-ding
```

### Local development

```bash
dsh plugin --profile web add /path/to/dsh-perlica-ding
```

## 🎵 Sound files

**Works out of the box**: the Perlica voice lines ship inside the plugin package (`sounds/` is bundled) — no configuration needed, each scenario has its own sound:

```
plan.wav   — plan ready
done.wav   — task done
ask.wav    — needs your input
fail.wav   — error (optional)
```

**To use your own sounds**: generate wav files with any TTS tool and drop them into the **current session's working directory** (or the configured `soundDir`); same-named files override the bundled ones. The lookup runs again before every playback, so swapping a file needs **no restart**.

Lookup order (first hit wins):

1. the configured `soundDir` (when non-empty)
2. the **current session's working directory** (that session's own cwd; with several sessions running, the one that started first)
3. the `sounds/` bundled in the package
4. OS sounds (picked per platform and per kind — Windows / macOS / Linux differ)

The first three look for `<directory>/<kind>.wav` (`plan.wav` / `done.wav` / `ask.wav` / `fail.wav`). If all four miss, nothing is played — the plugin never hands a non-existent path to the player.

Requirement: must be real **WAV** (PCM). If your TTS tool exports MP3, convert first: `ffmpeg -i input.mp3 -acodec pcm_s16le plan.wav`.

## 🔊 Volume control (with one-click preview)

**Just open Settings**: go to DSH **Settings → 佩丽卡提示音 (Perlica Terminal)** and you get a panel:

```
Volume
[==========|=========]  50%
[Original 100%] [Medium 60%] [Soft 30%] [Mute 0%]

Preview
[Plan ready] [Task done] [Needs input] [Error]
```

- **Drag the slider** or tap a **preset** (0 = silent, 100 = original); on release the value is written to the plugin's **persistent store**, and the next playback uses it
- **A failed save says so**: if the write does not land, the slider returns to the last saved value and the panel shows `保存失败：…` below it — never a "looks saved but isn't"
- The panel tells you whether this environment **can persist at all**: "设置会自动保存并立即生效" when it can, "当前环境无法持久化，重启后恢复默认" when it cannot
- Tap a **preview button** to play that sound right away, so you can find the right level **by ear** instead of guessing
- Previews use the **exact same playback path** as real notifications — what you hear is what you get

> A volume of `0` **skips playback** (mute) rather than playing a silent audio file.

### Suggested levels

| volume | Effect | When |
|---|---|---|
| `100` | Original level | Noisy environment |
| `60` | Slightly quieter | Headphones, quiet room |
| `30` | Soft cue | Late night, library |
| `0` | Fully muted | Temporarily off |

> 💡 **How it works**: the plugin rescales the WAV PCM samples directly (zero dependencies, cross-platform) and **never touches your system volume**. Scaled copies are cached in the system temp directory, computed once per volume.
>
> ⚠️ **Note**: non-PCM audio sources (rare) fall back to the original level.

## ⚙️ Advanced configuration

Config lives in the **profile's `cordis.patch.yml`** (the user patch layer). The shape is a **row array**, with `id` addressing the plugin entry; the plugin's keys sit under `config:`:

```yaml
- id: dsh-perlica-ding
  name: dsh-perlica-ding
  config:
    enabled: true
    volume: 100
    debounceMs: 2500
    soundDir: ""
    execTools: []
```

> ⚠️ Do not put this in `cordis.yml`, and do not write it as a `plugins: { dsh-perlica-ding: {...} }` mapping — neither form works on the current harness. A profile's `cordis.yml` is an **empty entry list**; it only anchors the Loader's mount root, and its own header says to edit `cordis.patch.yml` instead.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. `false` silences all four kinds |
| `volume` | `100` | Starting volume 0-100. **Takes effect only when the plugin cannot persist**; when it can, the saved volume wins (100 when nothing was ever saved). See "Persistence and compatibility" |
| `debounceMs` | `2500` | Minimum gap between two plays of the same kind, in ms, 100-60000. **Each kind has its own window**; a non-numeric value means no limit at all |
| `soundDir` | `""` | Custom sound directory. Empty means "go to the next step" (the current session's working directory) |
| `execTools` | built-in whitelist | Which tools count as "executing a task" — see below |

**How `execTools` is judged**: a tool counts if and only if it **produces or changes a side effect outside the conversation**. Tools that only *read* the world (file reads, grep, glob, web search, listings, `cordis_inspect_*`) never count; neither does bookkeeping like `todo_write`, which runs on almost every turn and would otherwise make plain chat ring the "task done" sound.

The built-in whitelist covers these groups: **command and terminal execution** / **file and deliverable writes** / **subagent and team work** / **workflows and dynamic plugins** / **background job control** / **durable goal state**. It filters **observed tool names**, so it is not a tool catalog: a name listed there but never registered by your deployment costs nothing.

`execTools: []` (empty array) keeps the legacy meaning: **every tool counts as execution**. Use it when your deployment registers execution-class tools the whitelist does not know.

## 💾 Persistence and compatibility

- **Ordered degradation, then fixed**: the volume picks one of three tiers by availability and keeps it for the whole process — **standard storage** (dsh-std's `storage.dsh/v1alpha1 LocalStorage`) → **host storage** (DSH's own `storageDomain` data form) → **local file** (`$DSH_HOME/dsh-perlica-ding/state.json`, written atomically via temp file + rename; `$DSH_HOME` is `~/.dsh` when unset). The current version **wires the last two**: the standard-storage tier needs a std host that provides the protocol, so the plugin declares it **optional** — when it is missing, the store degrades silently instead of failing to load.
- **Failures are not silent**: a rejected write propagates all the way to the settings page and is reported there. A damaged local file (not JSON, root not an object, `volume` not a number) is renamed and kept as `state.json.corrupt-<timestamp>`, then treated as "nothing stored" so the volume falls back to the default (the next save writes a fresh file) — **your existing data is never overwritten**.
- **Why `ctx.settings` is gone**: on the 0.1.5 and 0.2.x lines `ctx.settings` is the **same name with a different shape** (the old line offers `register`, the new one does not). The previous implementation swallowed the error inside its own `try/catch`, which is exactly how "the settings page says saved" got detached from "it is actually stored". The plugin now relies only on the three tiers above and never touches `ctx.settings`.
- **Standard channel (honest current status)**: the package ships a `dsh-plugin.json`, so a host with `@dsh-std/adapter-dsh` installed does discover it and load the host facet — but **that facet cannot run this plugin yet**. A std activation context carries only identity / plan / scope / protocols / extensions, where `scope` is a cleanup scope: it exposes **no product services**, and the notification engine needs exactly those (process spawn, agent-turn events, an HTTP route). dsh-std currently defines no protocol for host-side side effects. So the facet reports `degraded` with the reason — it neither pretends to work nor fails the host's boot (measured: a std-only host boots cleanly with one diagnostic line, whereas letting the facet reach for product services kills the whole boot with `TypeError: ctx.get is not a function`, which is the defect we fixed). Use the bundle entry on a DSH host. Both channels still share one activation path and **one one-shot activation token**, so nothing plays or writes twice.
- **What an uninstall leaves behind**: exactly three places, all declared here —
  1. `$DSH_HOME/storages/perlica_ding.json` (where the host-storage tier writes) or `$DSH_HOME/dsh-perlica-ding/state.json` (the local-file tier, present only when host storage is unavailable);
  2. a derived `state.json.corrupt-<timestamp>` when a file is damaged (kept on purpose instead of overwritten);
  3. `dsh-perlica-ding/` under the system temp directory — the WAV scaling cache, pure derived data you may delete at any time.

  **Uninstalling does not delete your volume**, and the plugin never writes into profile configuration (no entry of its own appears there). To remove every trace, delete 1 and 3 by hand.

## 🧪 Verify

**By hand**: ask the agent to run any task (e.g. call a tool); you should hear a sound when it finishes. Or test the audio chain manually first:

```powershell
$p = New-Object Media.SoundPlayer 'D:\deepseek\done.wav'; $p.PlaySync()
```

**Self-check**:

```bash
npm run verify
```

That is `node --test`, running the cases under `tests/` (no install needed first). These cases **do not mock the thing under test**: the persistence cases round-trip through a **real filesystem** (temporary directories), including "the value is still there for a fresh store instance", "a damaged file is renamed and kept" and "a real write failure is propagated"; the decision and playback cases run against the **real assembly** (the real turn decider, engine and sound lookup order).

> The early `scripts/verify-*.mjs` files were replaced by `tests/` and removed — they checked the plugin against mocks and hid a real persistence defect on a live host. Treat `npm run verify` as the entry point.

## 📄 License

MIT
