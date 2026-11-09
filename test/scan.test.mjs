import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { analyze } from "../lib/scan.mjs"
import { createServer } from "node:http"

import { createHandler, hostAllowed, loadDashboard, originAllowed, resolveDir, tokenOk } from "../lib/server.mjs"

const DAY = 24 * 3600 * 1000
const HOUR = 3600 * 1000
const now = Date.parse("2026-07-15T12:00:00Z")

function iso(ms) {
  return new Date(ms).toISOString()
}

test("a window behind an even burn is fast, and only its own remaining counts", async () => {
  const start = now - 2 * DAY
  const quota = {
    "codex|a@b.c": {
      "7 days": [
        { at: iso(start), left: 40, start: iso(start), resetsAt: iso(now + 5 * DAY) },
        { at: iso(now - 60 * 1000), left: 10, start: iso(start), resetsAt: iso(now + 5 * DAY) },
      ],
      "5 hours": [
        { at: iso(now - 60 * 1000), left: 95, start: iso(now - HOUR), resetsAt: iso(now + 4 * HOUR) },
      ],
    },
  }
  const records = [
    { t: iso(start - 2 * HOUR), provider: "other", providerAccount: "x", callerKeyName: "别人", in: 1, out: 1 },
    { t: iso(now - 30 * HOUR), provider: "Codex", providerAccount: "A@B.C", callerKeyName: "张三", in: 25000, out: 25000, session: "secret-session", err: "secret-error" },
    { t: iso(now - 1000), rejected: true, provider: "codex", providerAccount: "a@b.c", callerKeyName: "张三", in: 999999, out: 999999 },
  ]
  const dash = await analyze(quota, records, now, { offsetMin: 0 })
  assert.equal(dash.verdict.id, "tighten")
  assert.equal(dash.verdict.shortOnly, false)
  assert.equal(dash.verdict.worst.label, "codex · a@b.c")
  assert.equal(dash.verdict.worst.window, "7 days")
  assert.ok(Math.abs(dash.verdict.worst.hoursToEmpty - 16) < 0.2)
  assert.equal(dash.reserve.accounts, 1)
  assert.equal(dash.reserve.left, 10)
  assert.equal(dash.reserve.partial, false)
  assert.ok(Math.abs(dash.reserve.remainingTokens - (50000 * 10) / 90) < 0.01)
  assert.equal(JSON.stringify(dash).includes("secret-session"), false)
  assert.equal(JSON.stringify(dash).includes("secret-error"), false)

  const week = dash.windows.find((w) => w.window === "7 days")
  const five = dash.windows.find((w) => w.window === "5 hours")
  assert.equal(week.binding, true)
  assert.equal(week.pace, "hot")
  assert.equal(week.gap, -61.4)
  assert.equal(five.binding, false)
  assert.equal(five.pace, "cool")
  assert.equal(five.tokens, 0)

  const zhang = dash.people.find((p) => p.name === "张三")
  assert.equal(zhang.h24.tokens, 0)
  assert.equal(zhang.d3.tokens, 50000)
  assert.equal(zhang.d7.calls, 1)
  assert.equal(dash.candles.find((c) => c.day === "2026-07-15").open, 10)
  assert.equal(dash.candles.find((c) => c.day === "2026-07-14").volume, 50000)
})

test("provider forecasts use pooled observed burn and include every account", async () => {
  const start = now - 3 * DAY
  const reset = iso(start + 7 * DAY)
  const points = (fromLeft, toLeft) => [
    { at: iso(start), left: fromLeft, start: iso(start), resetsAt: reset },
    { at: iso(now), left: toLeft, start: iso(start), resetsAt: reset },
  ]
  const dash = await analyze({
    "codex|a": { week: points(80, 40) },
    "Codex|b": { week: points(90, 80) },
    "claude|c": { week: points(90, 80) },
  }, [], now, { offsetMin: 0 })
  assert.deepEqual(dash.providers.map((p) => p.id), ["codex", "claude"])
  const codex = dash.providers[0]
  assert.equal(codex.left, 60)
  assert.equal(codex.accounts, 2)
  assert.equal(codex.status, "ready")
  assert.equal(codex.firstEmptyAt, iso(now + 3 * DAY))
  assert.equal(codex.emptyAt, null)
  assert.equal(codex.resetAt, reset)
  assert.equal(codex.projection[0].left, 60)
  assert.equal(codex.projection[1].left, 59.7)
  assert.equal(codex.projection.find((p) => p.at === iso(now + DAY)).left, 51.7)
  assert.equal(codex.projection.at(-1).at, iso(now + 15 * DAY))
  assert.equal(dash.providers[1].resetAt, reset)
})

