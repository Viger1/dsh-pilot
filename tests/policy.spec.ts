import { describe, expect, it } from 'vitest'
import {
  assertPositive,
  decideAuthorization,
  mapBlockedError,
  originAllowed,
  parseTarget,
  refusalMessage,
  sessionApprovalPolicy,
} from '../src/policy.js'

const base = { allowedOrigins: [] as string[], newOriginPolicy: 'auto' as const }
const none: ReadonlySet<string> = new Set()
const ask = { approvalPolicy: 'ask' as const, hasApprovalService: true, hasAgent: true }
const never = { approvalPolicy: 'never' as const, hasApprovalService: true, hasAgent: true }

describe('parseTarget', () => {
  it('accepts http and https', () => {
    expect(parseTarget('http://localhost:3000/x').origin).toBe('http://localhost:3000')
    expect(parseTarget('https://example.com/a?b=1').origin).toBe('https://example.com')
  })

  it('rejects non-absolute and non-http targets', () => {
    expect(() => parseTarget('./index.html')).toThrow(/not an absolute URL/)
    expect(() => parseTarget('file:///etc/passwd')).toThrow(/protocol file: is not supported/)
    expect(() => parseTarget('javascript:alert(1)')).toThrow(/not supported/)
  })
})

describe('originAllowed', () => {
  it('always admits local hosts', () => {
    for (const target of ['http://localhost:8080', 'http://127.0.0.1:3000', 'http://[::1]:9000']) {
      expect(originAllowed(parseTarget(target), base, none)).toBe(true)
    }
  })

  it('matches allowlist entries by origin or bare hostname', () => {
    const byOrigin = { ...base, allowedOrigins: ['https://example.com'] }
    expect(originAllowed(parseTarget('https://example.com/page'), byOrigin, none)).toBe(true)
    const byHost = { ...base, allowedOrigins: ['example.com'] }
    expect(originAllowed(parseTarget('https://example.com'), byHost, none)).toBe(true)
  })

  it('does not treat an allowlisted hostname as a suffix or prefix match', () => {
    const config = { ...base, allowedOrigins: ['example.com'] }
    expect(originAllowed(parseTarget('https://evil-example.com'), config, none)).toBe(false)
    expect(originAllowed(parseTarget('https://example.com.evil.test'), config, none)).toBe(false)
    expect(originAllowed(parseTarget('https://sub.example.com'), config, none)).toBe(false)
  })

  it('separates origins by scheme and port', () => {
    const config = { ...base, allowedOrigins: ['https://example.com'] }
    expect(originAllowed(parseTarget('http://example.com'), config, none)).toBe(false)
    expect(originAllowed(parseTarget('https://example.com:8443'), config, none)).toBe(false)
  })

  it('admits an interactively granted origin', () => {
    expect(originAllowed(parseTarget('https://granted.test'), base, new Set(['https://granted.test']))).toBe(true)
  })
})

describe('decideAuthorization', () => {
  const target = parseTarget('https://example.com')

  it('asks when the session prompts and the origin is unknown', () => {
    expect(decideAuthorization(target, base, none, ask)).toEqual({ kind: 'ask' })
  })

  it('exempts the tab — not the origin — for a prompt-free session', () => {
    expect(decideAuthorization(target, base, none, never)).toEqual({ kind: 'allow-unfenced' })
  })

  // The M1 review found this: seeding the shared grant store from a `never`
  // session would unlock the origin for later `ask` sessions, because dsh pins
  // `never` on subagents and users can switch a session back to `ask`.
  it('never turns a prompt-free navigation into a standing grant', () => {
    const grants = new Set<string>()
    const decision = decideAuthorization(target, base, grants, never)
    expect(decision.kind).toBe('allow-unfenced')
    expect(grants.size).toBe(0)
    expect(decideAuthorization(target, base, grants, ask)).toEqual({ kind: 'ask' })
  })

  it('denies without asking under the deny policy, even for a prompt-free session', () => {
    const config = { ...base, newOriginPolicy: 'deny' as const }
    expect(decideAuthorization(target, config, none, never).kind).toBe('deny')
    expect(decideAuthorization(target, config, none, ask).kind).toBe('deny')
  })

  it('passes everything under the allow policy', () => {
    const config = { ...base, newOriginPolicy: 'allow' as const }
    expect(decideAuthorization(target, config, none, ask)).toEqual({ kind: 'allow' })
  })

  it('fails closed with no approval channel or no agent', () => {
    const noService = decideAuthorization(target, base, none, { ...ask, hasApprovalService: false })
    expect(noService.kind).toBe('deny')
    expect(noService.kind === 'deny' && noService.reason).toMatch(/no approval channel/)
    expect(decideAuthorization(target, base, none, { ...ask, hasAgent: false }).kind).toBe('deny')
  })

  it('asks under an explicit ask policy even when the session is prompt-free', () => {
    const config = { ...base, newOriginPolicy: 'ask' as const }
    expect(decideAuthorization(target, config, none, never)).toEqual({ kind: 'ask' })
  })

  it('admits an allowlisted origin without consulting the session', () => {
    const config = { ...base, allowedOrigins: ['https://example.com'] }
    expect(decideAuthorization(target, config, none, { approvalPolicy: undefined, hasApprovalService: false, hasAgent: false }))
      .toEqual({ kind: 'allow' })
  })
})

