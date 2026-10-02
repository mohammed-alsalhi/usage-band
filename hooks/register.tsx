import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, SessionRateLimit } from 'claude-code'

import type { Cost, Sample, Windows } from '../types'

const usage = atom({ plugin: 'usage-band', key: 'usage' } as const, null)

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const COLUMNS = 12
const BARS = '▁▂▃▄▅▆▇█'
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const GREEN = '#3fb950'
const TRACK = 'stroke="#888" stroke-opacity=".35"'
const DOLLAR = `<text x="10" y="13.7" text-anchor="middle" font-size="10" font-weight="700" font-family="system-ui,sans-serif" fill="${GREEN}" stroke="none">$</text>`

// One line of the band: a ring, then the fields its group lines up in columns.
type Line = {
  isWeekly: boolean
  ring: string
  alt: string
  value: string
  color?: string
  label: string
  detail: string
  tone: string
  graph: string | undefined
}

const spanOf = (kind: string) =>
  kind === 'five_hour' ? 5 * HOUR : kind.startsWith('seven_day') ? 7 * DAY : undefined

const labelOf = (kind: string) =>
  kind === 'five_hour' ? '5h' : kind.replace('seven_day', '7d').split('_').join(' ')

const leftOf = (ms: number) =>
  ms >= DAY
    ? `${Math.floor(ms / DAY)}d${Math.floor((ms / HOUR) % 24)}h`
    : ms >= HOUR
      ? `${Math.floor(ms / HOUR)}h${Math.floor((ms % HOUR) / MINUTE)}m`
      : `${Math.ceil(ms / MINUTE)}m`

const toneOf = (percent: number) => (percent >= 90 ? '#e5484d' : percent >= 70 ? '#d9a521' : GREEN)

const usd = (amount: number) => `$${amount.toFixed(2)}`

// The local day a moment falls on, as YYYY-MM-DD; its first seven characters are the month.
const dayOf = (at: number) => {
  const date = new Date(at)
  const two = (part: number) => String(part).padStart(2, '0')

  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
}

// A clockwise arc from the top: `share` of a circle of radius `r`.
const arcOf = (share: number, r: number, style: string) =>
  share > 0
    ? `<circle cx="10" cy="10" r="${r}" stroke-dasharray="${(Math.min(1, share) * 2 * Math.PI * r).toFixed(2)} 100" transform="rotate(-90 10 10)" ${style}/>`
    : ''

// How much of the window has gone by, as a dim pie: a stroke as wide as its radius fills the disc.
const pieOf = (elapsed: number) =>
  `<circle cx="10" cy="10" r="3" stroke-width="6" ${TRACK}/>${arcOf(elapsed, 3, 'stroke="#999" stroke-width="6" stroke-linecap="butt"')}`

// Usage on the outer ring, around whatever `inside` draws.
const ringOf = (percent: number, tone: string, inside: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="${tone}" stroke-width="2" stroke-linecap="round"><circle cx="10" cy="10" r="8" ${TRACK}/>${arcOf(percent / 100, 8, '')}${inside}</svg>`

// The readings since the reset as a line over the whole window's width, so
// where the line stops is how far into the window it is.
const sparkOf = (samples: Sample[], start: number, span: number, at: number, tone: string) => {
  const top = Math.max(1, ...samples.map(([, percent]) => percent))
  const last = samples[samples.length - 1]
  const points = [...samples, [at, last?.[1] ?? 0] as Sample]
    .map(([t, percent]) => `${(((t - start) / span) * 56).toFixed(1)},${(14.5 - (percent / top) * 13).toFixed(1)}`)
    .join(' ')

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 16" width="56" height="16" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M0 15.5h56" ${TRACK}/><polyline points="${points}" stroke="${tone}" stroke-width="1.5"/></svg>`
}

// The terminal has no Svg: one cell per slice of the window, the last reading in
// or before it, `·` where the slice is still ahead or nothing was read yet.
const graphOf = (samples: Sample[], start: number, span: number, at: number) =>
  Array.from({ length: COLUMNS }, (_, i) => {
    const from = start + (i * span) / COLUMNS

    if (from > at) {
      return '·'
    }

    let percent: number | undefined

    for (const [sampledAt, sampled] of samples) {
      if (sampledAt <= from + span / COLUMNS) {
        percent = sampled
      }
    }

    return percent === undefined ? '·' : BARS.charAt(Math.min(7, Math.floor((percent * 8) / 100)))
  }).join('')

