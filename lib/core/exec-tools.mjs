/**
 * Which tools mean "the agent did work this turn", and therefore which turns
 * earn the `done` sound (BC1/BC3).
 *
 * **Judgment rule.** A tool counts when it produces or changes a side effect
 * outside the conversation itself: writing files, running commands, delegating
 * to other agents, driving terminals, or mutating durable state. Tools that
 * only *read* the world (read / grep / glob / web_* / skill / list_* /
 * cordis_inspect_*) never count, and pure bookkeeping of the current turn
 * (`todo_write`) never counts either — it is called on most turns, so counting
 * it would make the "task done" sound fire for plain conversation.
 *
 * The names are a snapshot of the harness tool registry (0.2 line plus the
 * agent-team extensions). A name that no deployment registers is inert: the
 * whitelist is a filter over observed `tools/result` names, never a tool
 * catalog, so carrying an unregistered name costs nothing at runtime.
 *
 * `execTools: []` keeps the legacy meaning "every tool counts" (BC3) — that
 * escape hatch must stay reachable for users whose deployment registers
 * execution tools this list does not know.
 *
 * Frozen contract: `docs/workstreams/03-plugin-audit.md` BC3 + K6/N6.
 */

/** Tools whose effect reaches outside the conversation. */
export const DEFAULT_EXEC_TOOLS = [
  // Shell and terminal execution.
  'pwsh',
  'bash',
  'terminal_open',
  'terminal_signal',
  'terminal_type',
  'terminal_close',
  // Workspace mutation.
  'write',
  'edit',
  'str_replace_editor',
  'present',
  // Delegation to other agents.
  'subagent',
  'subagent_fork',
  'spawn_teammate',
  'send_message',
  'interrupt_agent',
  'wait_agent',
  'team_task_create',
  'team_task_update',
  'team_task_delete',
  // Workflow and dynamic-plugin execution.
  'workflow',
  'ralph',
  'cordis_define',
  'cordis_run',
  'cordis_stop',
  'cordis_undefine',
  // Background job outcome.
  'job_output',
  'job_kill',
  // Durable goal state (config/ADR §5 keeps these; they persist beyond the turn).
  'create_goal',
  'update_goal',
]

/**
 * Whether one tool name counts as execution for the `done` sound.
 *
 * @param name Tool name as reported by `tools/result`.
 * @param execTools Configured whitelist; an empty array means every tool counts.
 * @returns `true` when this tool should mark the turn as work.
 */
export function isExecutionTool(name, execTools) {
  if (typeof name !== 'string' || name.length === 0) return false
  if (!Array.isArray(execTools) || execTools.length === 0) return true
  return execTools.includes(name)
}