test("one empty account does not mean the whole provider is empty", async () => {
  const start = now - 2 * DAY
  const reset = iso(start + 7 * DAY)
  const points = (fromLeft, toLeft) => [
    { at: iso(now - 2 * HOUR), left: fromLeft, start: iso(start), resetsAt: reset },
    { at: iso(now), left: toLeft, start: iso(start), resetsAt: reset },
  ]
  const dash = await analyze({
    "codex|busy": { week: points(30, 10) },
    "codex|idle": { week: points(90, 90) },
  }, [], now, { offsetMin: 0 })
  const codex = dash.providers[0]
  assert.equal(codex.firstEmptyAt, iso(now + HOUR))
  assert.equal(codex.emptyAt, iso(now + 10 * HOUR))
  assert.equal(codex.projectedLeftAtReset, 0)
  assert.equal(codex.projection.find((p) => p.at === iso(now + HOUR)).left, 45)
})

test("an all-account forecast requires every account to have a fresh trajectory", async () => {
  const start = now - 2 * DAY
  const reset = iso(start + 7 * DAY)
  const dash = await analyze({
    "codex|known": { week: [
      { at: iso(now - 2 * HOUR), left: 30, start: iso(start), resetsAt: reset },
      { at: iso(now), left: 10, start: iso(start), resetsAt: reset },
    ] },
    "codex|unknown": { week: [
      { at: iso(now), left: 90, start: iso(start), resetsAt: reset },
    ] },
  }, [], now, { offsetMin: 0 })
  const codex = dash.providers[0]
  assert.equal(codex.status, "insufficient")
  assert.equal(codex.emptyAt, null)
  assert.equal(codex.projectedLeftAtReset, null)
  assert.deepEqual(codex.projection, [])
})

test("staggered resets do not hide another account's later depletion", async () => {
  const start = now - 2 * DAY
  const dash = await analyze({
    "codex|reset-first": { week: [
      { at: iso(now - 2 * HOUR), left: 100, start: iso(start), resetsAt: iso(start + 7 * DAY) },
      { at: iso(now), left: 100, start: iso(start), resetsAt: iso(start + 7 * DAY) },
    ] },
    "codex|empty-later": { week: [
      { at: iso(now - 2 * HOUR), left: 30, start: iso(now - 4 * DAY), resetsAt: iso(now + 3 * DAY) },
      { at: iso(now), left: 20, start: iso(now - 4 * DAY), resetsAt: iso(now + 3 * DAY) },
    ] },
  }, [], now, { offsetMin: 0 })
  const codex = dash.providers[0]
  assert.equal(codex.resetAt, iso(now + 3 * DAY))
  assert.equal(codex.firstEmptyAt, iso(now + 4 * HOUR))
  assert.equal(codex.firstEmptyLabel, "codex · empty-later")
  assert.equal(codex.emptyAt, iso(now + 24 * HOUR))
  assert.equal(codex.projectedLeftAtReset, 0)
  assert.equal(codex.projection.at(-1).at, iso(now + 15 * DAY))
})

test("absolute depletion is anchored to the latest reading and stale pools are not forecast", async () => {
  const start = now - 2 * DAY
  const reset = iso(start + 7 * DAY)
  const dash = await analyze({
    "codex|stale": { week: [
      { at: iso(now - 3 * HOUR), left: 50, start: iso(start), resetsAt: reset },
      { at: iso(now - 2 * HOUR), left: 40, start: iso(start), resetsAt: reset },
    ] },
  }, [{ t: iso(now - HOUR), provider: "codex", providerAccount: "stale", status: 200, in: 10, out: 5 }], now, { offsetMin: 0 })
  assert.equal(dash.windows[0].forecastEmptyAt, iso(now - 2 * HOUR + 4 * HOUR))
  assert.equal(dash.providers[0].status, "stale")
  assert.equal(dash.providers[0].emptyAt, null)
  assert.deepEqual(dash.providers[0].projection, [])
})

