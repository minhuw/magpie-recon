// Quota is measured in percentage points. Pooling assumes equal-capacity,
// interchangeable accounts; shares route demand, they do not create demand.
const HOUR = 3600000
const DAY = 24 * HOUR
const MIN_FORECAST_HOURS = 1 / 3
const EPS = 1e-8
const iso = (at) => new Date(Math.round(at)).toISOString()
const stamp = (at) => typeof at === "number" ? at : Date.parse(at)
const clamp = (n) => Math.max(0, Math.min(100, n))
const round1 = (n) => Math.round(n * 10) / 10

function intervals(points, now) {
  const sorted = points.filter((p) => p.at <= now).slice().sort((a, b) => a.at - b.at)
  const result = []
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i]
    if (b.at <= a.at || a.start == null || a.reset == null || a.start !== b.start || a.reset !== b.reset || b.left > a.left) continue
    const from = Math.max(a.at, now - 28 * DAY)
    const to = Math.min(b.at, now)
    if (to <= from) continue
    result.push({ from, to, rate: Math.max(0, a.left - b.left) * HOUR / (b.at - a.at), exhausted: a.left <= 0 && b.left <= 0, dense: b.at - a.at <= 2 * HOUR })
  }
  return result
}

function slotAt(at, offsetMin, weekly) {
  const d = new Date(at + offsetMin * 60000)
  return (weekly ? d.getUTCDay() * 24 : 0) + d.getUTCHours()
}

function nextHour(at, offsetMin) {
  const offset = offsetMin * 60000
  return (Math.floor((at + offset) / HOUR) + 1) * HOUR - offset
}

// Intersect account coverage before summing rates. Missing observations are
// unknown; an exhausted account is observed zero only while another is usable.
export function estimateDemand(accounts, now, { offsetMin = 0, halfLifeHours = 24 } = {}) {
  const tracks = accounts.map((a) => intervals(a.points, now))
  const bins = new Map()
  if (tracks.length && tracks.every((t) => t.length)) {
    const boundaries = new Set(tracks.flatMap((t) => t.flatMap((p) => [p.from, p.to])))
    const from = Math.min(...tracks.map((t) => t[0].from))
    for (let at = nextHour(from, offsetMin); at < now; at += HOUR) boundaries.add(at)
    const times = [...boundaries].sort((a, b) => a - b)
    const cursors = tracks.map(() => 0)
    for (let i = 1; i < times.length; i++) {
      const a = times[i - 1], b = times[i]
      const current = tracks.map((t, j) => {
        while (cursors[j] < t.length && t[cursors[j]].to <= a) cursors[j]++
        const p = t[cursors[j]]
        return p && p.from <= a && p.to >= b ? p : null
      })
      if (current.some((p) => !p) || current.every((p) => p.exhausted)) continue
      const key = Math.floor((a + offsetMin * 60000) / HOUR)
      if (!bins.has(key)) bins.set(key, { at: a, hours: 0, dense: 0, used: 0, accountUsed: accounts.map(() => 0) })
      const bin = bins.get(key), hours = (b - a) / HOUR
      bin.hours += hours
      if (current.every((p) => p.dense)) bin.dense += hours
      for (let j = 0; j < current.length; j++) {
        const used = current[j].rate * hours
        bin.used += used
        bin.accountUsed[j] += used
      }
    }
  }
  const observations = [...bins.values()].sort((a, b) => a.at - b.at)
  const coverageHours = observations.reduce((sum, b) => sum + b.hours, 0)
  const denseCoverageHours = observations.reduce((sum, b) => sum + b.dense, 0)
  const complete = observations.filter((b) => b.hours >= 1 - EPS && b.dense >= 1 - EPS)
  let seasonal = "none", profile = null
  for (const [name, slots] of [["weekly", 168], ["daily", 24]]) {
    const groups = Array.from({ length: slots }, () => [])
    for (const b of complete) groups[slotAt(b.at, offsetMin, name === "weekly")].push(b.used / b.hours)
    if (!groups.every((g) => g.length >= 2)) continue
    const means = groups.map((g) => g.reduce((s, v) => s + v, 0) / g.length)
    const mean = means.reduce((s, v) => s + v, 0) / slots
    if (!(mean > 0)) continue
    // Two repeats are deliberately conservative; more repeats earn less shrinkage.
    const repeats = Math.min(...groups.map((g) => g.length))
    const strength = repeats / (repeats + 2)
    profile = means.map((v) => 1 + strength * (v / mean - 1))
    seasonal = name
    break
  }
  const seasonalAt = (at) => profile ? profile[slotAt(at, offsetMin, seasonal === "weekly")] : 1
  let weightedLevel = 0
  let weight = 0
  let components = accounts.map(() => 0)
  const halfLife = Number.isFinite(halfLifeHours) && halfLifeHours > 0 ? halfLifeHours : 24
  for (const b of observations) {
    const rate = b.used / b.hours / seasonalAt(b.at)
    const alpha = -Math.expm1(-Math.LN2 * b.hours / halfLife)
    const decay = 1 - alpha
    // Normalize finite-history weights: a one-second leading sample must not
    // initialize a full half-life's worth of prior demand or routing weight.
    weightedLevel = weightedLevel * decay + alpha * rate
    weight = weight * decay + alpha
    components = components.map((v, j) => v * decay + alpha * b.accountUsed[j] / b.hours)
  }
  const level = weight > 0 ? weightedLevel / weight : null
  const total = components.reduce((s, v) => s + v, 0)
  const shares = components.map((v) => total > 0 ? v / total : 1 / accounts.length)
  const confidence = denseCoverageHours >= 168 && seasonal !== "none" ? "high" : denseCoverageHours >= 24 ? "medium" : "low"
  const rateAt = (at) => level == null ? null : Math.max(0, level * seasonalAt(at))
  return { method: seasonal === "none" ? "ewma" : `${seasonal}-ewma`, seasonal, confidence, coverageHours, denseCoverageHours, level, shares, offsetMin, rateAt }
}