// The per-model weekly windows (Fable's), which `$.session.usage()` leaves out: the account's
// own usage endpoint lists them. The engine sets the credential; the token never reaches here.
const modelLimits = async ($: EngineInterface, at: number): Promise<SessionRateLimit[]> => {
  let status = 'no credential'
  let found: SessionRateLimit[] = []

  try {
    const auth = (await $.session.authorize())?.handle

    if (auth !== undefined) {
      const answer = await $.http.fetch(USAGE_URL, { auth, headers: { 'anthropic-beta': 'oauth-2025-04-20' } })
      const limits: unknown = answer.ok ? JSON.parse(answer.text).limits : undefined

      status = String(answer.status)
      found = (Array.isArray(limits) ? limits : []).flatMap(limit => {
        const name: unknown = limit?.scope?.model?.display_name

        return typeof name === 'string' && typeof limit.percent === 'number'
          ? [
              {
                kind: `seven_day_${name.toLowerCase().split(' ').join('_')}`,
                percentUsed: Math.round(limit.percent * 10) / 10,
                ...(typeof limit.resets_at === 'string' ? { resetsAt: limit.resets_at } : {}),
              },
            ]
          : []
      })
    }
  } catch (error) {
    status = String(error)
  }

  // What the last read came to, for whoever wonders why a row is missing.
  await $.store.set('models', { at, status, found: found.length })

  return found
}