test("a lagging snapshot without later calls is retained at the forecast origin", async () => {
  const start = now - 2 * DAY
  const reset = iso(start + 7 * DAY)
  const dash = await analyze({
    "codex|lagging": { week: [
      { at: iso(now - 30 * 60000), left: 40, start: iso(start), resetsAt: reset },
      { at: iso(now - 10 * 60000), left: 20, start: iso(start), resetsAt: reset },
    ] },
  }, [], now, { offsetMin: 0 })
  const codex = dash.providers[0]
  assert.equal(codex.status, "ready")
  assert.equal(codex.left, 20)
  assert.equal(codex.projection[0].at, iso(now))
  assert.equal(codex.projection[0].left, 20)
  assert.equal(codex.emptyAt, iso(now + 20 * 60000))
  assert.equal(codex.projectedLeftAtReset, 0)
})

test("forecasts use week windows and ignore shorter quota windows", async () => {
  const start = now - 2 * DAY
  const weekReset = iso(start + 7 * DAY)
  const dash = await analyze({
    "codex|mixed": {
      "7 days": [
        { at: iso(now - 2 * HOUR), left: 70, start: iso(start), resetsAt: weekReset },
        { at: iso(now), left: 40, start: iso(start), resetsAt: weekReset },
      ],
      "5 hours": [
        { at: iso(now - HOUR), left: 95, start: iso(now - HOUR), resetsAt: iso(now + 4 * HOUR) },
      ],
    },
  }, [], now, { offsetMin: 0 })
  assert.equal(dash.windows.length, 2)
  assert.equal(dash.providers[0].accounts, 1)
  assert.equal(dash.providers[0].left, 40)
  assert.equal(dash.providers[0].resetAt, weekReset)
  assert.equal(dash.providers[0].accountsDetail[0].window, "7 days")
})

test("hot short windows cannot hide weekly accounts or enter weekly history", async () => {
  const start = now - 2 * DAY
  const reset = iso(start + 7 * DAY)
  const short = [
    { at: iso(now - HOUR), left: 30, start: iso(now - 3 * HOUR), resetsAt: iso(now + 2 * HOUR) },
    { at: iso(now), left: 10, start: iso(now - 3 * HOUR), resetsAt: iso(now + 2 * HOUR) },
  ]
  const exhausted = {
    week: [
      { at: iso(now - HOUR), left: 0, start: iso(start), resetsAt: reset },
      { at: iso(now), left: 0, start: iso(start), resetsAt: reset },
    ],
    short,
  }
  const dash = await analyze({
    "codex|exhausted": exhausted,
    "codex|healthy": { week: [
      { at: iso(now - HOUR), left: 80, start: iso(start), resetsAt: reset },
      { at: iso(now), left: 80, start: iso(start), resetsAt: reset },
    ] },
    "claude|short-only": { short },
  }, [], now, { offsetMin: 0 })
  assert.deepEqual(dash.providers.map((p) => p.id), ["codex"])
  const codex = dash.providers[0]
  assert.equal(codex.accounts, 2)
  assert.equal(codex.left, 40)
  assert.equal(codex.history.at(-1).left, 40)
  assert.equal(codex.accountsDetail.every((w) => w.window === "week"), true)
  assert.equal(dash.reserve.accounts, 2)
  assert.equal(dash.reserve.left, 40)
  assert.equal(dash.windows.find((w) => w.user === "exhausted" && w.window === "week").binding, true)
  assert.equal(dash.windows.filter((w) => w.window === "short").every((w) => !w.binding), true)

  const only = await analyze({ "codex|exhausted": exhausted }, [], now, { offsetMin: 0 })
  assert.equal(only.providers[0].accounts, 1)
  assert.equal(only.providers[0].left, 0)
  assert.equal(only.providers[0].emptyAt, iso(now))
  assert.equal(only.reserve.left, 0)
})

