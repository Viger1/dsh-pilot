import { describe, expect, it } from 'vitest'
import { buildSnapshot, isRefShaped } from '../src/snapshot.js'

// A real `ariaSnapshot({ mode: 'ai' })` capture of a registration form.
const REAL_SNAPSHOT = `- generic [active] [ref=e1]:
  - heading "用户注册" [level=1] [ref=e2]
  - generic [ref=e3]:
    - text: 用户名
    - textbox "用户名" [ref=e5]
    - combobox "套餐" [ref=e9]:
      - option "免费版" [selected]
      - option "专业版"
    - checkbox "同意服务条款" [ref=e11]
    - button "提交注册" [ref=e12]`

describe('buildSnapshot', () => {
  it('passes a snapshot within budget through unchanged', () => {
    const result = buildSnapshot(REAL_SNAPSHOT, 10000)
    expect(result.rendered).toBe(REAL_SNAPSHOT)
    expect(result.truncated).toBe(false)
  })

  it('counts every ref marker, including iframe-scoped ones', () => {
    expect(buildSnapshot(REAL_SNAPSHOT, 10000).refCount).toBe(7)
    expect(buildSnapshot('- button "x" [ref=f1e3]\n- button "y" [ref=e2]', 10000).refCount).toBe(2)
  })

  it('truncates at a line boundary so no ref marker is left dangling', () => {
    const budget = REAL_SNAPSHOT.indexOf('[ref=e5]') + 4 // mid-marker cut point
    const result = buildSnapshot(REAL_SNAPSHOT, budget)
    expect(result.truncated).toBe(true)
    expect(result.rendered.endsWith('\n')).toBe(false)
    expect(result.rendered).not.toMatch(/\[ref=[a-z0-9]*$/)
    expect(REAL_SNAPSHOT.startsWith(result.rendered)).toBe(true)
  })

  it('reports only the refs the model can actually see', () => {
    const budget = REAL_SNAPSHOT.indexOf('[ref=e5]')
    const result = buildSnapshot(REAL_SNAPSHOT, budget)
    const visible = [...result.rendered.matchAll(/\[ref=/g)].length
    expect(result.refCount).toBe(visible)
    expect(result.refCount).toBeLessThan(7)
  })

  it('still returns something when the first line alone exceeds the budget', () => {
    const result = buildSnapshot('- button "a very long label" [ref=e1]', 10)
    expect(result.truncated).toBe(true)
    expect(result.rendered.length).toBeLessThanOrEqual(10)
  })
})

describe('isRefShaped', () => {
  it('accepts page refs and frame-scoped refs', () => {
    expect(isRefShaped('e1')).toBe(true)
    expect(isRefShaped('e142')).toBe(true)
    expect(isRefShaped('f1e3')).toBe(true)
    expect(isRefShaped('f2f1e10')).toBe(true)
  })

  it('rejects shapes the aria-ref engine would not resolve', () => {
    for (const bad of ['', 'ref-1', 'e', 'E1', '1', 'e1 ', 'e1;click()', 'button', 'f1', 'e1e']) {
      expect(isRefShaped(bad)).toBe(false)
    }
  })
})