export function demandBetween(model, from, to) {
  if (model.level == null) return null
  let used = 0
  for (let at = from; at < to;) {
    const end = Math.min(to, nextHour(at, model.offsetMin))
    used += model.rateAt(at) * (end - at) / HOUR
    at = end
  }
  return used
}

export function windowForecast(points, now, options = {}) {
  const model = estimateDemand([{ points }], now, options)
  const latest = points.reduce((last, p) => p.at <= now && (!last || p.at >= last.at) ? p : last, null)
  const dailyBurn = model.coverageHours >= MIN_FORECAST_HOURS - EPS ? demandBetween(model, now, now + DAY) : null
  let forecastEmptyAt = null
  if (latest && dailyBurn != null && model.level > 0) {
    let left = latest.left
    // A flat estimate has an exact solution even for very slow demand.
    if (model.seasonal === "none") {
      const at = latest.at + Math.max(0, left) / model.level * HOUR
      if (Number.isFinite(at) && Math.abs(at) <= 8640000000000000) forecastEmptyAt = iso(at)
    }
    else for (let at = latest.at; at < latest.at + 366 * DAY;) {
      const end = nextHour(at, model.offsetMin), rate = model.rateAt(at)
      if (rate > 0 && left <= rate * (end - at) / HOUR) {
        forecastEmptyAt = iso(at + Math.max(0, left) / rate * HOUR)
        break
      }
      left -= rate * (end - at) / HOUR
      at = end
    }
  }
  return { dailyBurn, forecastEmptyAt }
}

function routingRates(balances, shares, rate) {
  const available = balances.map((v, i) => v > EPS ? i : -1).filter((i) => i >= 0)
  const weight = available.reduce((s, i) => s + shares[i], 0)
  return balances.map((v, i) => v > EPS ? rate * (weight > 0 ? shares[i] / weight : 1 / available.length) : 0)
}

// Bring fresh readings to a common origin using the same redistribution as the
// forecast. Later observations re-anchor their account, rather than being aged
// twice. Backward fill between staggered observations uses the fitted shares.
function currentBalances(rows, model, now) {
  const observed = rows.map((r) => {
    const at = stamp(r.observedAt)
    return r.left > 0 && Number.isFinite(at) ? Math.min(now, at) : now
  })
  let at = Math.min(now, ...observed)
  const balances = rows.map((r, i) => clamp(r.left + (r.left > 0 ? demandBetween(model, at, observed[i]) * model.shares[i] : 0)))
  const anchors = [...new Set(observed.filter((t) => t > at))].sort((a, b) => a - b)
  let anchor = 0
  while (at < now - 0.001) {
    const boundary = Math.min(now, nextHour(at, model.offsetMin), anchors[anchor] ?? Infinity)
    const rates = routingRates(balances, model.shares, model.rateAt(at))
    const depletionTimes = balances.map((balance, i) => rates[i] > 0 ? at + balance / rates[i] * HOUR : Infinity)
    const next = Math.min(boundary, ...depletionTimes)
    for (let i = 0; i < rows.length; i++) {
      balances[i] = depletionTimes[i] <= next + 0.001 ? 0 : Math.max(0, balances[i] - rates[i] * (next - at) / HOUR)
    }
    at = next
    if (Math.abs(at - (anchors[anchor] ?? Infinity)) < 0.001) {
      for (let i = 0; i < rows.length; i++) if (observed[i] === anchors[anchor]) balances[i] = clamp(rows[i].left)
      anchor++
    }
  }
  return balances
}