test("hourly weekly history preserves depletion and reset within the same hour", async () => {
  const resetAt = Date.parse("2026-07-15T09:35:00Z")
  const point = (at, left) => ({
    at,
    left,
    start: iso(Date.parse(at) < resetAt ? resetAt - 7 * DAY : resetAt),
    resetsAt: iso(Date.parse(at) < resetAt ? resetAt : resetAt + 7 * DAY),
  })
  const dash = await analyze({
    "codex|reset": { week: [
      point("2026-07-14T12:00:00Z", 60),
      point("2026-07-15T09:12:00Z", 20),
      point("2026-07-15T09:25:00Z", 0),
      point("2026-07-15T09:35:00Z", 100),
      point("2026-07-15T09:45:00Z", 80),
    ] },
  }, [], now, { offsetMin: 0 })
  const history = dash.providers[0].history
  assert.deepEqual(history.filter((p) => p.at.startsWith("2026-07-15T09:")), [
    { at: "2026-07-15T09:00:00.000Z", left: 60 },
    { at: "2026-07-15T09:25:00.000Z", left: 0 },
    { at: "2026-07-15T09:35:00.000Z", left: 100 },
    { at: "2026-07-15T09:45:00.000Z", left: 80 },
  ])
  for (let at = now - 24 * HOUR; at <= now; at += HOUR) {
    assert.ok(history.some((p) => p.at === iso(at)), `missing hourly sample at ${iso(at)}`)
  }
  assert.deepEqual(history.at(-1), { at: iso(now), left: 80 })
})

test("hourly history pools each account's current value at staggered and simultaneous updates", async () => {
  const start = now - 2 * DAY
  const point = (at, left) => ({ at, left, start: iso(start), resetsAt: iso(start + 7 * DAY) })
  const dash = await analyze({
    "codex|a": { week: [
      point("2026-07-15T09:00:00Z", 100),
      point("2026-07-15T09:10:00Z", 60),
      point("2026-07-15T09:11:00Z", 60),
      point("2026-07-15T09:12:00Z", 60),
      point("2026-07-15T09:30:00Z", 100),
    ] },
    "Codex|b": { week: [
      point("2026-07-15T09:00:00Z", 40),
      point("2026-07-15T09:20:00Z", 100),
      point("2026-07-15T09:30:00Z", 0),
    ] },
  }, [], now, { offsetMin: 0 })
  const history = dash.providers[0].history
  // Each update uses the other account's latest known value, regardless of reading frequency.
  // Partial 09:30 updates would invent a transient maximum of 100 or minimum of 30.
  assert.deepEqual(history.filter((p) => p.at.startsWith("2026-07-15T09:")), [
    { at: "2026-07-15T09:00:00.000Z", left: 70 },
    { at: "2026-07-15T09:10:00.000Z", left: 50 },
    { at: "2026-07-15T09:20:00.000Z", left: 80 },
    { at: "2026-07-15T09:30:00.000Z", left: 50 },
  ])
  assert.deepEqual(history.at(-1), { at: iso(now), left: 50 })
  assert.equal(Math.min(...history.map((p) => p.left)), 50)
})

test("weekly history starts only when all accounts are known and excludes future readings", async () => {
  const start = now - 2 * DAY
  const point = (at, left) => ({ at: iso(at), left, start: iso(start), resetsAt: iso(start + 7 * DAY) })
  const quota = {
    "codex|known": { week: [point(now - 20 * DAY, 80)] },
    "codex|new": { week: [
      point(now - 35 * 60000, 40),
      point(now - 15 * 60000, 20),
      point(now + 60000, 0),
    ] },
    "claude|future-only": { week: [point(now + 60000, 0)] },
  }
  const dash = await analyze(quota, [], now, { offsetMin: 0 })
  const codex = dash.providers.find((p) => p.id === "codex")
  assert.deepEqual(codex.history, [
    { at: iso(now - 35 * 60000), left: 60 },
    { at: iso(now - 15 * 60000), left: 50 },
    { at: iso(now), left: 50 },
  ])
  assert.equal(dash.providers.some((p) => p.id === "claude"), false)
  assert.equal(dash.windows.find((w) => w.user === "new").left, 20)
})

test("weekly history seeds the exact fifteen-day range and bounds dense readings per hour", async () => {
  const end = now + 23 * 60000 + 45321
  const from = end - 15 * DAY
  const start = end - 2 * DAY
  const point = (at, left) => ({ at: iso(at), left, start: iso(start), resetsAt: iso(start + 7 * DAY) })
  const points = [point(from - 2 * DAY, 10), point(from - 60000, 55)]
  for (let at = from + 60000, minute = 1; at < end; at += 60000, minute++) {
    points.push(point(at, 10 + minute % 80))
  }
  points.push(point(end, 33.34), point(end + 1, 0))
  const dash = await analyze({ "codex|dense": { week: points } }, [], end, { offsetMin: 345 })
  const history = dash.providers[0].history
  assert.deepEqual(history[0], { at: iso(from), left: 55 })
  assert.deepEqual(history.at(-1), { at: iso(end), left: 33.3 })
  assert.ok(history.length > 15 * 24)
  assert.ok(history.length <= 4 * (15 * 24 + 1))
  const buckets = new Map()
  let previous = -Infinity
  for (const sample of history) {
    const at = Date.parse(sample.at)
    assert.ok(at >= from && at <= end)
    assert.ok(at > previous, "timestamps must be strictly increasing and deduplicated")
    assert.ok(sample.left > 0, "positive readings must not invent a zero")
    const hour = Math.floor(at / HOUR)
    buckets.set(hour, (buckets.get(hour) || 0) + 1)
    previous = at
  }
  assert.ok([...buckets.values()].every((count) => count <= 4))
  for (let at = (Math.floor(from / HOUR) + 1) * HOUR; at < end; at += HOUR) {
    assert.ok(history.some((p) => p.at === iso(at)), `missing hourly boundary at ${iso(at)}`)
  }
})

