/**
 * dsh-perlica-ding —— Tiered task-completion sounds for DeepSeek Harness.
 *
 * Plays a distinct sound when an agent turn closes, depending on what the
 * turn was doing:
 *   - plan mode active            -> plan sound (a plan was produced)
 *   - tools were used             -> done sound (a task was executed)
 *   - plain conversation, no tools -> silent
 * Plus two immediate signals:
 *   - ask_user_question tool / approval request -> ask sound (needs your input)
 *   - agent error                              -> fail sound
 *
 * Only root (main conversation) agents trigger sounds; subagents do not
 * beep individually. Each kind has its own debounce window.
 *
 * This file is the native Cordis entry — the Loader imports the package root.
 * The implementation lives in lib/: see docs/adr/0001-persistence-seam.md for the
 * persistence seam, the dual-channel activation guard, and the transport rules.
 */
export { Config, apply, inject, name } from './lib/host/entry-native.mjs'
