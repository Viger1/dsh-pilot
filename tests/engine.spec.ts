import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { Engine, type EngineOptions } from '../src/engine.js'

// Stand-in for a real playwright BrowserContext: the engine only needs
// `on('close')`, `browser()`, and a way to fire the close event.
class FakeContext extends EventEmitter {
  browser(): null {
    return null
  }

  async close(): Promise<void> {
    this.emit('close')
  }
}

const OPTIONS: EngineOptions = {
  channels: ['chromium'],
  headless: true,
  viewportWidth: 800,
  viewportHeight: 600,
  maxConsoleMessages: 10,
  maxTabs: 2,
  profileDir: '',
  downloadDir: '.',
}

/** Swap the real launch for fake contexts, counting how many times it ran. */
function withFakeLauncher(engine: Engine): FakeContext[] {
  const contexts: FakeContext[] = []
  const internals = engine as unknown as { launchContext: () => Promise<FakeContext> }
  internals.launchContext = async () => {
    const context = new FakeContext()
    contexts.push(context)
    return context
  }
  return contexts
}

function ensure(engine: Engine): Promise<unknown> {
  return (engine as unknown as { ensureContext: () => Promise<unknown> }).ensureContext()
}

describe('Engine context lifecycle', () => {
  it('keeps reusing one context while it stays open', async () => {
    const engine = new Engine(OPTIONS)
    const contexts = withFakeLauncher(engine)
    expect(await ensure(engine)).toBe(contexts[0])
    expect(await ensure(engine)).toBe(contexts[0])
    expect(contexts).toHaveLength(1)
  })

  it('relaunches after the context closes', async () => {
    const engine = new Engine(OPTIONS)
    const contexts = withFakeLauncher(engine)
    const first = await ensure(engine)
    expect(contexts).toHaveLength(1)

    contexts[0].emit('close') // the user closed the browser window

    const second = await ensure(engine)
    expect(contexts).toHaveLength(2)
    expect(second).not.toBe(first)
    expect(second).toBe(contexts[1])
  })

  it('relaunches again after every close', async () => {
    const engine = new Engine(OPTIONS)
    const contexts = withFakeLauncher(engine)
    for (let round = 0; round < 3; round += 1) {
      await ensure(engine)
      expect(contexts).toHaveLength(round + 1)
      contexts[round].emit('close')
    }
    expect(contexts).toHaveLength(3)
  })

  it('drops cached tabs and the persistent handle on close', async () => {
    const engine = new Engine(OPTIONS)
    const contexts = withFakeLauncher(engine)
    await ensure(engine)
    const internals = engine as unknown as {
      persistent?: unknown
      pages: Map<string, unknown>
      lastId?: string
    }
    internals.persistent = contexts[0]
    internals.pages.set('tab-1', {})
    internals.lastId = 'tab-1'

    contexts[0].emit('close')

    expect(internals.persistent).toBeUndefined()
    expect(internals.pages.size).toBe(0)
    expect(internals.lastId).toBeUndefined()
  })

  it('does not let a stale close drop a newer context', async () => {
    const engine = new Engine(OPTIONS)
    const contexts = withFakeLauncher(engine)
    await ensure(engine)
    contexts[0].emit('close')
    const current = await ensure(engine)
    expect(current).toBe(contexts[1])

    contexts[0].emit('close') // a second, meaningless close from the dead one
    expect(await ensure(engine)).toBe(contexts[1])
    expect(contexts).toHaveLength(2)
  })
})
