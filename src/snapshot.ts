/**
 * Snapshot post-processing for `page.ariaSnapshot({ mode: 'ai' })` output.
 * Playwright emits the role tree with `[ref=eN]` markers bound to concrete
 * elements (shadow DOM and same-origin iframes included, iframe refs look
 * like `f1e2`); `aria-ref=<ref>` locators resolve them without any
 * role/name/nth reconstruction, so snapshot order can never misdirect an
 * action. This module only enforces the character budget without splitting
 * a line or leaving a dangling ref marker.
 * @module dsh-pilot/snapshot
 */

/** One processed snapshot. */
export interface SnapshotResult {
  /** Snapshot text, cut at a line boundary within the budget. */
  rendered: string
  /** Count of `[ref=...]` markers present in the kept text. */
  refCount: number
  /** True when lines were dropped to fit the budget. */
  truncated: boolean
}

const REF_MARKER = /\[ref=([a-z0-9]+)\]/g

/**
 * Apply the character budget to a ref-bearing snapshot.
 * @param snapshot - raw `ariaSnapshot({ mode: 'ai' })` text.
 * @param maxChars - character budget for the rendered text.
 * @returns the budgeted text plus ref accounting.
 */
export function buildSnapshot(snapshot: string, maxChars: number): SnapshotResult {
  let rendered = snapshot
  let truncated = false
  if (rendered.length > maxChars) {
    const cut = rendered.lastIndexOf('\n', maxChars)
    rendered = rendered.slice(0, cut > 0 ? cut : maxChars)
    truncated = true
  }
  const refCount = [...rendered.matchAll(REF_MARKER)].length
  return { rendered, refCount, truncated }
}

/**
 * Check that a model-supplied ref has the snapshot marker format
 * (`e12`, `f1e3`, ...), before handing it to the `aria-ref` locator engine.
 * @param ref - the model-supplied ref string.
 * @returns true for plausible refs.
 */
export function isRefShaped(ref: string): boolean {
  return /^(f\d+)*e\d+$/.test(ref)
}
