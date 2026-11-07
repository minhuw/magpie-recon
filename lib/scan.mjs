// Reserve math from two files only: quota-history.json (window readings)
// and usage.jsonl (gateway calls). No providers.json, so no keys and no
// way to see an account that was never written into either file.

const HOUR = 3600 * 1000
const DAY = 24 * HOUR

const HOT_GAP = -8
const COOL_GAP = 10
const HOT_EMPTY = 0.9
const COOL_EMPTY = 1.2
const SLOPE_FLOOR = -0.02
const MIN_SPAN = 20 * 60 * 1000
const RECENT = 6 * HOUR
const RATE_DAYS = 7
const FORECAST_DAYS = 15
const FORECAST_STALE = 30 * 60 * 1000
const IDLE_LEFT = 88
const IDLE_TOKENS = 2000
const IDLE_AGE = 6 * HOUR
const ESTIMATE_USED = 8
const COVER_SLACK = HOUR

export const PERIODS = [
  ["h24", DAY],
  ["d3", 3 * DAY],
  ["d7", 7 * DAY],
  ["d30", 30 * DAY],
]

export function localDay(ms, offsetMin) {
  const d = new Date(ms + offsetMin * 60 * 1000)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, "0")
  const day = String(d.getUTCDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

export function dayStart(day, offsetMin) {
  return Date.parse(day + "T00:00:00Z") - offsetMin * 60 * 1000
}

export function defaultOffsetMin() {
  return -new Date().getTimezoneOffset()
}

function timeOf(v) {
  if (v == null || v === "") return null
  const t = new Date(v).getTime()
  return Number.isFinite(t) ? t : null
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function round1(n) {
  return Math.round(n * 10) / 10
}

export function splitAccountKey(key) {
  const i = String(key).indexOf("|")
  if (i <= 0 || i === key.length - 1) return null
  return { provider: key.slice(0, i), user: key.slice(i + 1) }
}

function acctKey(provider, user) {
  return String(provider).toLowerCase() + "\0" + String(user).toLowerCase()
}

export function isRejected(r) {
  return r?.rejected === true || (!r?.provider && num(r?.status) >= 400)
}

function emptyBucket() {
  return { calls: 0, errors: 0, input: 0, output: 0, tokens: 0, cost: 0, priced: 0 }
}

function addBucket(b, r, tokens) {
  b.calls++
  if (num(r.status) >= 400) b.errors++
  b.input += num(r.in)
  b.output += num(r.out)
  b.tokens += tokens
  const cost = Number(r.cost)
  if (r.cost != null && r.cost !== "" && Number.isFinite(cost)) {
    b.cost += cost
    b.priced++
  }
}

function pubBucket(b) {
  return {
    calls: b.calls,
    errors: b.errors,
    tokens: b.tokens,
    input: b.input,
    output: b.output,
    cost: b.priced ? b.cost : null,
  }
}

function personName(r) {
  const name = String(r.callerKeyName || "").trim()
  if (name) return name
  const id = String(r.callerKeyId || "").trim()
  if (id) return "钥匙 " + id.slice(0, 10)
  return "（无网关钥匙）"
}

function usageAccount(r) {
  const provider = String(r.provider || "").trim()
  const user = String(r.providerAccount || "").trim()
  if (provider && user) return { key: acctKey(provider, user), label: provider + " · " + user }
  if (!provider) return null
  const keyName = String(r.providerKeyName || "").trim()
  return {
    key: "key\0" + provider.toLowerCase() + "\0" + keyName.toLowerCase(),
    label: provider + (keyName ? " · " + keyName : " ·（API 钥匙）"),
  }
}

function mapPoint(p) {
  if (!p || typeof p !== "object") return null
  const at = timeOf(p.at)
  const left = Number(p.left)
  if (at == null || !Number.isFinite(left)) return null
  return { at, left, start: timeOf(p.start), reset: timeOf(p.resetsAt) }
}

function parseQuota(quota) {
  const accounts = new Map()
  for (const [rawKey, wins] of Object.entries(quota)) {
    const id = splitAccountKey(rawKey)
    if (!id || !wins || typeof wins !== "object" || Array.isArray(wins)) continue
    const key = acctKey(id.provider, id.user)
    const acc = {
      provider: id.provider,
      user: id.user,
      label: id.provider + " · " + id.user,
      key,
      windows: [],
    }
    for (const [name, pts] of Object.entries(wins)) {
      if (!Array.isArray(pts)) continue
      const points = pts.map(mapPoint).filter(Boolean).sort((a, b) => a.at - b.at)
      if (!points.length) continue
      const latest = points[points.length - 1]
      let start = latest.start
      let reset = latest.reset
      if (start == null || reset == null) {
        for (let i = points.length - 1; i >= 0; i--) {
          if (points[i].start != null && points[i].reset != null) {
            start = points[i].start
            reset = points[i].reset
            break
          }
        }
      }
      acc.windows.push({ name: String(name), points, start, reset, left: latest.left, tokens: 0, calls: 0 })
    }
    if (acc.windows.length) accounts.set(key, acc)
  }
  return accounts
}

// pace is the window against an even burn, plus the last few hours' slope.
// hot: the recent slope empties it before 90% of the time left, or it is
// already more than 8 points behind an even burn. cool: ahead by more than
// 10 points and not about to empty.
function paceOf(w, now) {
  const { start, reset, left } = w
  if (start == null || reset == null || !(reset > now) || !(reset > start)) return { open: false }
  const hoursToReset = (reset - now) / HOUR
  const even = 100 * (reset - now) / (reset - start)
  const gap = left - even
  const cycle = w.points.filter((p) => p.at >= start && p.at <= now && p.at < reset)
  let hoursToEmpty = null
  let slope = null
  let sampleHours = null
  const observedAt = cycle.length ? cycle[cycle.length - 1].at : null
  if (cycle.length >= 2) {
    const last = cycle[cycle.length - 1]
    let first = cycle[0]
    const recent = cycle.filter((p) => p.at >= now - RECENT)
    if (recent.length >= 2 && recent[recent.length - 1].at - recent[0].at >= MIN_SPAN) first = recent[0]
    if (last.at - first.at >= MIN_SPAN) {
      sampleHours = (last.at - first.at) / HOUR
      slope = (last.left - first.left) / sampleHours
      if (slope < SLOPE_FLOOR) hoursToEmpty = last.left / -slope
    }
  }
  let pace = "even"
  const hot = (hoursToEmpty != null && hoursToEmpty < hoursToReset * HOT_EMPTY) || gap < HOT_GAP
  if (hot) pace = "hot"
  else if (gap > COOL_GAP && (hoursToEmpty == null || hoursToEmpty > hoursToReset * COOL_EMPTY)) pace = "cool"
  return { open: true, even, gap, hoursToReset, hoursToEmpty, pace, left, slope, sampleHours, observedAt }
}

function averageDailyBurn(points, now) {
  const from = now - RATE_DAYS * DAY
  let previous = null
  let used = 0
  let samples = 0
  for (const point of points) {
    if (point.at > now) continue
    if (point.at >= from) {
      samples++
      const sameCycle = previous == null || (previous.start === point.start && previous.reset === point.reset)
      if (previous && previous.at >= from && sameCycle && point.left < previous.left) {
        used += previous.left - point.left
      }
    }
    previous = point
  }
  return samples >= 2 ? used / RATE_DAYS : null
}

function accountEmptyAt(w, now) {
  if (w.left <= 0) return now
  const at = Date.parse(w.forecastEmptyAt)
  const reset = Date.parse(w.reset)
  return Number.isFinite(at) && at < reset ? at : null
}

function projectAccount(w, at) {
  const burn = Number.isFinite(w.dailyBurn) ? w.dailyBurn : 0
  const observedAt = Date.parse(w.observedAt)
  const reset = Date.parse(w.reset)
  const start = Date.parse(w.start)
  const cycle = reset - start
  if (at < reset || !(cycle > 0)) {
    const elapsed = Math.max(0, at - observedAt) / DAY
    return Math.max(0, Math.min(100, w.left - burn * elapsed))
  }
  const lastReset = reset + Math.floor((at - reset) / cycle) * cycle
  return Math.max(0, Math.min(100, 100 - burn * (at - lastReset) / DAY))
}

function providerForecasts(binding, now) {
  const groups = new Map()
  for (const w of binding) {
    const id = w.provider.toLowerCase()
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id).push(w)
  }
  const rank = { codex: 0, claude: 1 }
  return [...groups.entries()].map(([id, rows]) => {
    const left = rows.reduce((sum, w) => sum + w.left, 0) / rows.length
    const next = rows.reduce((best, w) => !best || Date.parse(w.reset) < Date.parse(best.reset) ? w : best, null)
    const nextReset = Date.parse(next.reset)
    const stale = rows.some((w) => {
      if (w.left <= 0) return false
      const observedAt = Date.parse(w.observedAt)
      const emptyAt = accountEmptyAt(w, now)
      return !Number.isFinite(observedAt) || now - observedAt > FORECAST_STALE || (emptyAt != null && emptyAt <= now)
    })
    const insufficient = rows.some((w) => !Number.isFinite(w.dailyBurn))
    const status = stale ? "stale" : insufficient ? "insufficient" : "ready"
    const emptyTimes = rows.map((w) => ({ at: accountEmptyAt(w, now), row: w }))
    const validEmpty = emptyTimes.filter((event) => event.at != null)
    const first = validEmpty.reduce((best, event) => !best || event.at < best.at ? event : best, null)
    const last = validEmpty.length === rows.length ? validEmpty.reduce((latest, event) => event.at > latest ? event.at : latest, 0) : null
    const emptyAt = status === "ready" && last != null && last < nextReset ? new Date(last).toISOString() : null
    const projectedLeftAtReset = status === "ready"
      ? round1(rows.reduce((sum, w) => sum + projectAccount(w, nextReset - 1), 0) / rows.length)
      : null
    let projection = []
    if (status === "ready") {
      const horizon = now + FORECAST_DAYS * DAY
      const times = [now, horizon]
      for (let day = 1; day <= FORECAST_DAYS; day++) times.push(now + day * DAY)
      for (const event of validEmpty) {
        if (event.at > now && event.at <= horizon) times.push(event.at)
      }
      for (const w of rows) {
        const reset = Date.parse(w.reset)
        const cycle = reset - Date.parse(w.start)
        if (!(cycle > 0)) continue
        for (let at = reset; at <= horizon; at += cycle) {
          if (at <= now) continue
          times.push(at - 1, at)
          if (w.dailyBurn > 0) {
            const empty = at + 100 / w.dailyBurn * DAY
            if (empty < at + cycle && empty <= horizon) times.push(empty)
          }
        }
      }
      const unique = [...new Set(times.filter((at) => at >= now && at <= horizon))].sort((a, b) => a - b)
      projection = unique.map((at) => ({
        at: new Date(at).toISOString(),
        left: round1(rows.reduce((sum, w) => sum + projectAccount(w, at), 0) / rows.length),
      }))
    }
    return {
      id,
      label: id === "codex" ? "Codex" : id === "claude" ? "Claude" : rows[0].provider,
      left: round1(left),
      accounts: rows.length,
      status,
      resetAt: next.reset,
      resetLabel: next.label + " · " + next.window,
      emptyAt,
      firstEmptyAt: first ? new Date(first.at).toISOString() : null,
      firstEmptyLabel: first ? first.row.label : null,
      projectedLeftAtReset,
      projection,
    }
  }).sort((a, b) => (rank[a.id] ?? 9) - (rank[b.id] ?? 9) || a.label.localeCompare(b.label))
}

function providerHistories(series, now, offset) {
  const groups = new Map()
  for (const item of series) {
    const id = item.provider.toLowerCase()
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id).push(item)
  }
  const result = new Map()
  for (const [id, list] of groups) {
    const history = []
    for (let i = FORECAST_DAYS; i >= 0; i--) {
      const day = localDay(now - i * DAY, offset)
      const sample = Math.min(dayStart(day, offset) + DAY - 1, now)
      const left = []
      for (const item of list) {
        let latest = null
        for (const point of item.points) {
          if (point.at > sample) break
          latest = point
        }
        if (!latest) break
        left.push(latest.left)
      }
      if (left.length === list.length) {
        history.push({
          at: new Date(sample).toISOString(),
          left: round1(left.reduce((sum, value) => sum + value, 0) / left.length),
        })
      }
    }
    result.set(id, history)
  }
  return result
}

