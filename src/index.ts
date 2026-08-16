/**
 * dsh-pilot — hands for a DeepSeek Harness agent. Registers browser-operation
 * tools (`pilot_navigate`, `pilot_snapshot`, `pilot_act`, `pilot_wait`,
 * `pilot_screenshot`, `pilot_close`) built around playwright's ref-bearing
 * accessibility snapshots: the page is read as a role tree whose `[ref=eN]`
 * markers bind to concrete elements (shadow DOM and same-origin iframes
 * included), and actions target refs through the `aria-ref` locator engine,
 * so a text-only model operates real pages without vision, CSS selectors, or
 * order-sensitive reconstruction. Local hosts work out of the box; other
 * origins pass a network-layer fence that also covers redirects, link clicks,
 * and history moves (dsh approval-seam integration lands in M1).
 * Named exports preserve loader injection metadata.
 * @module dsh-pilot
 */

import { mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'
import { Engine, raceAbort, throwIfAborted, type TrackedPage } from './engine.js'
import { buildSnapshot, isRefShaped } from './snapshot.js'

export const name = 'pilot'
export const inject = ['tools']

/** Hosts reachable without any configuration; local work is the core use. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Deployment configuration; every tunable is a cordis.yml field. */
export interface Config {
  /** Run the browser without a visible window. */
  headless: boolean
  /** Browser channels tried in order until one launches. */
  browserChannels: string[]
  /** Viewport width in px. */
  viewportWidth: number
  /** Viewport height in px. */
  viewportHeight: number
  /** Navigation timeout, in milliseconds. */
  navigationTimeoutMs: number
  /** Per-action timeout, in milliseconds. */
  actionTimeoutMs: number
  /** Upper bound for one pilot_wait, in milliseconds; model overrides are clamped to it. */
  waitMaxMs: number
  /** Character budget for one snapshot. */
  snapshotMaxChars: number
  /** Maximum simultaneously open tabs. */
  maxTabs: number
  /** Origins (or bare hostnames) pilot_navigate may always visit. */
  allowedOrigins: string[]
  /**
   * Policy for origins outside `allowedOrigins` and local hosts:
   * `auto` follows the dsh session's permission stance (M1; refuses in M0),
   * `ask` requests interactive approval (M1; refuses in M0),
   * `deny` refuses, `allow` passes silently and disables the network fence.
   */
  newOriginPolicy: 'auto' | 'ask' | 'deny' | 'allow'
  /** Permit typing into password fields (credential-hygiene gate). */
  allowPasswordFields: boolean
  /** Persistent profile directory; empty = fresh isolated context per run. */
  profileDir: string
  /** Directory screenshots are written to, resolved against the working directory. */
  screenshotDir: string
  /** Directory downloads are saved into, resolved against the working directory. */
  downloadDir: string
  /** Maximum console messages retained per tab. */
  maxConsoleMessages: number
  /** Register the bundled `browser-pilot` skill when the skill seam is composed. */
  registerSkill: boolean
}

/** Schemastery schema for {@link Config}. */
export const Config: z<Config> = z.object({
  headless: z.boolean().default(true),
  browserChannels: z.array(z.string()).default(['chrome', 'msedge', 'chromium']),
  viewportWidth: z.number().default(1280),
  viewportHeight: z.number().default(800),
  navigationTimeoutMs: z.number().default(15000),
  actionTimeoutMs: z.number().default(5000),
  waitMaxMs: z.number().default(60000),
  snapshotMaxChars: z.number().default(24000),
  maxTabs: z.number().default(8),
  allowedOrigins: z.array(z.string()).default([]),
  newOriginPolicy: z.union(['auto', 'ask', 'deny', 'allow'] as const).default('auto'),
  allowPasswordFields: z.boolean().default(false),
  profileDir: z.string().default(''),
  screenshotDir: z.string().default('.dsh-pilot'),
  downloadDir: z.string().default('.dsh-pilot/downloads'),
  maxConsoleMessages: z.number().default(100),
  registerSkill: z.boolean().default(true),
})

/**
 * Whether the URL passes without asking anyone: local hosts, the configured
 * allowlist, a session-granted origin, or the `allow` policy.
 * @param url - parsed navigation target.
 * @param config - deployment configuration.
 * @param approvedOrigins - origins granted interactively this plugin lifetime.
 * @returns true when navigation may proceed silently.
 */
function originAllowed(url: URL, config: Config, approvedOrigins: ReadonlySet<string>): boolean {
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
 */
function parseTarget(target: string): URL {
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
 * The session's effective approval policy: the last `approval/policy` event
 * in the log (the official fold — replaying the log IS the state), or
 * undefined when the session never recorded one.
 * @param events - session events in log order.
 * @returns 'ask', 'never', or undefined.
 */
function sessionApprovalPolicy(events: readonly { type: string; data?: unknown }[]): 'ask' | 'never' | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'approval/policy') {
      const policy = (event.data as { policy?: unknown } | undefined)?.policy
      return policy === 'never' ? 'never' : policy === 'ask' ? 'ask' : undefined
    }
  }
  return undefined
}