// Simulate hourly demand with exact depletion/reset events. Unserved demand is
// censored during blackouts, and the schedule resumes at replenishment.
export function simulatePool(rows, model, now, end, { factor = 1, reservePct = 0, record = true } = {}) {
  const shares = model.shares
  const balances = currentBalances(rows, model, now).map((v) => Math.max(0, v - reservePct))
  const resets = rows.map((r) => stamp(r.reset))
  const cycles = rows.map((r) => stamp(r.reset) - stamp(r.start))
  const samples = record ? new Map() : null
  const mean = () => balances.reduce((s, v) => s + v, 0) / rows.length
  const emit = (at, left = mean()) => { if (record) samples.set(Math.round(at), { at: iso(Math.round(at)), left: round1(left) }) }
  let firstEmptyAt = null, firstEmptyLabel = null, emptyAt = null, projectedLeftAtReset = null
  const firstReset = Math.min(...resets)
  const check = (at, ignore = new Set()) => {
    if (firstEmptyAt == null) {
      const j = balances.findIndex((v, i) => v <= EPS && !ignore.has(i))
      if (j >= 0) { firstEmptyAt = at; firstEmptyLabel = rows[j].label }
    }
    if (balances.every((v) => v <= EPS) && emptyAt == null) emptyAt = at
    return emptyAt != null && emptyAt < end - 0.001
  }
  if (check(now) && !record) return { safe: false }
  emit(now)
  let at = now
  while (at < end - 0.001) {
    const boundary = Math.min(end, nextHour(at, model.offsetMin), ...resets)
    const rate = Math.max(0, model.rateAt(at) * factor)
    const rates = routingRates(balances, shares, rate)
    const depletionTimes = balances.map((balance, i) => rates[i] > 0 ? at + balance / rates[i] * HOUR : Infinity)
    const next = Math.min(boundary, ...depletionTimes)
    for (let i = 0; i < balances.length; i++) {
      // Explicitly drain event participants even when subtracting absolute
      // timestamps leaves a tiny positive remainder through rounding.
      balances[i] = depletionTimes[i] <= next + 0.001 ? 0 : Math.max(0, balances[i] - rates[i] * (next - at) / HOUR)
    }
    at = next
    if (at < boundary - 0.001) {
      if (check(at) && !record) return { safe: false }
      emit(at)
      continue
    }
    const resetting = new Set(resets.map((r, i) => Math.abs(r - at) < 0.001 ? i : -1).filter((i) => i >= 0))
    if (resetting.size) {
      if (Math.abs(at - firstReset) < 0.001) projectedLeftAtReset = round1(mean())
      emit(at - 1)
      for (const i of resetting) {
        balances[i] = Math.max(0, 100 - reservePct)
        resets[i] += cycles[i]
      }
    }
    if (check(at) && !record) return { safe: false }
    emit(at)
  }
  return { safe: emptyAt == null || emptyAt >= end - 0.001, emptyAt: emptyAt == null ? null : iso(emptyAt), firstEmptyAt: firstEmptyAt == null ? null : iso(firstEmptyAt), firstEmptyLabel, projectedLeftAtReset, projection: record ? [...samples.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)) : [] }
}