test("six hours of history forecasts exhaustion before a twelve-hour reset", async () => {
  const reset = now + 12 * HOUR
  const start = reset - 7 * DAY
  const dash = await analyze({
    "codex|new-history": { week: [
      { at: iso(now - 6 * HOUR), left: 40, start: iso(start), resetsAt: iso(reset) },
      { at: iso(now), left: 10, start: iso(start), resetsAt: iso(reset) },
    ] },
  }, [], now, { offsetMin: 0 })
  assert.equal(dash.windows[0].dailyBurn, 120)
  assert.equal(dash.windows[0].forecastEmptyAt, iso(now + 2 * HOUR))
  const codex = dash.providers[0]
  assert.equal(codex.status, "ready")
  assert.equal(codex.emptyAt, iso(now + 2 * HOUR))
  assert.equal(codex.projectedLeftAtReset, 0)
  assert.equal(codex.projection.find((p) => p.at === codex.emptyAt).left, 0)
})

test("burn weights recent observed hours more heavily without inventing sparse seasonal detail", async () => {
  const start = now - 6 * DAY
  const reset = now + DAY
  const point = (at, left) => ({ at: iso(at), left, start: iso(start), resetsAt: iso(reset) })
  const dash = await analyze({
    "codex|boundary": { week: [
      point(now - 4 * DAY, 100),
      point(now - 2 * DAY, 80),
      point(now, 20),
    ] },
  }, [], now, { offsetMin: 0 })
  // Two equal 48-hour blocks: the newer block has four times the weight.
  assert.ok(Math.abs(dash.windows[0].dailyBurn - 26) < 1e-9)
  assert.equal(dash.providers[0].method, "ewma")
})

test("burn excludes unobserved reset gaps from both consumption and duration", async () => {
  const point = (at, left, start, reset) => ({ at: iso(at), left, start: iso(start), resetsAt: iso(reset) })
  const dash = await analyze({
    "codex|reset": { week: [
      point(now - 3 * DAY, 40, now - 8 * DAY, now - DAY),
      point(now - 2 * DAY, 10, now - 8 * DAY, now - DAY),
      point(now - 12 * HOUR, 100, now - DAY, now + 6 * DAY),
      point(now, 90, now - DAY, now + 6 * DAY),
    ] },
  }, [], now, { offsetMin: 0 })
  // The unknown reset gap does not decay the level: 30/day followed by
  // twelve observed hours at 20/day, with a 24-observed-hour half-life.
  const oldWeight = 0.5 * 2 ** -0.5
  const newWeight = 1 - 2 ** -0.5
  const burn = (30 * oldWeight + 20 * newWeight) / (oldWeight + newWeight)
  assert.ok(Math.abs(dash.windows[0].dailyBurn - burn) < 1e-9)
  assert.ok(Math.abs(Date.parse(dash.providers[0].emptyAt) - (now + 90 / burn * DAY)) <= 1)
})

test("readings at the same timestamp are insufficient to measure burn", async () => {
  const start = now - 2 * DAY
  const reset = iso(start + 7 * DAY)
  const dash = await analyze({
    "codex|duplicate": { week: [
      { at: iso(now), left: 40, start: iso(start), resetsAt: reset },
      { at: iso(now), left: 10, start: iso(start), resetsAt: reset },
    ] },
  }, [], now, { offsetMin: 0 })
  assert.equal(dash.windows[0].dailyBurn, null)
  assert.equal(dash.windows[0].forecastEmptyAt, null)
  assert.equal(dash.providers[0].status, "insufficient")
  assert.equal(dash.providers[0].emptyAt, null)
  assert.deepEqual(dash.providers[0].projection, [])
})

