import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { analyze } from "../lib/scan.mjs"
import { demandBetween, estimateDemand, simulatePool } from "../lib/forecast.mjs"

const HOUR = 3600000, DAY = 24 * HOUR
const now = Date.parse("2026-07-15T12:00:00Z")
const iso = (t) => new Date(t).toISOString()
const near = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`)
const raw = (at, left, reset = now + 3 * DAY) => ({ at, left, start: reset - 7 * DAY, reset })
const readings = (hours, daily, left = 30, reset = now + 3 * DAY) => Array.from({ length: hours + 1 }, (_, i) => raw(now - (hours - i) * HOUR, left + (hours - i) * daily / 24, reset))
const quotaPoints = (points) => points.map((p) => ({ at: iso(p.at), left: p.left, start: iso(p.start), resetsAt: iso(p.reset) }))
async function dashboard(accounts, options = {}, records = []) {
  const quota = Object.fromEntries(Object.entries(accounts).map(([name, points]) => [`codex|${name}`, { week: quotaPoints(points) }]))
  return analyze(quota, records, now, { offsetMin: 0, ...options })
}
const flat = (rate, shares = [1]) => ({ level: rate, shares, offsetMin: 0, rateAt: () => rate })
const row = (label, left, reset, observedAt = now) => ({ label, left, reset: iso(reset), start: iso(reset - 7 * DAY), observedAt: iso(observedAt) })

test("constant 6h, 12h and three-day observations retain the same rate", () => {
  for (const hours of [6, 12, 72]) {
    const model = estimateDemand([{ points: readings(hours, 15) }], now)
    near(demandBetween(model, now, now + DAY), 15)
    near(model.coverageHours, hours)
    assert.equal(model.seasonal, hours < 48 ? "none" : "daily")
  }
})

test("EWMA responds to recent speed changes and uses observed time across gaps", () => {
  const points = []
  for (let i = 0; i <= 36; i++) points.push(raw(now - (36 - i) * HOUR, 90 - Math.min(i, 24) - Math.max(0, i - 24) * 3))
  const model = estimateDemand([{ points }], now)
  const recentDecay = 2 ** (-12 / 24)
  near(model.level, (3 - 2.5 * recentDecay) / (1 - 0.5 * recentDecay))
  assert.ok(model.level > 1 && model.level < 3)
  const separated = [raw(now - 52 * HOUR, 90), raw(now - 48 * HOUR, 86), raw(now - 4 * HOUR, 96), raw(now, 84)]
  const gap = estimateDemand([{ points: separated }], now)
  near(gap.level, (3 + 2 ** (-4 / 24)) / (1 + 2 ** (-4 / 24)))
  near(gap.coverageHours, 8)
})

test("a one-second leading spike is weighted by its duration, not treated as a full prior", () => {
  const points = [raw(now - 6 * HOUR - 1000, 100), raw(now - 6 * HOUR, 99), raw(now, 99)]
  const model = estimateDemand([{ points }], now)
  const daily = demandBetween(model, now, now + DAY)
  // One point over slightly more than six hours is below four points/day;
  // weighting the newer idle hours more heavily must lower it further.
  assert.ok(daily > 3 && daily < 4, `unexpected daily demand: ${daily}`)
  near(model.coverageHours, 6 + 1 / 3600)
})

test("high rates and tiny balances always terminate in both simulation origins", () => {
  const source = `
    import { simulatePool } from ${JSON.stringify(new URL("../lib/forecast.mjs", import.meta.url).href)};
    const now = ${now}, HOUR = ${HOUR}, DAY = ${DAY};
    const iso = at => new Date(at).toISOString();
    const model = { level: 999, shares: [1], offsetMin: 0, rateAt: () => 999 };
    for (const left of [1, 1e-7]) for (const observedAt of [now, now - HOUR / 2]) {
      const row = { label: 'a', left, start: iso(now - 4 * DAY), reset: iso(now + 3 * DAY), observedAt: iso(observedAt) };
      const result = simulatePool([row], model, now, now + DAY);
      if (!result.emptyAt || result.projection.some(p => !Number.isFinite(p.left))) throw Error('invalid simulation');
    }
  `
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", timeout: 3000 })
  assert.equal(result.status, 0, result.error?.message || result.stderr)
})

test("positive-quota idle lowers demand while an exhausted pool is censored", () => {
  const active = [raw(now - 30 * HOUR, 40), raw(now - 24 * HOUR, 34)]
  const idle = estimateDemand([{ points: [...active, raw(now, 34)] }], now)
  near(idle.level, (1 - 2 ** (-6 / 24)) * 0.5 / (1 - 2 ** (-30 / 24)))
  const exhausted = estimateDemand([{ points: [raw(now - 30 * HOUR, 6), raw(now - 24 * HOUR, 0), raw(now, 0)] }], now)
  near(exhausted.level, 1)
  near(exhausted.coverageHours, 6)
  const unknown = estimateDemand([{ points: [raw(now - 24 * HOUR, 0), raw(now, 0)] }], now)
  assert.equal(unknown.level, null)
})

test("partial hours are time weighted; increases and cycle changes are unknown", () => {
  const points = [raw(now - 2 * HOUR, 30), raw(now - 1.75 * HOUR, 29), raw(now - 0.75 * HOUR, 25)]
  const model = estimateDemand([{ points }], now)
  near(model.level, 4)
  near(model.coverageHours, 1.25)
  const ignored = estimateDemand([{ points: [raw(now - 2 * HOUR, 30), raw(now - HOUR, 40), raw(now, 20, now + 4 * DAY)] }], now)
  assert.equal(ignored.level, null)
})

// Dense valid cycles with explicit reset observations preserve every hour.
function seasonalReadings(hours, rateAt, offsetMin = 0) {
  const points = []
  let left = 100, reset = now - hours * HOUR + 7 * DAY
  points.push(raw(now - hours * HOUR, left, reset))
  for (let at = now - hours * HOUR; at < now; at += HOUR) {
    left -= rateAt(new Date(at + offsetMin * 60000))
    points.push(raw(at + HOUR, left, reset))
    if (at + HOUR === reset) {
      left = 100
      reset += 7 * DAY
      points.push(raw(at + HOUR, left, reset))
    }
  }
  return points
}

test("daily and weekly profiles need complete dense repeats, honor server offset, and shrink", () => {
  const offsetMin = 330
  const dailyRate = (d) => d.getUTCHours() < 12 ? 0.1 : 0.3
  const daily = estimateDemand([{ points: seasonalReadings(72, dailyRate, offsetMin) }], now, { offsetMin })
  assert.equal(daily.method, "daily-ewma")
  assert.equal(daily.confidence, "medium")
  // 12:00Z is 17:30 local; the daily factor changes at local midnight.
  assert.ok(daily.rateAt(now) > daily.rateAt(now + 8 * HOUR))
  assert.ok(daily.rateAt(now) / daily.rateAt(now + 8 * HOUR) < 3)
  const weekly = estimateDemand([{ points: seasonalReadings(14 * 24, (d) => d.getUTCDay() === 0 ? 0.4 : 0.1) }], now)
  assert.equal(weekly.method, "weekly-ewma")
  assert.equal(weekly.confidence, "high")
  const sparse = estimateDemand([{ points: [raw(now - 72 * HOUR, 90), raw(now, 30)] }], now)
  assert.equal(sparse.method, "ewma")
  assert.equal(sparse.confidence, "low")
  const incomplete = seasonalReadings(47, dailyRate)
  assert.equal(estimateDemand([{ points: incomplete }], now).method, "ewma")
})

test("pooling sums simultaneous demand through account switches without double counting", () => {
  const a = [raw(now - 12 * HOUR, 60), raw(now - 6 * HOUR, 48), raw(now, 48)]
  const b = [raw(now - 12 * HOUR, 60), raw(now - 6 * HOUR, 60), raw(now, 48)]
  const model = estimateDemand([{ points: a }, { points: b }], now)
  near(model.level, 2)
  near(model.coverageHours, 12)
  near(demandBetween(model, now, now + DAY), 48)
  const absent = estimateDemand([{ points: a }, { points: [raw(now, 48)] }], now)
  near(absent.level, estimateDemand([{ points: a }], now).level)
  near(absent.coverageHours, 12)
  assert.deepEqual(absent.shares, [1, 0])
  const exhausted = estimateDemand([{ points: [raw(now - 6 * HOUR, 0), raw(now, 0)] }, { points: [raw(now - 6 * HOUR, 60), raw(now, 48)] }], now)
  near(exhausted.level, 2)
  near(exhausted.coverageHours, 6)
})

test("idle reserves receive redistributed demand and eventually empty", () => {
  const result = simulatePool([row("busy", 10, now + 3 * DAY), row("reserve", 90, now + 3 * DAY)], flat(10, [1, 0]), now, now + DAY)
  assert.equal(result.firstEmptyAt, iso(now + HOUR))
  assert.equal(result.firstEmptyLabel, "busy")
  assert.equal(result.emptyAt, iso(now + 10 * HOUR))
  assert.equal(result.projection.find((p) => p.at === result.emptyAt).left, 0)
})

test("pool coverage intersects comparable intervals only after each first observation", () => {
  const a = [raw(now - 12 * HOUR, 80), raw(now - 6 * HOUR, 74), raw(now - 2 * HOUR, 80), raw(now, 78)]
  const b = [raw(now - 8 * HOUR, 80), raw(now - 4 * HOUR, 76), raw(now, 72)]
  const model = estimateDemand([{ points: a }, { points: b }], now)
  // Four solo hours precede B's first observation, followed by four common
  // hours. The invalid increase in A remains unknown after B has joined.
  near(model.coverageHours, 8)
  const decay = 2 ** (-4 / 24)
  near(model.level, (decay + 2) / (decay + 1))
})

test("fresh lagged readings use redistribution before the forecast origin", () => {
  const result = simulatePool([row("busy", 1, now + 3 * DAY, now - HOUR / 2), row("reserve", 90, now + 3 * DAY, now - HOUR / 2)], flat(10, [1, 0]), now, now + DAY)
  // Five points were consumed since observation: one from busy and four from reserve.
  assert.equal(result.projection[0].left, 86)
  assert.equal(result.emptyAt, iso(now + 8.6 * HOUR))
  const staggered = simulatePool([row("busy", 10, now + 3 * DAY, now - HOUR / 3), row("reserve", 90, now + 3 * DAY, now - HOUR / 6)], flat(10, [1, 0]), now, now + DAY)
  assert.equal(staggered.firstEmptyAt, iso(now + HOUR * 2 / 3))
})

test("depletions are exact inside an hour, and reset-at-zero has no phantom blackout", () => {
  const exact = simulatePool([row("a", 12, now + 2 * HOUR)], flat(10), now, now + HOUR * 1.5)
  assert.equal(exact.firstEmptyAt, iso(now + 1.2 * HOUR))
  assert.equal(exact.emptyAt, exact.firstEmptyAt)
  const immediate = simulatePool([row("a", 10, now + HOUR)], flat(10), now, now + 2 * HOUR)
  assert.equal(immediate.emptyAt, null)
  assert.equal(immediate.firstEmptyAt, null)
  assert.equal(immediate.projectedLeftAtReset, 0)
  assert.deepEqual(immediate.projection.filter((p) => Date.parse(p.at) >= now + HOUR - 1 && Date.parse(p.at) <= now + HOUR), [
    { at: iso(now + HOUR - 1), left: 0, capacity: 100, accounts: 1 }, { at: iso(now + HOUR), left: 100, capacity: 100, accounts: 1 },
  ])
})

test("blackout after an earlier reset is retained and service resumes at later replenishment", () => {
  const result = simulatePool([row("a", 10, now + HOUR), row("b", 0, now + 24 * HOUR)], flat(10, [1, 0]), now, now + 25 * HOUR)
  assert.equal(result.emptyAt, iso(now + 11 * HOUR))
  assert.equal(result.projection.find((p) => p.at === iso(now + 24 * HOUR)).left, 100)
  assert.equal(result.projection.at(-1).left, 90)
})

test("guidance solves exact constant budgets: reduce 40%, increase 80%, reserve parameter", async () => {
  for (const [daily, factor, action] of [[15, 0.6, "reduce"], [5, 1.8, "increase"], [9, 1, "hold"]]) {
    const p = (await dashboard({ a: readings(12, daily) })).providers[0]
    near(p.guidance.factor, factor)
    near(p.guidance.changePct, (factor - 1) * 100, 1e-5)
    near(p.guidance.currentDailyBurn, daily)
    near(p.guidance.targetDailyBurn, 9)
    assert.equal(p.guidance.action, action)
    assert.equal(p.guidance.reservePct, 3)
    assert.equal(p.guidance.assumption, null)
  }
  const custom = (await dashboard({ a: readings(12, 15) }, { reservePct: 6 })).providers[0].guidance
  near(custom.targetDailyBurn, 8)
  near(custom.factor, 8 / 15)
})

test("guidance respects the budget before a staggered reset, not just the final total", async () => {
  const p = (await dashboard({ a: readings(12, 24, 12, now + 12 * HOUR), b: readings(12, 0, 0, now + DAY) })).providers[0]
  // Only nine usable points exist for the first twelve hours, at one point/hour.
  near(p.guidance.factor, 0.75)
  assert.equal(p.guidance.resetAt, iso(now + DAY))
  assert.equal(p.guidance.nextResetAt, iso(now + 12 * HOUR))
  near(p.guidance.targetDailyBurn, 18)
})

test("guidance holds within ten percent but reduces for blackout before the planning end", async () => {
  for (const daily of [8.5, 9.5]) assert.equal((await dashboard({ a: readings(12, daily) })).providers[0].guidance.action, "hold")
  // A zero reserve makes the plan's safety threshold the actual depletion.
  const p = (await dashboard({ a: readings(12, 10.2) }, { reservePct: 0 })).providers[0]
  assert.equal(p.guidance.action, "reduce")
  assert.ok(p.guidance.factor > 0.9)
})

test("a few seconds of data cannot produce a precise depletion forecast", async () => {
  const p = (await dashboard({ a: [raw(now - 1000, 31), raw(now, 30)] })).providers[0]
  assert.equal(p.status, "insufficient")
  assert.equal(p.emptyAt, null)
  assert.deepEqual(p.projection, [])
  assert.equal(p.guidance.action, "observe")
  assert.equal(p.guidance.changePct, null)
  const valid = (await dashboard({ a: [raw(now - HOUR / 3, 31), raw(now, 30)] })).providers[0]
  assert.equal(valid.status, "ready")
  assert.equal(valid.guidance.action, "observe")
})

test("zero demand has a finite idle budget; insufficient, short, and stale history suppress percentages", async () => {
  const idle = (await dashboard({ a: readings(12, 0) })).providers[0].guidance
  assert.equal(idle.action, "idle")
  assert.equal(idle.currentDailyBurn, 0)
  assert.equal(idle.factor, null)
  assert.equal(idle.changePct, null)
  near(idle.targetDailyBurn, 9)
  for (const points of [[raw(now, 30)], readings(5, 15)]) {
    const p = (await dashboard({ a: points })).providers[0]
    assert.equal(p.guidance.action, "observe")
    assert.equal(p.guidance.changePct, null)
    assert.equal(p.guidance.factor, null)
    if (p.status !== "ready") assert.deepEqual(p.projection, [])
  }
  const old = readings(12, 15).map((p) => ({ ...p, at: p.at - HOUR }))
  const records = [{ t: iso(now - 60000), provider: "codex", providerAccount: "a", status: 200, in: 10, out: 5 }]
  const p = (await dashboard({ a: old }, {}, records)).providers[0]
  assert.equal(p.guidance.action, "stale")
  assert.equal(p.guidance.changePct, null)
  assert.deepEqual(p.projection, [])
})

test("exhausted pools wait even without a usable rate, and multi-account plans expose the assumption", async () => {
  const p = (await dashboard({ a: readings(12, 0, 0), b: readings(12, 0, 0, now + 4 * DAY) })).providers[0]
  assert.equal(p.guidance.action, "wait")
  assert.equal(p.guidance.accountsEmpty, 2)
  assert.equal(p.guidance.changePct, null)
  assert.equal(p.emptyAt, iso(now))
  assert.equal(p.guidance.resetAt, iso(now + 4 * DAY))
  assert.equal(p.guidance.nextResetAt, iso(now + 3 * DAY))
  assert.equal(p.guidance.assumption, "equal-capacity-transferable")
})

test("a hot or exhausted short window blocks acceleration", async () => {
  const week = quotaPoints(readings(12, 5))
  const short = quotaPoints([raw(now - HOUR, 30, now + 2 * HOUR), raw(now, 0, now + 2 * HOUR)]).map((p) => ({ ...p, start: iso(now - 3 * HOUR) }))
  const dash = await analyze({ "codex|a": { week, short } }, [], now, { offsetMin: 0 })
  const g = dash.providers[0].guidance
  assert.equal(g.action, "short_limited")
  assert.equal(g.factor, null)
  assert.equal(g.changePct, null)
  assert.deepEqual(g.shortLimited, [{ label: "codex · a", window: "short", left: 0, reset: iso(now + 2 * HOUR) }])
})

test("future readings cannot affect selection, left, rate, or guidance", async () => {
  const past = readings(12, 15)
  const expected = await dashboard({ a: past })
  const actual = await dashboard({ a: [...past, raw(now + HOUR, 0, now + 4 * DAY)], future: [raw(now + HOUR, 100)] })
  assert.deepEqual(actual.providers, expected.providers)
  assert.deepEqual(actual.windows, expected.windows)
})