function chooseBinding(list) {
  const open = list.filter((w) => w.pace?.open)
  if (!open.length) return null
  const hot = open.filter((w) => w.pace.pace === "hot")
  const pool = hot.length ? hot : open
  pool.sort((a, b) => {
    const ae = a.pace.hoursToEmpty ?? Infinity
    const be = b.pace.hoursToEmpty ?? Infinity
    if (ae !== be) return ae - be
    return a.pace.gap - b.pace.gap
  })
  return pool[0]
}

function pickSeriesWindow(list, now) {
  const from = now - 30 * DAY
  const recent = list.filter((w) => w.points.some((p) => p.at >= from && p.at <= now))
  const pool = recent.length ? recent : list
  let best = null
  for (const w of pool) {
    const span = w.start != null && w.reset != null ? Math.max(0, w.reset - w.start) : 0
    if (!best || span > best.span || (span === best.span && w.points.length > best.w.points.length)) {
      best = { w, span }
    }
  }
  return best ? best.w : null
}

function candleForDay(groups) {
  const rows = groups.filter((g) => g.points.length)
  if (!rows.length) return null
  const seen = new Map(rows.map((g) => [g.id, null]))
  const events = []
  for (const g of rows) for (const p of g.points) events.push([p.at, g.id, p.left])
  events.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1))
  const samples = []
  let i = 0
  while (i < events.length) {
    const at = events[i][0]
    while (i < events.length && events[i][0] === at) {
      seen.set(events[i][1], events[i][2])
      i++
    }
    let ready = true
    let sum = 0
    for (const v of seen.values()) {
      if (v == null) { ready = false; break }
      sum += v
    }
    if (ready) samples.push(sum / seen.size)
  }
  if (!samples.length) return null
  return {
    open: round1(samples[0]),
    close: round1(samples[samples.length - 1]),
    high: round1(Math.max(...samples)),
    low: round1(Math.min(...samples)),
    n: rows.length,
  }
}