test("daily figures sum real account progress and keep tokens and cost separate", async () => {
  const start = "2026-07-01T00:00:00Z"
  const reset = "2026-07-20T00:00:00Z"
  const point = (at, left) => ({ at, left, start, resetsAt: reset })
  const quota = {
    "codex|a": { week: [
      point("2026-07-14T12:00:00Z", 100),
      point("2026-07-15T01:00:00Z", 70),
      point("2026-07-15T02:00:00Z", 65),
      point("2026-07-15T03:00:00Z", 95),
    ] },
    "codex|b": { week: [
      point("2026-07-15T01:00:00Z", 90),
      point("2026-07-15T02:00:00Z", 70),
    ] },
    "claude|c": { week: [
      point("2026-07-15T01:00:00Z", 100),
      point("2026-07-15T02:00:00Z", 80),
    ] },
  }
  const records = [
    { t: "2026-07-15T00:00:00Z", provider: "Codex", in: 0, out: 0, cost: 0 },
    { t: "2026-07-15T04:00:00Z", provider: "Codex", in: 600, out: 400, cost: 5.25 },
    { t: "2026-07-15T05:00:00Z", provider: "codex", in: 100, out: 50 },
    { t: "2026-07-15T04:00:00Z", provider: "claude", in: 200, out: 100, cost: 7.5 },
  ]
  const dash = await analyze(quota, records, now, { offsetMin: 0 })
  assert.deepEqual(dash.dailyProviders.map((p) => p.id), ["codex", "claude"])
  const codex = dash.dailyProviders[0].values.find((d) => d.day === "2026-07-15")
  assert.equal(codex.accountUnits, 0.55)
  assert.equal(codex.tokens, 1150)
  assert.equal(codex.cost, 5.25)
  assert.equal(codex.costPartial, true)
  const claude = dash.dailyProviders[1].values.find((d) => d.day === "2026-07-15")
  assert.equal(claude.accountUnits, 0.2)
  assert.equal(claude.tokens, 300)
  assert.equal(claude.cost, 7.5)
  assert.equal(claude.costPartial, false)
  const beforeHistory = dash.dailyProviders[0].values.find((d) => d.day === "2026-07-13")
  assert.equal(beforeHistory.tokens, null)
  assert.equal(beforeHistory.accountUnits, null)
})

test("a pool candle is the mean of the accounts, not the mean of their wicks", async () => {
  const start = "2026-07-01T00:00:00Z"
  const reset = "2026-07-20T00:00:00Z"
  const point = (at, left) => ({ at, left, start, resetsAt: reset })
  const quota = {
    "codex|a": {
      week: [point("2026-07-15T01:00:00Z", 80), point("2026-07-15T02:00:00Z", 60)],
    },
    "codex|b": {
      week: [point("2026-07-15T01:00:00Z", 40), point("2026-07-15T02:00:00Z", 50)],
    },
  }
  const dash = await analyze(quota, [
    { t: "2026-07-15T01:30:00Z", provider: "codex", providerAccount: "a", in: 100, out: 50 },
  ], now, { offsetMin: 0 })
  const candle = dash.candles.find((c) => c.day === "2026-07-15")
  assert.deepEqual(
    { open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume, n: candle.n },
    { open: 60, high: 60, low: 55, close: 55, volume: 150, n: 2 },
  )
})

test("a full untouched account is idle, and a short hot window does not ask for a new account", async () => {
  const start = now - 3 * DAY
  const quota = {
    "codex|idle@x": {
      week: [{ at: iso(now - 60000), left: 99, start: iso(start), resetsAt: iso(now + 4 * DAY) }],
    },
    "codex|busy@x": {
      week: [
        { at: iso(now - 2 * HOUR), left: 25, start: iso(now - 2 * DAY), resetsAt: iso(now + 5 * DAY) },
        { at: iso(now), left: 5, start: iso(now - 2 * DAY), resetsAt: iso(now + 5 * DAY) },
      ],
    },
  }
  const dash = await analyze(quota, [
    { t: iso(start - HOUR), provider: "codex", providerAccount: "idle@x", callerKeyName: "甲", in: 1, out: 1 },
  ], now, { offsetMin: 0 })
  const idle = dash.windows.find((w) => w.user === "idle@x")
  const busy = dash.windows.find((w) => w.user === "busy@x")
  assert.equal(idle.pace, "idle")
  assert.equal(idle.binding, true)
  assert.equal(busy.pace, "hot")
  assert.equal(dash.verdict.id, "tighten")
  assert.equal(dash.verdict.shortOnly, false)
})

