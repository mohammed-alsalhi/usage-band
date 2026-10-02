import { expect, mock, test } from 'claude-code/testing'

const HOUR = 3_600_000
const NOW = Date.parse('2026-10-02T12:00:00Z')

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

test('draws each window since its reset and the cost, on every surface with a band', async ($, on) => {
  const clock = mock.clock(on, { now: NOW - 2 * HOUR })
  // an earlier session this month, and one too old to count
  mock.store(on, { spend: { [NOW - 30 * HOUR]: 1, [NOW - 90 * 24 * HOUR]: 5 } })

  let reading = { five: 0, week: 0, usd: 0 }

  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW - 3 * HOUR,
      context: { window: 200_000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: reading.five, resetsAt: new Date(NOW + 2 * HOUR).toISOString() },
        { kind: 'seven_day', percentUsed: reading.week, resetsAt: new Date(NOW + 48 * HOUR).toISOString() },
      ],
      cost: { usd: reading.usd },
    },
  }))

  // the account's usage endpoint, asked with the engine's credential handle and nothing else
  on('session.authorize', () => ({ value: { handle: 'held', kind: 'bearer' } }))
  on('http.fetch', (_, e) => {
    expect(e).toMatchObject({ url: 'https://api.anthropic.com/api/oauth/usage', init: { auth: 'held' } })

    return {
      value: {
        status: 200,
        ok: true,
        headers: {},
        text: JSON.stringify({
          limits: [
            { scope: { model: { display_name: 'Fable' } }, percent: 9, resets_at: new Date(NOW + 48 * HOUR).toISOString() },
            { scope: {}, percent: 50 },
          ],
        }),
      },
    }
  })

  const measure = (five: number, week: number, usd: number) => {
    reading = { five, week, usd }

    return $.session.measure({ context: { window: 200_000 }, rateLimits: [], changed: ['rateLimits'] })
  }

  await measure(10, 40, 0.1)
  await clock.advance(2 * HOUR)
  await measure(90, 40, 0.25)
  // another session's stale reading must not pull the graph back down
  await measure(50, 40, 0.25)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-band', surface, ...BAND })

    expect(await ui.find({ type: 'Text', text: /^90%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^5h$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^· resets 2h0m$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^9%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^7d fable$/ })).toBeDefined()
    // this session's running total, counted once however often it is measured
    expect(await ui.find({ type: 'Text', text: /^\$0\.25$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\$0\.25 today$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^· \$1\.25 mo$/ })).toBeDefined()
    // both weekly windows, each field in its own column
    expect(await ui.findAll({ type: 'Text', text: /^· resets 2d0h$/ })).toHaveLength(2)

    if (surface === 'terminal') {
      // 5h window began 3h ago: nothing read for 1h, 10% for 2h, 90% now, 2h ahead
      expect(await ui.find({ type: 'Text', text: /··▁▁▁▁▁█····/ })).toBeDefined()
    } else {
      // a ring per window and for the cost, and a line for the one window read twice
      expect(await ui.findAll({ type: 'Svg' })).toHaveLength(5)
    }

    // the band's box, then one box per group and per column: two groups side by side at a wide
    // band, one group of shared columns once the two don't fit
    const columns = async (bodyColumns: number) => {
      const view = await $.ui.mount({ plugin: 'usage-band', surface, ...BAND, props: { ...BAND.props, bodyColumns } })
      const found = await view.findAll({ type: 'Box' })

      await view.unmount()

      return found.length
    }

    expect(await columns(120)).toBe(surface === 'terminal' ? 11 : 12)
    expect(await columns(40)).toBe(surface === 'terminal' ? 6 : 7)

    await ui.unmount()
  }
})