/** The approval seam surface this plugin consumes (structural, optional service). */
interface ApprovalLike {
  config?: { policy?: string }
  request(req: {
    agent: unknown
    toolName: string
    callId?: unknown
    reason?: string
    signal?: AbortSignal
  }): Promise<string>
}

/**
 * Translate a fence-blocked navigation failure into policy guidance.
 * @param err - the raw playwright error.
 * @returns the error to surface.
 */
function mapBlockedError(err: unknown): Error {
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
 */
function assertPositive(fields: Record<string, number>): void {
  for (const [field, value] of Object.entries(fields)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`dsh-pilot config ${field} must be a positive integer, got ${value}`)
    }
  }
}

/** Canonical pilot_navigate result. */
interface NavigateResult {
  pageId: string
  url: string
  title: string
  errors: string[]
  tabs: { id: string; url: string; current: boolean }[]
}

/**
 * Assemble the shared navigate result for one finished navigation.
 * @param engine - the tab registry (for the tab list).
 * @param tracked - the tab that navigated.
 * @param seqBefore - console seq before the navigation started.
 * @returns the canonical navigate result.
 */
async function navigateReport(engine: Engine, tracked: TrackedPage, seqBefore: number): Promise<NavigateResult> {
  return {
    pageId: tracked.id,
    url: tracked.page.url(),
    title: await tracked.page.title(),
    errors: tracked.console
      .filter(entry => entry.seq > seqBefore && entry.level === 'error')
      .map(entry => entry.text)
      .slice(0, 10),
    tabs: engine.list(),
  }
}

/** Tab summary shared by navigate/close outputs. */
const TABS_SCHEMA = {
  type: 'array',
  required: true,
  description: 'All open tabs.',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', required: true },
      url: { type: 'string', required: true },
      current: { type: 'boolean', required: true },
    },
  },
} as const

/**
 * Register the pilot tools and (optionally) the bundled `browser-pilot` skill.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - deployment configuration.
 */