function blankPeriods() {
  return { h24: emptyBucket(), d3: emptyBucket(), d7: emptyBucket(), d30: emptyBucket(), daily: new Map() }
}

function noteUsage(map, key, label, r, tokens, now, offset, days) {
  let row = map.get(key)
  if (!row) {
    row = { name: label, ...blankPeriods() }
    map.set(key, row)
  }
  for (const [id, len] of PERIODS) {
    if (r.t >= now - len && r.t <= now + HOUR) addBucket(row[id], r, tokens)
  }
  const day = localDay(r.t, offset)
  if (days.includes(day)) row.daily.set(day, (row.daily.get(day) || 0) + tokens)
}

function publishUsage(map, days) {
  const rows = [...map.values()].filter((r) => r.d30.calls > 0)
  rows.sort((a, b) => b.d7.tokens - a.d7.tokens || b.d7.calls - a.d7.calls || a.name.localeCompare(b.name))
  return rows.slice(0, 100).map((r) => ({
    name: r.name,
    h24: pubBucket(r.h24),
    d3: pubBucket(r.d3),
    d7: pubBucket(r.d7),
    d30: pubBucket(r.d30),
    daily: days.map((d) => r.daily.get(d) || 0),
  }))
}

function publishDaily(usage, series, days, offset, logFrom) {
  const accountsByProvider = new Map()
  for (const item of series) {
    const id = item.provider.toLowerCase()
    if (!accountsByProvider.has(id)) accountsByProvider.set(id, [])
    accountsByProvider.get(id).push(item)
  }
  const progress = new Map()
  for (const [id, list] of accountsByProvider) {
    const readings = list.map((item) => {
      const seen = new Set()
      const used = new Map()
      let previous = null
      for (const point of item.points) {
        const day = localDay(point.at, offset)
        if (days.includes(day)) {
          seen.add(day)
          const sameCycle = previous == null || (previous.start === point.start && previous.reset === point.reset)
          if (previous && sameCycle && point.left < previous.left) {
            used.set(day, (used.get(day) || 0) + (previous.left - point.left) / 100)
          }
        }
        previous = point
      }
      return { seen, used }
    })
    const daily = new Map()
    for (const day of days) {
      if (!readings.every((r) => r.seen.has(day))) continue
      daily.set(day, readings.reduce((sum, r) => sum + (r.used.get(day) || 0), 0))
    }
    progress.set(id, daily)
  }

  const ids = new Set([...usage.keys(), ...progress.keys()])
  const rank = { codex: 0, claude: 1 }
  return [...ids].map((id) => ({
    id,
    label: id === "codex" ? "Codex" : id === "claude" ? "Claude" : id,
    values: days.map((day) => {
      const bucket = usage.get(id)?.get(day)
      const from = dayStart(day, offset)
      const to = from + DAY
      const unknown = logFrom == null || to <= logFrom
      const partialLog = logFrom != null && logFrom > from && logFrom < to
      const accountUnits = progress.get(id)?.get(day)
      return {
        day,
        tokens: unknown ? null : bucket?.tokens || 0,
        tokensPartial: partialLog,
        cost: unknown ? null : bucket ? (bucket.priced ? bucket.cost : null) : 0,
        costPartial: partialLog || (bucket ? bucket.priced < bucket.calls : false),
        accountUnits: accountUnits == null ? null : Math.round(accountUnits * 1000) / 1000,
      }
    }),
  })).sort((a, b) => (rank[a.id] ?? 9) - (rank[b.id] ?? 9) || a.label.localeCompare(b.label))
}