describe('sessionApprovalPolicy', () => {
  it('returns the last recorded policy', () => {
    expect(sessionApprovalPolicy([
      { type: 'approval/policy', data: { policy: 'never' } },
      { type: 'turn/start' },
      { type: 'approval/policy', data: { policy: 'ask' } },
    ])).toBe('ask')
  })

  it('is undefined when the session never recorded one', () => {
    expect(sessionApprovalPolicy([{ type: 'turn/start' }, { type: 'user/message' }])).toBeUndefined()
    expect(sessionApprovalPolicy([])).toBeUndefined()
  })

  it('treats an unrecognized policy value as unknown rather than guessing', () => {
    expect(sessionApprovalPolicy([{ type: 'approval/policy', data: { policy: 'sometimes' } }])).toBeUndefined()
    expect(sessionApprovalPolicy([{ type: 'approval/policy' }])).toBeUndefined()
  })
})

describe('refusalMessage', () => {
  it('distinguishes a human no from an absent channel and a withdrawn question', () => {
    expect(refusalMessage('https://a.test', 'rejected')).toMatch(/rejected by the user/)
    expect(refusalMessage('https://a.test', 'cancelled')).toMatch(/cancelled before it was answered/)
    expect(refusalMessage('https://a.test', 'unavailable')).toMatch(/no approval channel/)
    // "nobody answered" must not be reported as a decision somebody made.
    expect(refusalMessage('https://a.test', 'unavailable')).not.toMatch(/rejected|decision/i)
    expect(refusalMessage('https://a.test', 'cancelled')).not.toMatch(/rejected|decision/i)
  })
})

describe('mapBlockedError', () => {
  it('explains a fence block in policy terms', () => {
    const mapped = mapBlockedError(new Error('page.goto: net::ERR_BLOCKED_BY_CLIENT at https://x.test'))
    expect(mapped.message).toMatch(/origin fence/)
    expect(mapped.message).toMatch(/allowedOrigins/)
  })

  it('passes other errors through unchanged', () => {
    const original = new Error('net::ERR_CONNECTION_REFUSED')
    expect(mapBlockedError(original)).toBe(original)
    expect(mapBlockedError('plain string').message).toBe('plain string')
  })
})

describe('assertPositive', () => {
  it('accepts positive integers', () => {
    expect(() => assertPositive({ a: 1, b: 15000 })).not.toThrow()
  })

  it('rejects zero, negatives, fractions, and NaN by field name', () => {
    expect(() => assertPositive({ maxTabs: 0 })).toThrow(/maxTabs must be a positive integer/)
    expect(() => assertPositive({ waitMaxMs: -1 })).toThrow(/waitMaxMs/)
    expect(() => assertPositive({ actionTimeoutMs: 1.5 })).toThrow(/actionTimeoutMs/)
    expect(() => assertPositive({ viewportWidth: Number.NaN })).toThrow(/viewportWidth/)
  })
})