test("missing files are an unknown reserve, not an error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "magpie-reserve-"))
  const dash = await loadDashboard(dir, now)
  assert.equal(dash.verdict.id, "unknown")
  assert.equal(dash.files.usage.missing, true)
  assert.equal(dash.files.quota.missing, true)
  assert.equal(dash.people.length, 0)
})

test("the dashboard reads the two usage files and nothing else in the directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "magpie-reserve-"))
  await writeFile(join(dir, "providers.json"), JSON.stringify({ key: "sk-secret-value" }))
  await writeFile(join(dir, "quota-history.json"), JSON.stringify({
    "codex|a@b.c": { week: [{ at: iso(now - 60000), left: 40, start: iso(now - DAY), resetsAt: iso(now + DAY) }] },
  }))
  await writeFile(join(dir, "usage.jsonl"), [
    JSON.stringify({ t: iso(now - HOUR), provider: "codex", providerAccount: "a@b.c", callerKeyName: "张三", in: 10, out: 5, session: "secret-session" }),
    "not json",
    "",
  ].join("\n"))
  const dash = await loadDashboard(dir, now)
  const text = JSON.stringify(dash)
  assert.equal(text.includes("sk-secret-value"), false)
  assert.equal(text.includes("secret-session"), false)
  assert.equal(dash.files.usage.lines, 2)
  assert.equal(dash.files.usage.bad, 1)
  assert.equal(dash.people[0].name, "张三")
  assert.equal(dash.people[0].h24.tokens, 15)
})

test("a quota file that is not the history object is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "magpie-reserve-"))
  await writeFile(join(dir, "quota-history.json"), "[]")
  await assert.rejects(() => loadDashboard(dir, now), /quota-history/)
})

test("a sandboxed page can read the service", async () => {
  const port = 3491
  const srv = createServer(createHandler({ port, token: "abcd", dir: "" }))
  await new Promise((resolve) => srv.listen(port, "127.0.0.1", resolve))
  try {
    const opt = await fetch(`http://127.0.0.1:${port}/api/dashboard`, {
      method: "OPTIONS",
      headers: { Origin: "null", "Access-Control-Request-Headers": "x-reserve-token" },
    })
    assert.equal(opt.status, 204)
    assert.equal(opt.headers.get("access-control-allow-origin"), "null")
    assert.match(opt.headers.get("access-control-allow-headers") || "", /x-reserve-token/)
    const got = await fetch(`http://127.0.0.1:${port}/api/dashboard`)
    assert.equal(got.headers.get("access-control-allow-origin"), "null")
    assert.equal(got.status, 200)
    const page = await fetch(`http://127.0.0.1:${port}/`)
    assert.equal(page.headers.get("access-control-allow-origin"), null)
    const html = await page.text()
    assert.match(html, /verdict/)
    assert.doesNotMatch(html, /src="app.js"/)
    assert.doesNotMatch(html, /src="forecast.js"/)
    assert.ok(html.indexOf("function forecastChart(") < html.indexOf("const boot ="))
    const denied = await fetch(`http://127.0.0.1:${port}/api/dashboard`, {
      headers: { Origin: "https://evil.test", "x-reserve-token": "abcd" },
    })
    assert.equal(denied.status, 403)
  } finally {
    await new Promise((resolve) => srv.close(resolve))
  }
})

test("the service only answers loopback, and a token of the wrong length is just a miss", () => {
  assert.equal(hostAllowed("127.0.0.1:3478", 3478), true)
  assert.equal(hostAllowed("Localhost:3478", 3478), true)
  assert.equal(hostAllowed("127.0.0.1:3479", 3478), false)
  assert.equal(hostAllowed("evil.test:3478", 3478), false)
  assert.equal(originAllowed(undefined), true)
  assert.equal(originAllowed("null"), true)
  assert.equal(originAllowed("https://evil.test"), false)
  assert.equal(tokenOk("abc", "abcd"), false)
  assert.equal(tokenOk("abcd", "abcd"), true)
  assert.throws(() => resolveDir("relative/path"), /绝对路径/)
})