const record = async ($: EngineInterface) => {
  const at = await $.clock.now()
  const { startedAt, rateLimits: sessionLimits, cost } = await $.session.usage()
  const lastRead = ((await $.store.get('models')) as { at?: number } | undefined)?.at ?? 0
  // Every session shares the store, so together they ask the endpoint once in five minutes.
  const rateLimits = at - lastRead >= 5 * MINUTE ? [...sessionLimits, ...(await modelLimits($, at))] : sessionLimits
  // The store is shared by every session, so their readings land on one graph.
  const windows: Windows = { ...(((await $.store.get('windows')) ?? {}) as Windows) }

  for (const { kind, percentUsed, resetsAt } of rateLimits) {
    const end = resetsAt === undefined ? undefined : Date.parse(resetsAt)

    // A resumed session's last reading can be of a window that has since reset.
    if (end !== undefined && end <= at) {
      continue
    }

    const span = spanOf(kind)
    const start = end !== undefined && span !== undefined ? end - span : 0
    const samples = (windows[kind]?.samples ?? []).filter(([sampledAt]) => sampledAt >= start)
    const last = samples[samples.length - 1]
    // Inside one window usage only climbs: a lower reading is another session's stale one.
    const isNew = end === undefined ? last?.[1] !== percentUsed : last === undefined || percentUsed > last[1]

    if (isNew) {
      samples.push([at, percentUsed])
    }

    windows[kind] = { resetsAt, percent: samples[samples.length - 1]?.[1] ?? percentUsed, samples }
  }

  await $.store.set('windows', windows)

  let costs: Cost | undefined

  if (cost !== undefined) {
    // Each session's running total under its own start, so a rewrite never double counts.
    // ponytail: a session's whole cost lands on the day it started; split by day if long sessions skew "today"
    const spend: Record<string, number> = { [startedAt]: cost.usd }

    for (const [started, spent] of Object.entries(((await $.store.get('spend')) ?? {}) as Record<string, number>)) {
      if (Number(started) !== startedAt && Number(started) > at - 62 * DAY) {
        spend[started] = spent
      }
    }

    await $.store.set('spend', spend)

    const today = dayOf(at)
    const since = (prefix: string) =>
      Object.entries(spend).reduce(
        (sum, [started, spent]) => (dayOf(Number(started)).startsWith(prefix) ? sum + spent : sum),
        0,
      )

    costs = { session: cost.usd, today: since(today), month: since(today.slice(0, 7)) }
  }

  await update($, usage, () => ({ at, windows, ...(costs === undefined ? {} : { cost: costs }) }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await record($)

    return started
  })

  on('session.measure', async ($, e, next) => {
    await record($)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const seen = await read($, usage)

    if (e.props.hasSurvey || seen === null) {
      return next(e)
    }

    // ponytail: `at` is the last measurement, so "resets in" only moves once a turn; tick with $.clock.every if that drifts too far
    const { at, windows, cost } = seen
    const live = Object.entries(windows).filter(
      ([, { resetsAt }]) => resetsAt === undefined || Date.parse(resetsAt) > at,
    )

    if (live.length === 0 && cost === undefined) {
      return next(e)
    }

    // The terminal's table answers an Svg that draws nothing, so ask the surface, not the table.
    const table = $.ui.resolve(e)
    const { Box, Text } = table
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined

    const lines: Line[] = live.map(([kind, { resetsAt, percent, samples }]) => {
      const span = spanOf(kind)
      const end = resetsAt === undefined ? undefined : Date.parse(resetsAt)
      const start = end !== undefined && span !== undefined ? end - span : undefined
      const tone = toneOf(percent)
      const elapsed = start === undefined || span === undefined ? undefined : (at - start) / span

      return {
        isWeekly: kind.startsWith('seven_day'),
        ring: ringOf(percent, tone, elapsed === undefined ? '' : pieOf(elapsed)),
        alt: elapsed === undefined ? `${percent}% used` : `${percent}% used, ${Math.round(elapsed * 100)}% of the window gone`,
        value: `${percent}%`,
        label: labelOf(kind),
        detail: end !== undefined ? `· resets ${leftOf(end - at)}` : '',
        tone,
        graph:
          start === undefined || span === undefined
            ? undefined
            : Svg === undefined
              ? graphOf(samples, start, span, at)
              : samples.length > 1
                ? sparkOf(samples, start, span, at, tone)
                : undefined,
      }
    })

    if (cost !== undefined) {
      lines.push({
        isWeekly: false,
        ring: ringOf(100, GREEN, DOLLAR),
        alt: 'cost',
        value: usd(cost.session),
        color: GREEN,
        label: `${usd(cost.today)} today`,
        detail: `· ${usd(cost.month)} mo`,
        tone: GREEN,
        graph: undefined,
      })
    }

    // A group is columns, not rows, so each field lines up down the group whatever its width;
    // space-around keeps a column of shorter cells level with the rings beside it.
    const column = (cells: RenderChildren[], alignItems: 'flex-start' | 'flex-end' = 'flex-start') => (
      <Box flexDirection="column" justifyContent="space-around" alignItems={alignItems}>
        {cells}
      </Box>
    )

    const group = (rows: Line[]) => (
      <Box alignItems="stretch" columnGap={1}>
        {Svg !== undefined
          ? column(rows.map(({ ring, alt }) => <Svg source={ring} alt={alt} width={20} height={20} />))
          : null}
        {column(
          rows.map(({ value, color }) =>
            color === undefined ? (
              <Text bold>{value}</Text>
            ) : (
              <Text bold color={color}>
                {value}
              </Text>
            ),
          ),
          'flex-end',
        )}
        {column(rows.map(({ label }) => <Text dimColor>{label}</Text>))}
        {column(rows.map(({ detail }) => <Text dimColor>{detail === '' ? ' ' : detail}</Text>))}
        {rows.some(({ graph }) => graph !== undefined)
          ? column(
              rows.map(({ graph, tone }) =>
                graph === undefined ? (
                  <Text> </Text>
                ) : Svg === undefined ? (
                  <Text color={tone}>{graph}</Text>
                ) : (
                  <Svg source={graph} alt="usage since the last reset" width={56} height={16} />
                ),
              ),
            )
          : null}
      </Box>
    )

    // The weekly windows keep to the right edge; the room between the groups is free.
    return (
      <Box flexWrap="wrap" justifyContent="space-between" columnGap={4} paddingX={1} width="100%">
        {group(lines.filter(({ isWeekly }) => !isWeekly))}
        {group(lines.filter(({ isWeekly }) => isWeekly))}
      </Box>
    )
  })
}