function guidanceFor(rows, windows, model, now, status, forecast, reservePct) {
  const resetAt = Math.max(...rows.map((r) => stamp(r.reset)))
  const nextResetAt = Math.min(...rows.map((r) => stamp(r.reset)))
  const daily = demandBetween(model, now, now + DAY)
  const budget = rows.reduce((sum, r) => sum + Math.max(0, r.left - reservePct) * DAY / (stamp(r.reset) - now), 0) / rows.length
  const guidance = {
    action: "observe", changePct: null, factor: null,
    currentDailyBurn: status === "ready" ? daily / rows.length : null,
    targetDailyBurn: budget,
    resetAt: iso(resetAt), nextResetAt: iso(nextResetAt), reservePct,
    confidence: model.confidence, coverageHours: model.coverageHours, seasonal: model.seasonal,
    accountsEmpty: rows.filter((r) => r.left <= 0).length, totalAccounts: rows.length,
    firstEmptyAt: forecast.firstEmptyAt, firstEmptyLabel: forecast.firstEmptyLabel, emptyAt: forecast.emptyAt,
    assumption: rows.length > 1 ? "equal-capacity-transferable" : null,
    shortLimited: windows.filter((w) => w.provider.toLowerCase() === rows[0].provider.toLowerCase() && !w.binding && stamp(w.reset) - stamp(w.start) < 6 * DAY && (w.pace === "hot" || w.left <= 0)).map((w) => ({ label: w.label, window: w.window, left: w.left, reset: w.reset })),
  }
  if (guidance.accountsEmpty === rows.length) { guidance.action = "wait"; return guidance }
  if (status === "stale") { guidance.action = "stale"; return guidance }
  if (status !== "ready" || model.coverageHours < 6 - EPS) return guidance
  if (!(daily > EPS)) { guidance.action = guidance.shortLimited.length ? "short_limited" : "idle"; return guidance }
  let low = 0, high = 1
  const safe = (factor) => simulatePool(rows, model, now, resetAt, { factor, reservePct, record: false }).safe
  // Bounded bracketing avoids unbounded work/percentages for near-zero demand.
  while (high < 65536 && safe(high)) { low = high; high *= 2 }
  if (high === 65536 && safe(high)) {
    guidance.action = "idle"
    return guidance
  }
  for (let i = 0; i < 48; i++) {
    const mid = (low + high) / 2
    if (safe(mid)) low = mid
    else high = mid
  }
  const factor = (low + high) / 2
  const blackoutBeforeEnd = forecast.emptyAt != null && stamp(forecast.emptyAt) < resetAt
  const action = factor < 0.9 || (factor < 1 && blackoutBeforeEnd) ? "reduce" : factor > 1.1 ? "increase" : "hold"
  if (action === "increase" && guidance.shortLimited.length) {
    guidance.action = "short_limited"
    guidance.targetDailyBurn = null
    return guidance
  }
  guidance.action = action
  guidance.factor = factor
  guidance.changePct = (factor - 1) * 100
  guidance.targetDailyBurn = daily * factor / rows.length
  return guidance
}

export function providerForecasts(binding, histories, windows, now, options = {}) {
  const groups = new Map()
  for (const w of binding) {
    const id = w.provider.toLowerCase()
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id).push(w)
  }
  const reservePct = Number.isFinite(options.reservePct) ? clamp(options.reservePct) : 3
  const rank = { codex: 0, claude: 1 }
  return [...groups].map(([id, rows]) => {
    const tracks = rows.map((r) => ({ points: histories.find((h) => h.id === r.label && h.provider.toLowerCase() === id)?.points || [] }))
    const model = estimateDemand(tracks, now, options)
    const next = rows.reduce((a, b) => stamp(a.reset) < stamp(b.reset) ? a : b)
    const stale = rows.some((r) => r.left > 0 && (!Number.isFinite(stamp(r.observedAt)) || now - stamp(r.observedAt) > 30 * 60000))
    const status = stale ? "stale" : model.level == null || model.coverageHours < MIN_FORECAST_HOURS - EPS ? "insufficient" : "ready"
    const exhausted = rows.every((r) => r.left <= 0)
    const forecast = status === "ready" ? simulatePool(rows, model, now, now + 15 * DAY) : {
      emptyAt: exhausted ? iso(now) : null,
      firstEmptyAt: rows.some((r) => r.left <= 0) ? iso(now) : null,
      firstEmptyLabel: rows.find((r) => r.left <= 0)?.label || null,
      projectedLeftAtReset: null, projection: [],
    }
    return {
      id, label: id === "codex" ? "Codex" : id === "claude" ? "Claude" : rows[0].provider,
      left: round1(rows.reduce((s, r) => s + r.left, 0) / rows.length), accounts: rows.length, status,
      resetAt: next.reset, resetLabel: next.label + " · " + next.window,
      accountsDetail: rows.map(({ label, window, start, reset }) => ({ label, window, start, reset })),
      emptyAt: forecast.emptyAt, firstEmptyAt: forecast.firstEmptyAt, firstEmptyLabel: forecast.firstEmptyLabel,
      projectedLeftAtReset: forecast.projectedLeftAtReset, projection: forecast.projection,
      guidance: guidanceFor(rows, windows, model, now, status, forecast, reservePct),
      method: model.method, coverageHours: model.coverageHours,
    }
  }).sort((a, b) => (rank[a.id] ?? 9) - (rank[b.id] ?? 9) || a.label.localeCompare(b.label))
}
