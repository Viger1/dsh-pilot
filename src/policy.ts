/**
 * Pure origin/approval policy decisions, kept out of the tool bodies so the
 * rules that decide where the agent may drive are unit-testable in isolation.
 * @module dsh-pilot/policy
 */

/** Hosts reachable without any configuration; local work is the core use. */
export const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])

/** The policy inputs one decision needs. */
export interface PolicyInput {
  /** Origins (or bare hostnames) that never need asking. */
  allowedOrigins: readonly string[]
  /** Deployment stance for origins outside the allowlist. */
  newOriginPolicy: 'auto' | 'ask' | 'deny' | 'allow'
}

/**
 * Whether the URL passes without asking anyone: local hosts, the configured
 * allowlist, an origin already granted, or the `allow` policy.
 * @param url - parsed navigation target.
 * @param config - the deployment's origin policy inputs.
 * @param approvedOrigins - origins granted interactively this plugin lifetime.
 * @returns true when navigation may proceed silently.
 */
export function originAllowed(url: URL, config: PolicyInput, approvedOrigins: ReadonlySet<string>): boolean {
  return LOCAL_HOSTS.has(url.hostname)
    || config.allowedOrigins.includes(url.origin)
    || config.allowedOrigins.includes(url.hostname)
    || approvedOrigins.has(url.origin)
    || config.newOriginPolicy === 'allow'
}

/**
 * Parse and shape-check a navigation target.
 * @param target - the URL the model asked to open.
 * @returns the parsed http(s) URL.
 * @throws when the target is not an absolute http(s) URL.
 */
export function parseTarget(target: string): URL {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    throw new Error(`target ${JSON.stringify(target)} is not an absolute URL (http/https only)`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`protocol ${url.protocol} is not supported; pilot_navigate opens http(s) pages only`)
  }
  return url
}

/**
 * The session's effective approval policy: the last `approval/policy` event in
 * the log (the official fold — replaying the log IS the state), or undefined
 * when the session never recorded one.
 * @param events - session events in log order.
 * @returns 'ask', 'never', or undefined.
 */
export function sessionApprovalPolicy(events: readonly { type: string; data?: unknown }[]): 'ask' | 'never' | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'approval/policy') {
      const policy = (event.data as { policy?: unknown } | undefined)?.policy
      return policy === 'never' ? 'never' : policy === 'ask' ? 'ask' : undefined
    }
  }
  return undefined
}

/** What the policy decided before any interactive question is asked. */
export type PreAskDecision =
  /** Proceed; the loading tab stays under the network fence. */
  | { kind: 'allow' }
  /**
   * Proceed and exempt the loading tab from the fence for its own lifetime.
   * Used when the session opted out of prompts, so redirects and link-outs
   * inside that tab are not re-gated — without granting the origin to any
   * other session.
   */
  | { kind: 'allow-unfenced' }
  /** Refuse without asking. */
  | { kind: 'deny'; reason: string }
  /** Ask the approval seam; the caller performs the request. */
  | { kind: 'ask' }

/**
 * Decide what to do with a target before involving the approval seam.
 *
 * The `auto` stance reads the session's own durable approval policy: a session
 * running prompt-free (`never`, the `danger-full-access` stance) is not
 * re-gated by this plugin, because asking would auto-reject — the opposite of
 * that stance's intent. That exemption is deliberately tab-scoped rather than
 * an origin grant: dsh pins `never` on subagents and a user may switch back to
 * `ask`, so a standing grant would silently unlock the origin for sessions
 * that never approved it.
 * @param url - parsed navigation target.
 * @param config - the deployment's origin policy inputs.
 * @param approvedOrigins - origins granted interactively this plugin lifetime.
 * @param session - the calling session's stance: its effective approval policy
 *   (undefined when unknown), whether an approval service is composed, and
 *   whether the call carries an agent.
 * @returns the decision to act on.
 */
export function decideAuthorization(
  url: URL,
  config: PolicyInput,
  approvedOrigins: ReadonlySet<string>,
  session: { approvalPolicy: 'ask' | 'never' | undefined; hasApprovalService: boolean; hasAgent: boolean },
): PreAskDecision {
  if (originAllowed(url, config, approvedOrigins)) return { kind: 'allow' }
  if (config.newOriginPolicy === 'deny') {
    return { kind: 'deny', reason: `origin ${JSON.stringify(url.origin)} is not allowed: this deployment denies new origins.` }
  }
  if (config.newOriginPolicy === 'auto' && session.hasAgent && session.approvalPolicy === 'never') {
    return { kind: 'allow-unfenced' }
  }
  if (!session.hasApprovalService || !session.hasAgent) {
    return {
      kind: 'deny',
      reason: `origin ${JSON.stringify(url.origin)} is not allowed and ${NO_CHANNEL_MESSAGE}`,
    }
  }
  return { kind: 'ask' }
}

/** Guidance appended when nothing can answer an approval question. */
export const NO_CHANNEL_MESSAGE = 'no approval channel is available. Ask the user to add the hostname to the dsh-pilot `allowedOrigins` config.'

/**
 * The model-facing error for a non-grant approval outcome. Each outcome reads
 * differently so the model can tell a human "no" from an absent channel or a
 * withdrawn question.
 * @param origin - the refused origin.
 * @param outcome - the approval seam's outcome.
 * @returns the message to throw.
 */
export function refusalMessage(origin: string, outcome: string): string {
  if (outcome === 'rejected') {
    return `origin ${JSON.stringify(origin)} was rejected by the user. `
      + 'Respect the decision; do not retry this origin unless the user asks.'
  }
  if (outcome === 'cancelled') {
    return `the approval question for ${JSON.stringify(origin)} was cancelled before it was answered.`
  }
  return `origin ${JSON.stringify(origin)} is not allowed and ${NO_CHANNEL_MESSAGE}`
}

/**
 * Translate a fence-blocked navigation failure into policy guidance.
 * @param err - the raw playwright error.
 * @returns the error to surface.
 */
export function mapBlockedError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err)
  if (message.includes('ERR_BLOCKED_BY_CLIENT')) {
    return new Error(
      'navigation blocked by the origin fence (a redirect or in-page navigation '
      + 'left the allowed origins). Ask the user to extend `allowedOrigins` if this '
      + 'destination is legitimate.',
    )
  }
  return err instanceof Error ? err : new Error(message)
}

/**
 * Reject non-positive numeric config at load, so misconfiguration fails loud
 * instead of surfacing as confusing playwright timeouts.
 * @param fields - config field name → value.
 * @throws when any field is not a positive integer.
 */
export function assertPositive(fields: Record<string, number>): void {
  for (const [field, value] of Object.entries(fields)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`dsh-pilot config ${field} must be a positive integer, got ${value}`)
    }
  }
}
