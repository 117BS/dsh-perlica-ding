/**
 * The four notification kinds and their user-facing labels.
 *
 * `KINDS` order is the stable enumeration order for UI lists, API payloads and
 * test tables; changing it is a user-visible change, not a refactor.
 *
 * Frozen contract: `docs/adr/0001-persistence-seam.md` §5, `docs/workstreams/03-plugin-audit.md` BC1.
 */

/** Sound kinds, in stable enumeration order. */
export const KINDS = ['plan', 'done', 'ask', 'fail']

/** User-facing labels; locale-specific by design (documented contract, BC1/BC10). */
export const KIND_LABELS = {
  plan: '计划出方案',
  done: '任务完成',
  ask: '需要你回应',
  fail: '出错',
}