export function apply(ctx: Context, config: Config): void {
  /** Origins granted through the approval seam; feeds the fence and the gate. */
  const approvedOrigins = new Set<string>()

  /** What authorizing a target implies for the tab that will load it. */
  type Authorization = 'fenced' | 'unfenced'

  const NO_CHANNEL_MESSAGE = 'no approval channel is available. Ask the user to add the hostname to the dsh-pilot `allowedOrigins` config.'

  /**
   * Authorize one navigation target, asking through the dsh approval seam
   * when the session's stance calls for it.
   *
   * A session that opted out of prompts (approval policy `never`, the
   * `danger-full-access` stance) is not re-gated by this plugin: its
   * navigation is authorized and its tab runs unfenced for that tab's
   * lifetime. That exemption deliberately does NOT enter `approvedOrigins`,
   * because a plugin-lifetime grant would outlive the stance and silently
   * unlock the origin for later `ask` sessions and for a parent agent whose
   * subagents run prompt-free.
   * @param url - parsed target.
   * @param exec - the tool execution (agent, callId, signal).
   * @returns whether the loading tab should bypass the network fence.
   */
  async function authorizeOrigin(url: URL, exec: { agent?: unknown; callId?: unknown; signal: AbortSignal }): Promise<Authorization> {
    if (originAllowed(url, config, approvedOrigins)) return 'fenced'
    if (config.newOriginPolicy === 'deny') {
      throw new Error(`origin ${JSON.stringify(url.origin)} is not allowed: this deployment denies new origins.`)
    }
    const approval = ctx.get('approval') as ApprovalLike | undefined
    const agent = exec.agent as { session?: { events?: readonly { type: string; data?: unknown }[] } } | undefined
    if (config.newOriginPolicy === 'auto' && exec.agent) {
      // The user's stance, read from the session's own durable knobs. Asking
      // a `never` session would auto-reject — the opposite of its intent.
      const events = agent?.session?.events
      const effective = (events ? sessionApprovalPolicy(events) : undefined)
        ?? (approval?.config?.policy === 'never' ? 'never' : 'ask')
      if (effective === 'never') return 'unfenced'
    }
    if (!approval || !exec.agent) {
      throw new Error(`origin ${JSON.stringify(url.origin)} is not allowed and ${NO_CHANNEL_MESSAGE}`)
    }
    const outcome = await approval.request({
      agent: exec.agent,
      toolName: 'pilot_navigate',
      callId: exec.callId,
      reason: `Navigate the pilot browser to ${url.origin} (outside the configured allowed origins).`,
      signal: exec.signal,
    })
    if (outcome === 'allowed-once') {
      approvedOrigins.add(url.origin)
      return 'fenced'
    }
    // Distinguish a human "no" from an absent channel or a withdrawn
    // question, so the model reacts to what actually happened.
    if (outcome === 'rejected') {
      throw new Error(
        `origin ${JSON.stringify(url.origin)} was rejected by the user. `
        + 'Respect the decision; do not retry this origin unless the user asks.',
      )
    }
    if (outcome === 'cancelled') {
      throw new Error(`the approval question for ${JSON.stringify(url.origin)} was cancelled before it was answered.`)
    }
    throw new Error(`origin ${JSON.stringify(url.origin)} is not allowed and ${NO_CHANNEL_MESSAGE}`)
  }

  assertPositive({
    viewportWidth: config.viewportWidth,
    viewportHeight: config.viewportHeight,
    navigationTimeoutMs: config.navigationTimeoutMs,
    actionTimeoutMs: config.actionTimeoutMs,
    waitMaxMs: config.waitMaxMs,
    snapshotMaxChars: config.snapshotMaxChars,
    maxTabs: config.maxTabs,
    maxConsoleMessages: config.maxConsoleMessages,
  })
  const engine = new Engine({
    channels: config.browserChannels,
    headless: config.headless,
    viewportWidth: config.viewportWidth,
    viewportHeight: config.viewportHeight,
    maxConsoleMessages: config.maxConsoleMessages,
    maxTabs: config.maxTabs,
    profileDir: config.profileDir,
    downloadDir: resolve(config.downloadDir),
    // With policy `allow` the fence is pointless overhead; every other policy
    // gets network-layer enforcement so redirects and link clicks cannot
    // drift past the entry gate. Interactive grants join `approvedOrigins`
    // and are thereby admitted here too.
    ...(config.newOriginPolicy === 'allow' ? {} : { originAllowed: (url: URL) => originAllowed(url, config, approvedOrigins) }),
  })
  ctx.effect(() => async () => {
    await engine.dispose()
  })

  if (config.registerSkill) {
    ctx.inject(['skills'], (skillCtx) => {
      skillCtx.skills.registerProvider(() => browserPilotProvider)
    })
  }

  ctx.tools.register(defineTool({
    name: 'pilot_navigate',
    description:
      'Drive the browser to a page: goto a URL (optionally in a new tab), or go '
      + 'back/forward/reload on the current tab. Local hosts are always allowed; other '
      + 'origins pass the deployment\'s origin policy — depending on the session\'s '
      + 'permission stance this may ask the user for one-time approval — and the '
      + 'decision is enforced at the network layer (redirects and link-outs included). '
      + 'Returns load-time console errors and the open-tab list. After every '
      + 'navigation, call pilot_snapshot before acting — old refs are stale.',
    // Budget covers the worst case: cold browser launch plus both navigation
    // attempts (load, then the domcontentloaded fallback).
    timeoutMs: 2 * config.navigationTimeoutMs + 30000,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['goto', 'back', 'forward', 'reload'],
        description: 'goto opens `url`; back/forward/reload act on the current tab.',
      },
      url: { type: 'string', description: 'Absolute http(s) URL; required for goto.' },
      newTab: { type: 'boolean', description: 'goto only: open in a new tab instead of the current one.' },
      pageId: { type: 'string', description: 'Tab to act on; defaults to the current tab.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pageId: { type: 'string', required: true },
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          errors: {
            type: 'array',
            required: true,
            description: 'Console errors raised during this navigation (up to 10).',
            items: { type: 'string' },
          },
          tabs: TABS_SCHEMA,
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.pageId} is at ${value.url} (title: ${JSON.stringify(value.title)}). `
          + (value.errors.length === 0 ? 'No console errors.' : `Console errors:\n${value.errors.join('\n')}`)
          + (value.tabs.length > 1 ? `\nOpen tabs: ${value.tabs.map(t => `${t.id}${t.current ? '*' : ''}`).join(', ')}` : ''),
      }],
    },
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      if (args.action === 'goto') {
        if (args.url === undefined) throw new Error('action `goto` requires `url`')
        const url = parseTarget(args.url)
        const authorization = await authorizeOrigin(url, exec)
        const freshTab = args.newTab === true || engine.list().length === 0
        const tracked = freshTab ? await engine.newTab() : engine.get(args.pageId)
        if (authorization === 'unfenced') tracked.unfenced = true
        let seqBefore = tracked.lastSeq
        // Closing the page is what actually interrupts an in-flight goto when
        // the tool execution is cancelled.
        const closeOnAbort = (): void => {
          void tracked.page.close().catch(() => { /* already closed; abort still wins the race */ })
        }
        exec.signal.addEventListener('abort', closeOnAbort, { once: true })
        try {
          await raceAbort(exec.signal, tracked.page.goto(url.href, { timeout: config.navigationTimeoutMs, waitUntil: 'load' })
            .catch(async (err: unknown) => {
              const message = err instanceof Error ? err.message : String(err)
              if (exec.signal.aborted || message.includes('ERR_BLOCKED_BY_CLIENT')) {
                throw err instanceof Error ? err : new Error(message)
              }
              // Long-polling pages may never fire `load`; the DOM is usable
              // after domcontentloaded, so retry once with the weaker
              // milestone. The failed attempt's captures are stale.
              seqBefore = tracked.lastSeq
              tracked.failures.length = 0
              return tracked.page.goto(url.href, { timeout: config.navigationTimeoutMs, waitUntil: 'domcontentloaded' })
            }))
        } catch (err) {
          if (freshTab) await engine.discard(tracked.id)
          throw exec.signal.aborted ? new Error('cancelled while loading the page') : mapBlockedError(err)
        } finally {
          exec.signal.removeEventListener('abort', closeOnAbort)
        }
        return navigateReport(engine, tracked, seqBefore)
      }
      const tracked = engine.get(args.pageId)
      const seqBefore = tracked.lastSeq
      const options = { timeout: config.navigationTimeoutMs }
      try {
        if (args.action === 'back') await raceAbort(exec.signal, tracked.page.goBack(options))
        else if (args.action === 'forward') await raceAbort(exec.signal, tracked.page.goForward(options))
        else await raceAbort(exec.signal, tracked.page.reload(options))
      } catch (err) {
        throw mapBlockedError(err)
      }
      return navigateReport(engine, tracked, seqBefore)
    },
    presentCall: args => ({
      card: 'generic',
      title: args.action === 'goto' ? `Open ${args.url ?? ''}` : `Browser ${args.action}`,
      kind: 'read',
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'pilot_snapshot',
    description:
      'Read the current page as an accessibility tree with element refs. Interactive '
      + 'elements carry `[ref=e12]` markers (iframe content looks like `f1e3`); act on '
      + 'them with pilot_act. This is how you SEE the page — call it after every '
      + 'navigation and after any action that changed the page, and never reuse refs '
      + 'across navigations.',
    timeoutMs: config.actionTimeoutMs + 10000,
    parameters: {
      pageId: { type: 'string', description: 'Tab to read; defaults to the current tab.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          snapshot: { type: 'string', required: true, description: 'Role tree with [ref=...] markers.' },
          refCount: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.snapshot + (value.truncated ? '\n[truncated: page tree exceeds the snapshot budget]' : ''),
      }],
    },
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      const tracked = engine.get(args.pageId)
      const raw = await raceAbort(exec.signal, tracked.page.ariaSnapshot({ mode: 'ai', timeout: config.actionTimeoutMs }))
      const result = buildSnapshot(raw, config.snapshotMaxChars)
      tracked.snapshotTaken = true
      tracked.refsStale = false
      return { snapshot: result.rendered, refCount: result.refCount, truncated: result.truncated }
    },
    presentCall: args => ({ card: 'generic', title: 'Read page structure', kind: 'read', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'pilot_act',
    description:
      'Act on a ref from the latest pilot_snapshot: click, type (fills text), press a '
      + 'key, hover, select a combobox option, check/uncheck, or upload workspace '
      + 'files to a file input. Refs go stale after any navigation — re-snapshot '
      + 'first. Returns console errors the action caused and whether it navigated.',
    // Budget covers the password probe plus the action, each actionTimeoutMs.
    timeoutMs: 2 * config.actionTimeoutMs + 10000,
    parameters: {
      ref: { type: 'string', required: true, description: 'A ref from the latest snapshot, e.g. e12 or f1e3.' },
      action: {
        type: 'string',
        required: true,
        enum: ['click', 'type', 'press', 'hover', 'select', 'check', 'uncheck', 'upload'],
        description: 'click | type (needs text) | press (needs key) | hover | select (needs option) | check | uncheck | upload (needs files, targets a file input).',
      },
      text: { type: 'string', description: 'Text for `type`.' },
      key: { type: 'string', description: 'Key for `press`, e.g. Enter, Escape, ArrowDown.' },
      option: { type: 'string', description: 'Visible option label for `select`.' },
      files: {
        type: 'array',
        description: 'Workspace-relative file paths for `upload`.',
        items: { type: 'string' },
      },
      pageId: { type: 'string', description: 'Tab to act on; defaults to the current tab.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          target: { type: 'string', required: true, description: 'The acted element (tag plus visible label).' },
          navigated: { type: 'boolean', required: true, description: 'True when the action changed the page; re-snapshot before further acts.' },
          url: { type: 'string', required: true },
          newErrors: {
            type: 'array',
            required: true,
            description: 'Console errors raised by this action (up to 10).',
            items: { type: 'string' },
          },
          downloads: {
            type: 'array',
            required: true,
            description: 'Downloads this action produced: saved path, or the failure reason.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string' },
                error: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.action} on ${value.target} done.`
          + (value.navigated ? ` Page navigated to ${value.url} — refs are stale, snapshot again.` : '')
          + (value.newErrors.length === 0 ? ' No new console errors.' : `\nNew console errors:\n${value.newErrors.join('\n')}`)
          + (value.downloads.length === 0
            ? ''
            : '\n' + value.downloads.map(d => d.path ? `[download] saved to ${d.path}` : `[download] failed: ${d.error ?? 'unknown'}`).join('\n')),
      }],
    },
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      const tracked = engine.get(args.pageId)
      if (!tracked.snapshotTaken) throw new Error('no snapshot for this tab yet; call pilot_snapshot first')
      if (tracked.refsStale) throw new Error('refs are stale (the page navigated); call pilot_snapshot again')
      if (!isRefShaped(args.ref)) {
        throw new Error(`ref ${JSON.stringify(args.ref)} does not look like a snapshot ref (expected e.g. e12 or f1e3)`)
      }
      const locator = tracked.page.locator(`aria-ref=${args.ref}`)
      const timeout = config.actionTimeoutMs
      const seqBefore = tracked.lastSeq
      const urlBefore = tracked.page.url()
      const guardPassword = !config.allowPasswordFields && (args.action === 'type' || args.action === 'press')
      if (guardPassword) {
        const isPassword = await raceAbort(exec.signal, locator.evaluate(
          el => el instanceof HTMLInputElement && el.type === 'password',
          undefined,
          { timeout },
        ))
        if (isPassword) {
          throw new Error(
            'refusing to enter characters into a password field (credential hygiene). '
            + 'Ask the user to log in manually, or the deployment to set allowPasswordFields: true.',
          )
        }
      }
      const described = await raceAbort(exec.signal, locator.evaluate(
        (el) => {
          const label = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60)
          return el.tagName.toLowerCase() + (label ? ` ${JSON.stringify(label)}` : '')
        },
        undefined,
        { timeout },
      ).catch(() => args.ref))
      if (args.action === 'type') {
        if (args.text === undefined) throw new Error('action `type` requires `text`')
        await raceAbort(exec.signal, locator.fill(args.text, { timeout }))
      } else if (args.action === 'click') {
        await raceAbort(exec.signal, locator.click({ timeout }))
      } else if (args.action === 'press') {
        if (args.key === undefined) throw new Error('action `press` requires `key`')
        await raceAbort(exec.signal, locator.press(args.key, { timeout }))
      } else if (args.action === 'hover') {
        await raceAbort(exec.signal, locator.hover({ timeout }))
      } else if (args.action === 'select') {
        if (args.option === undefined) throw new Error('action `select` requires `option`')
        await raceAbort(exec.signal, locator.selectOption({ label: args.option }, { timeout }))
      } else if (args.action === 'upload') {
        if (args.files === undefined || args.files.length === 0) throw new Error('action `upload` requires `files`')
        // Canonicalize both sides before comparing: a lexical check passes a
        // workspace symlink pointing at host files, and setInputFiles would
        // then read the real target.
        const workspace = await realpath(process.cwd())
        const prefix = workspace.endsWith(sep) ? workspace : workspace + sep
        const resolved: string[] = []
        for (const file of args.files) {
          const real = await realpath(resolve(workspace, file)).catch(() => {
            throw new Error(`upload refused: ${JSON.stringify(file)} does not exist`)
          })
          if (!real.startsWith(prefix)) {
            throw new Error(`upload refused: ${JSON.stringify(file)} resolves outside the workspace`)
          }
          const info = await stat(real)
          if (!info.isFile()) {
            throw new Error(`upload refused: ${JSON.stringify(file)} is not a regular file`)
          }
          resolved.push(real)
        }
        await raceAbort(exec.signal, locator.setInputFiles(resolved, { timeout }))
      } else if (args.action === 'check') {
        await raceAbort(exec.signal, locator.check({ timeout }))
      } else {
        await raceAbort(exec.signal, locator.uncheck({ timeout }))
      }
      // Give handlers a tick to run so their console errors are captured.
      // Downloads settle asynchronously: an upload/click that starts one is
      // reported here when it lands within the tick, otherwise by the next
      // tool call that reads past this seq.
      await tracked.page.waitForTimeout(100)
      return {
        action: args.action,
        target: described,
        navigated: tracked.refsStale || tracked.page.url() !== urlBefore,
        url: tracked.page.url(),
        newErrors: tracked.console
          .filter(entry => entry.seq > seqBefore && entry.level === 'error')
          .map(entry => entry.text)
          .slice(0, 10),
        downloads: tracked.downloads
          .filter(entry => entry.seq > seqBefore)
          .map(entry => entry.path !== undefined ? { path: entry.path } : { error: entry.error ?? 'unknown' }),
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `${args.action} ${args.ref}`,
      kind: 'execute',
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'pilot_wait',
    description:
      'Wait for a page condition instead of retrying blindly: a CSS selector '
      + 'appearing, visible text appearing, the URL containing a fragment, or network '
      + 'idle. Returns satisfied: false when the condition is not met in time.',
    timeoutMs: config.waitMaxMs + 5000,
    parameters: {
      for: {
        type: 'string',
        required: true,
        enum: ['selector', 'text', 'url', 'networkidle'],
        description: 'Condition kind.',
      },
      value: { type: 'string', description: 'Selector, text, or URL fragment; unused for networkidle.' },
      timeoutMs: { type: 'number', description: 'Wait budget for this call; capped by the deployment\'s waitMaxMs.' },
      pageId: { type: 'string', description: 'Tab to watch; defaults to the current tab.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          satisfied: { type: 'boolean', required: true },
          elapsedMs: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.satisfied
          ? `Condition satisfied after ${value.elapsedMs}ms.`
          : `Condition NOT met within ${value.elapsedMs}ms.`,
      }],
    },
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      const tracked = engine.get(args.pageId)
      if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
        throw new Error(`timeoutMs must be a positive number, got ${args.timeoutMs}`)
      }
      const timeout = Math.min(args.timeoutMs ?? config.navigationTimeoutMs, config.waitMaxMs)
      const started = Date.now()
      try {
        if (args.for === 'selector') {
          if (args.value === undefined) throw new Error('wait `selector` requires `value`')
          await raceAbort(exec.signal, tracked.page.locator(args.value).first().waitFor({ state: 'visible', timeout }))
        } else if (args.for === 'text') {
          if (args.value === undefined) throw new Error('wait `text` requires `value`')
          await raceAbort(exec.signal, tracked.page.getByText(args.value).first().waitFor({ state: 'visible', timeout }))
        } else if (args.for === 'url') {
          if (args.value === undefined) throw new Error('wait `url` requires `value`')
          const fragment = args.value
          await raceAbort(exec.signal, tracked.page.waitForURL(url => url.href.includes(fragment), { timeout }))
        } else {
          await raceAbort(exec.signal, tracked.page.waitForLoadState('networkidle', { timeout }))
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'TimeoutError') {
          return { satisfied: false, elapsedMs: Date.now() - started }
        }
        throw err
      }
      return { satisfied: true, elapsedMs: Date.now() - started }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Wait for ${args.for}${args.value ? `: ${args.value}` : ''}`,
      kind: 'other',
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'pilot_screenshot',
    description:
      'Capture a PNG of the current tab (viewport or full page) into the screenshot '
      + 'directory, for the human reviewing the session. Machine verification should '
      + 'use pilot_snapshot and console errors instead.',
    timeoutMs: config.actionTimeoutMs + 10000,
    parameters: {
      fullPage: { type: 'boolean', description: 'Capture the full scrollable page instead of the viewport.' },
      pageId: { type: 'string', description: 'Tab to capture; defaults to the current tab.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true, description: 'Saved PNG path.' },
          pageId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Screenshot of ${value.pageId} saved to ${value.path}` }],
    },
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      const tracked = engine.get(args.pageId)
      const dir = resolve(config.screenshotDir)
      await mkdir(dir, { recursive: true })
      const path = resolve(dir, `${tracked.id}-${Date.now()}.png`)
      await raceAbort(exec.signal, tracked.page.screenshot({ path, fullPage: args.fullPage === true, timeout: config.actionTimeoutMs }))
      return { path, pageId: tracked.id }
    },
    presentCall: args => ({ card: 'generic', title: 'Screenshot tab', kind: 'read', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'pilot_close',
    description: 'Close a tab. Close tabs you are done with; the tab limit is deployment-configured.',
    timeoutMs: config.actionTimeoutMs + 5000,
    parameters: {
      pageId: { type: 'string', description: 'Tab to close; defaults to the current tab.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          closed: { type: 'string', required: true },
          tabs: TABS_SCHEMA,
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Closed ${value.closed}. ${value.tabs.length === 0 ? 'No tabs open.' : `Open tabs: ${value.tabs.map(t => t.id).join(', ')}`}`,
      }],
    },
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      const closed = await raceAbort(exec.signal, engine.close(args.pageId))
      return { closed, tabs: engine.list() }
    },
    presentCall: args => ({ card: 'generic', title: 'Close tab', kind: 'other', rawInput: args }),
  }))
}

const SKILL_BODY_URL = new URL('../skills/browser-pilot/SKILL.md', import.meta.url)
const SKILL_RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../skills/browser-pilot/', import.meta.url)),
} as const
const SKILL_INVOCATION = { modelInvocable: true, userInvocable: true } as const
const SKILL_DESCRIPTION =
  'Operate web pages with the pilot_* tools: navigate, snapshot the page as refs, '
  + 'act on refs, wait for conditions, and re-snapshot after every navigation. Use '
  + 'for testing flows, filling forms, and driving sites the user asked you to work on.'

const SKILL_CANDIDATE: SkillCandidate = {
  name: 'browser-pilot',
  description: SKILL_DESCRIPTION,
  invocation: SKILL_INVOCATION,
  provider: 'dsh-pilot',
  source: 'bundled',
  resourceBase: SKILL_RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_BODY_URL,
}

/** Bundled skill provider serving the browser-pilot workflow. */
const browserPilotProvider: SkillProvider = {
  name: 'dsh-pilot',
  list: () => Promise.resolve([SKILL_CANDIDATE]),
  async get(_candidate): Promise<SkillDefinition> {
    return {
      name: SKILL_CANDIDATE.name,
      description: SKILL_CANDIDATE.description,
      invocation: SKILL_CANDIDATE.invocation,
      provider: SKILL_CANDIDATE.provider,
      source: SKILL_CANDIDATE.source,
      resourceBase: SKILL_RESOURCE_BASE,
      content: await readFile(SKILL_BODY_URL, 'utf8'),
    }
  },
}