function covers(start, logFrom) {
  return logFrom != null && start != null && logFrom <= start + COVER_SLACK
}

export async function analyze(quota, records, now, opt = {}) {
  if (quota == null || typeof quota !== "object" || Array.isArray(quota)) {
    throw new Error("quota-history.json 应该是 {供应商|账号: {窗口: [读数]}}")
  }
  const offset = opt.offsetMin ?? defaultOffsetMin()
  const accounts = parseQuota(quota)
  const days = []
  for (let i = 29; i >= 0; i--) days.push(localDay(now - i * DAY, offset))

  const people = new Map()
  const byAccount = new Map()
  const totals = blankPeriods()
  const volume = new Map()
  const dailyUsage = new Map()
  let logFrom = null
  let burnTokens = 0
  let burnCalls = 0

  for await (const r of records) {
    if (!r || typeof r !== "object" || isRejected(r)) continue
    const t = timeOf(r.t)
    if (t == null || t > now + HOUR) continue
    r.t = t
    if (logFrom == null || t < logFrom) logFrom = t
    const tokens = num(r.in) + num(r.out)
    if (t >= now - RECENT) {
      burnTokens += tokens
      burnCalls++
    }
    noteUsage(people, personName(r), personName(r), r, tokens, now, offset, days)
    for (const [id, len] of PERIODS) {
      if (t >= now - len && t <= now + HOUR) addBucket(totals[id], r, tokens)
    }
    const day = localDay(t, offset)
    if (days.includes(day)) volume.set(day, (volume.get(day) || 0) + tokens)
    const provider = String(r.provider || "").trim().toLowerCase()
    if (provider && days.includes(day)) {
      if (!dailyUsage.has(provider)) dailyUsage.set(provider, new Map())
      const daily = dailyUsage.get(provider)
      if (!daily.has(day)) daily.set(day, emptyBucket())
      addBucket(daily.get(day), r, tokens)
    }
    const acct = usageAccount(r)
    if (acct) {
      noteUsage(byAccount, acct.key, acct.label, r, tokens, now, offset, days)
      const owned = accounts.get(acct.key)
      if (owned && String(r.providerAccount || "").trim()) {
        for (const w of owned.windows) {
          if (w.start == null || w.reset == null) continue
          if (t >= w.start && t < w.reset) {
            w.tokens += tokens
            w.calls++
          }
        }
      }
    }
  }

  const burnSpanHours = logFrom == null ? 6 : Math.min(6, Math.max(0.25, (now - Math.max(logFrom, now - RECENT)) / HOUR))
  const series = []
  const forecastSeries = []
  const windows = []
  for (const acc of accounts.values()) {
    for (const w of acc.windows) w.pace = paceOf(w, now)
    const binding = chooseBinding(acc.windows)
    const seriesWindow = pickSeriesWindow(acc.windows, now)
    if (binding) forecastSeries.push({ id: acc.label, provider: acc.provider, points: binding.points })
    if (seriesWindow) series.push({ id: acc.label, provider: acc.provider, points: seriesWindow.points })
    for (const w of acc.windows) {
      if (!w.pace.open) continue
      const covered = covers(w.start, logFrom)
      const unused = covered && w.tokens < IDLE_TOKENS
      const age = now - w.start
      const span = w.reset - w.start
      const idle = unused && w.pace.left >= IDLE_LEFT && age > IDLE_AGE && (age > 0.2 * span || age > 24 * HOUR) && w.pace.pace !== "hot"
      const usedPct = 100 - w.pace.left
      const remaining = covered && usedPct >= ESTIMATE_USED && w.tokens > 0 ? w.tokens * w.pace.left / usedPct : null
      const dailyBurn = averageDailyBurn(w.points, now)
      windows.push({
        label: acc.label,
        provider: acc.provider,
        user: acc.user,
        window: w.name,
        binding: w === binding,
        idle,
        unseen: covered && w.tokens < IDLE_TOKENS && w.pace.pace === "hot",
        covered,
        left: round1(w.pace.left),
        even: round1(w.pace.even),
        gap: round1(w.pace.gap),
        pace: idle ? "idle" : w.pace.pace,
        hoursToReset: w.pace.hoursToReset,
        hoursToEmpty: w.pace.hoursToEmpty,
        slope: w.pace.slope,
        sampleHours: w.pace.sampleHours,
        observedAt: w.pace.observedAt == null ? null : new Date(w.pace.observedAt).toISOString(),
        start: new Date(w.start).toISOString(),
        dailyBurn,
        forecastEmptyAt: w.pace.observedAt != null && dailyBurn > 0
          ? new Date(w.pace.observedAt + w.pace.left / dailyBurn * DAY).toISOString()
          : null,
        reset: new Date(w.reset).toISOString(),
        tokens: w.tokens,
        calls: w.calls,
        remaining,
      })
    }
  }

  const binding = windows.filter((w) => w.binding)
  const hot = binding.filter((w) => w.pace === "hot")
  const idle = binding.filter((w) => w.idle)
  const active = binding.filter((w) => !w.idle)
  const cool = active.filter((w) => w.pace === "cool")
  let verdict = "unknown"
  if (binding.length) {
    if (hot.length) verdict = "tighten"
    else if (!active.length) verdict = "idle"
    else if (cool.length === active.length && idle.length) verdict = "loosen"
    else if (cool.length === active.length || cool.length > active.length - cool.length) verdict = "speed"
    else verdict = "hold"
  }

  const estimable = binding.filter((w) => w.remaining != null)
  const soonestEmpty = binding.reduce((min, w) => {
    // A slope that hits zero only after the reset does not empty this cycle.
    if (w.hoursToEmpty == null || w.hoursToEmpty >= w.hoursToReset) return min
    return min == null || w.hoursToEmpty < min ? w.hoursToEmpty : min
  }, null)
  const next = binding.reduce((best, w) => (!best || w.hoursToReset < best.hoursToReset ? w : best), null)
  const worst = hot.reduce((best, w) => {
    const h = w.hoursToEmpty ?? Infinity
    const bh = best ? (best.hoursToEmpty ?? Infinity) : Infinity
    return !best || h < bh ? w : best
  }, null)

  const rank = { hot: 0, even: 1, cool: 2, idle: 3 }
  windows.sort((a, b) => (rank[a.pace] ?? 9) - (rank[b.pace] ?? 9) || a.hoursToReset - b.hoursToReset || a.label.localeCompare(b.label))

  const candles = days.map((day) => {
    const from = dayStart(day, offset)
    const to = from + DAY
    const groups = series.map((s) => ({ id: s.id, points: s.points.filter((p) => p.at >= from && p.at < to && p.at <= now) }))
    const c = candleForDay(groups)
    return {
      day,
      open: c ? c.open : null,
      high: c ? c.high : null,
      low: c ? c.low : null,
      close: c ? c.close : null,
      n: c ? c.n : 0,
      volume: volume.get(day) || 0,
    }
  })

  const providers = providerForecasts(binding, now)
  const histories = providerHistories(forecastSeries, now, offset)
  for (const provider of providers) provider.history = histories.get(provider.id) || []

  return {
    now: new Date(now).toISOString(),
    days,
    verdict: {
      id: verdict,
      shortOnly: hot.length > 0 && hot.every((w) => w.hoursToReset < 6),
      worst: worst && {
        label: worst.label,
        window: worst.window,
        hoursToEmpty: worst.hoursToEmpty,
        hoursToReset: worst.hoursToReset,
      },
      idle: idle.map((w) => ({ label: w.label, window: w.window })),
    },
    log: { from: logFrom == null ? null : new Date(logFrom).toISOString(), covered: logFrom != null },
    burn: {
      hours: round1(burnSpanHours),
      tokens: burnTokens,
      calls: burnCalls,
      tokensPerHour: burnSpanHours > 0 ? burnTokens / burnSpanHours : 0,
    },
    providers,
    dailyProviders: publishDaily(dailyUsage, series, days, offset, logFrom),
    reserve: {
      left: binding.length ? round1(binding.reduce((s, w) => s + w.left, 0) / binding.length) : null,
      accounts: binding.length,
      remainingTokens: estimable.length ? estimable.reduce((s, w) => s + w.remaining, 0) : null,
      partial: estimable.length > 0 && estimable.length < binding.length,
      hoursToEmpty: soonestEmpty,
      nextReset: next ? next.reset : null,
      nextResetLabel: next ? next.label + " · " + next.window : null,
    },
    candles,
    windows,
    people: publishUsage(people, days),
    accounts: publishUsage(byAccount, days),
    totals: {
      h24: pubBucket(totals.h24),
      d3: pubBucket(totals.d3),
      d7: pubBucket(totals.d7),
      d30: pubBucket(totals.d30),
    },
  }
}
