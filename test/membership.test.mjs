import assert from "node:assert/strict"
import test from "node:test"
import { analyze } from "../lib/scan.mjs"
import { demandBetween, estimateDemand } from "../lib/forecast.mjs"

const HOUR = 3600000, DAY = 24 * HOUR
const now = Date.parse("2026-07-15T12:00:00Z")
const iso = (at) => new Date(at).toISOString()
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`)
const point = (at, left, reset = now + 3 * DAY) => ({ at, left, start: reset - 7 * DAY, reset })
const readings = (hours, daily, left = 30) => Array.from({ length: hours + 1 }, (_, i) => point(now - (hours - i) * HOUR, left + (hours - i) * daily / 24))
const raw = (points) => points.map((p) => ({ at: iso(p.at), left: p.left, start: iso(p.start), resetsAt: iso(p.reset) }))
async function dashboard(accounts, memberships = [], records = []) {
  const quota = Object.fromEntries(Object.entries(accounts).map(([id, points]) => [id, { week: raw(points) }]))
  return analyze(quota, records, now, { offsetMin: 0, memberships })
}
const selection = (user, changes) => ({ id: `codex|${user}`, changes: changes.map(([at, included]) => ({ at: iso(at), included })) })
const sample = (at, left, accounts) => ({ at: iso(at), left, capacity: accounts * 100, accounts })

function retainsHistory(before, after, until) {
  const actual = new Map(after.filter((p) => Date.parse(p.at) < until).map((p) => [p.at, p]))
  for (const p of before.filter((p) => Date.parse(p.at) < until)) assert.deepEqual(actual.get(p.at), p)
}

test("multiple weekly constraints on one account never become extra accounts or interleaved demand", async () => {
  const points = raw(readings(12, 15, 30))
  const other = raw(readings(12, 0, 90))
  const data = await analyze({ "codex|a": { shared: points, modelOnly: other } }, [], now, { offsetMin: 0 })
  const provider = data.providers[0]
  assert.equal(provider.accounts, 1)
  assert.equal(provider.capacity, 100)
  assert.equal(provider.left, 30)
  near(provider.guidance.currentDailyBurn, 15)
  assert.equal(provider.history[0].left, 37.5)
  assert.equal(provider.history.at(-1).left, 30)
  assert.equal(data.windows.find((w) => w.binding).window, "shared")
})

test("four and five full accounts expose 400 and 500 points throughout the pool", async () => {
  for (const count of [4, 5]) {
    const accounts = Object.fromEntries(Array.from({ length: count }, (_, i) => [`codex|${i}`, readings(12, 0, 100)]))
    const data = await dashboard(accounts)
    const provider = data.providers[0]
    assert.equal(data.reserve.left, count * 100)
    assert.equal(data.reserve.capacity, count * 100)
    assert.equal(provider.left, count * 100)
    assert.equal(provider.capacity, count * 100)
    assert.equal(provider.accounts, count)
    assert.equal(provider.knownAccounts, count)
    assert.ok(provider.history.every((p) => p.left === count * 100 && p.capacity === count * 100 && p.accounts === count))
    assert.ok(provider.projection.every((p) => p.left === count * 100 && p.capacity === count * 100 && p.accounts === count))
    assert.equal(provider.projectedLeftAtReset, count * 100)
    assert.equal(provider.guidance.currentDailyBurn, 0)
    near(provider.guidance.targetDailyBurn, count * 97 / 3)
    assert.ok(data.windows.every((w) => w.left === 100))
  }
})

test("30 plus 100 is 130 points of a 200-point pool", async () => {
  const data = await dashboard({ "codex|a": readings(12, 0, 30), "codex|b": readings(12, 0, 100) })
  assert.equal(data.reserve.left, 130)
  assert.equal(data.reserve.capacity, 200)
  const provider = data.providers[0]
  assert.equal(provider.left, 130)
  assert.equal(provider.capacity, 200)
  assert.deepEqual(provider.history.at(-1), sample(now, 130, 2))
  assert.deepEqual(provider.projection[0], sample(now, 130, 2))
})

test("guidance uses total points per day and reserves three points on each of four accounts", async () => {
  const accounts = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`codex|${i}`, readings(12, 15, 30)]))
  const provider = (await dashboard(accounts)).providers[0]
  near(provider.guidance.currentDailyBurn, 60)
  near(provider.guidance.targetDailyBurn, (120 - 4 * 3) / 3)
  near(provider.guidance.factor, 0.6)
  near(provider.guidance.changePct, -40)
})

test("a cold one-snapshot join preserves 72 hours of demand and all preceding history", async () => {
  const a = readings(72, 15)
  const b = [point(now, 100)]
  const before = (await dashboard({ "codex|a": a })).providers[0]
  const data = await dashboard({ "codex|a": a, "codex|b": b })
  const after = data.providers[0]
  assert.equal(after.status, "ready")
  near(after.coverageHours, 72)
  near(after.guidance.currentDailyBurn, before.guidance.currentDailyBurn)
  assert.equal(after.method, before.method)
  retainsHistory(before.history, after.history, now)
  assert.ok(after.history.filter((p) => Date.parse(p.at) < now).every((p) => p.capacity === 100))
  assert.deepEqual(after.history.at(-1), sample(now, 130, 2))
  assert.deepEqual(after.membershipEvents.at(-1), { at: iso(now), kind: "observed", label: "codex · b", capacity: 200, left: 130 })
  assert.equal(data.accountRoster.find((r) => r.id === "codex|b").firstSeenAt, iso(now))
  assert.equal(after.firstEmptyAt, iso(now + 2 * DAY))
  // B initially receives no demand, then serves as fallback when A empties.
  assert.equal(after.projection.find((p) => p.at === after.firstEmptyAt).left, 100)
  assert.equal(after.projection.find((p) => p.at === iso(now + 60 * HOUR)).left, 92.5)
  assert.equal(after.projectedLeftAtReset, 85)
  const model = estimateDemand([{ points: a }, { points: b }], now)
  assert.deepEqual(model.accountIds, ["0", "1"])
  assert.deepEqual(model.shares, [1, 0])
})

test("excluding a heavy consumer retains its learned demand and routes it to the remaining idle account", async () => {
  const accounts = { "codex|busy": readings(72, 24, 20), "codex|idle": readings(72, 0, 30) }
  const before = (await dashboard(accounts)).providers[0]
  const data = await dashboard(accounts, [selection("busy", [[now, false]])])
  const after = data.providers[0]
  near(after.guidance.currentDailyBurn, 24)
  near(after.coverageHours, 72)
  assert.equal(after.capacity, 100)
  assert.equal(after.knownAccounts, 2)
  assert.equal(after.left, 30)
  assert.equal(after.projection[0].capacity, 100)
  assert.equal(after.emptyAt, iso(now + 30 * HOUR))
  assert.equal(after.firstEmptyLabel, "codex · idle")
  retainsHistory(before.history, after.history, now)
  assert.ok(after.history.filter((p) => Date.parse(p.at) < now).every((p) => p.capacity === 200))
  assert.deepEqual(after.history.at(-1), sample(now, 30, 1))
  assert.deepEqual(after.membershipEvents.at(-1), { at: iso(now), kind: "excluded", label: "codex · busy", capacity: 100, left: 30 })
  assert.equal(data.windows.find((w) => w.user === "busy").binding, false)
  assert.equal(data.windows.find((w) => w.user === "busy").left, 20)
  assert.equal(data.reserve.capacity, 100)
  assert.equal(data.accountRoster.find((r) => r.user === "busy").available, true)
  assert.equal(data.accountRoster.find((r) => r.user === "busy").included, false)
})

test("surviving learned shares renormalize while a cold account remains fallback", async () => {
  const accounts = {
    "codex|busy": readings(12, 24, 20),
    "codex|survivor": readings(12, 24, 10),
    "codex|cold": [point(now, 100)],
  }
  const after = (await dashboard(accounts, [selection("busy", [[now, false]])])).providers[0]
  near(after.guidance.currentDailyBurn, 48)
  assert.equal(after.firstEmptyLabel, "codex · survivor")
  assert.equal(after.firstEmptyAt, iso(now + 5 * HOUR))
  assert.equal(after.projection.find((p) => p.at === after.firstEmptyAt).left, 100)
  assert.equal(after.emptyAt, iso(now + 55 * HOUR))
})

test("multiple exclusions and re-inclusions in one hour preserve explicit capacity steps", async () => {
  const changes = [[now - 45 * 60000, false], [now - 35 * 60000, true], [now - 25 * 60000, false], [now - 15 * 60000, true]]
  const data = await dashboard({ "codex|a": readings(4, 0, 50), "codex|b": readings(4, 0, 20) }, [selection("b", changes)])
  const provider = data.providers[0]
  for (const [at, included] of changes) {
    assert.deepEqual(provider.history.find((p) => p.at === iso(at)), sample(at, included ? 70 : 50, included ? 2 : 1))
    assert.deepEqual(provider.history.find((p) => p.at === iso(at - 1)), sample(at - 1, included ? 50 : 70, included ? 1 : 2))
  }
  assert.deepEqual(provider.membershipEvents.slice(-4).map((e) => e.kind), ["excluded", "included", "excluded", "included"])
  assert.deepEqual(provider.history.at(-1), sample(now, 70, 2))
  assert.equal(data.accountRoster.find((r) => r.user === "b").included, true)
  near(provider.guidance.currentDailyBurn, 0)
})

test("unknown coverage after a known join is skipped rather than counted as zero demand", () => {
  const a = readings(48, 24, 20)
  const b = [point(now - 12 * HOUR, 90), point(now - 8 * HOUR, 86), point(now - 4 * HOUR, 96), point(now, 92)]
  const model = estimateDemand([{ points: a }, { points: b }], now)
  // 36 solo hours at 1 point/hour, eight common hours at 2 points/hour;
  // B's unobserved increase makes the intervening four hours unknown.
  near(model.coverageHours, 44)
  const oldWeight = (1 - 2 ** (-36 / 24)) * 2 ** (-8 / 24)
  const recentWeight = 1 - 2 ** (-8 / 24)
  near(model.level, (oldWeight + recentWeight * 2) / (oldWeight + recentWeight))
  const noFollowup = estimateDemand([{ points: a }, { points: [b[0]] }], now)
  near(noFollowup.coverageHours, 36)
  near(demandBetween(noFollowup, now, now + DAY), 24)
})

test("explicit exclusion gaps clip the training cohort without erasing earlier consumption", () => {
  const a = { id: "codex|a", points: readings(12, 24, 20) }
  const b = { id: "codex|b", points: readings(12, 48, 20) }
  const memberships = [selection("b", [[now - 8 * HOUR, false], [now - 4 * HOUR, true]])]
  const model = estimateDemand([a, b], now, { memberships })
  // The three four-hour blocks have total rates 3, 1, 3. Inclusion steps
  // themselves contribute capacity and never become consumption spikes.
  const decay = 2 ** (-4 / 24)
  near(model.coverageHours, 12)
  near(model.level, (3 * decay ** 2 + decay + 3) / (decay ** 2 + decay + 1))
})

test("no selected accounts retain the historical provider with observe guidance and no exhaustion", async () => {
  const accounts = { "codex|a": readings(12, 24), "codex|b": readings(12, 0, 80) }
  const data = await dashboard(accounts, [selection("a", [[now, false]]), selection("b", [[now, false]])])
  const provider = data.providers[0]
  assert.equal(provider.id, "codex")
  assert.equal(provider.accounts, 0)
  assert.equal(provider.knownAccounts, 2)
  assert.equal(provider.capacity, 0)
  assert.equal(provider.left, 0)
  assert.equal(provider.status, "insufficient")
  assert.equal(provider.guidance.action, "observe")
  assert.equal(provider.emptyAt, null)
  assert.equal(provider.firstEmptyAt, null)
  assert.equal(provider.guidance.emptyAt, null)
  assert.equal(provider.resetAt, null)
  assert.deepEqual(provider.projection, [])
  assert.ok(provider.history.some((p) => p.capacity === 200 && p.left > 0))
  assert.deepEqual(provider.history.at(-1), sample(now, 0, 0))
  assert.equal(data.reserve.left, 0)
  assert.equal(data.reserve.capacity, 0)
  assert.equal(data.windows.filter((w) => w.binding).length, 0)
  assert.equal(data.accountRoster.length, 2)
})

test("an expired weekly window becomes unavailable only at now, retaining its known balance without a refill", async () => {
  const reset = now - HOUR
  const accounts = { "codex|expired": [point(now - 3 * HOUR, 50, reset), point(now - 2 * HOUR, 45, reset), point(now + HOUR, 100)] }
  const data = await dashboard(accounts)
  assert.deepEqual(data.accountRoster, [{
    id: "codex|expired", label: "codex · expired", provider: "codex", user: "expired",
    included: true, available: false, firstSeenAt: iso(now - 3 * HOUR), left: 45, resetAt: iso(reset),
  }])
  const provider = data.providers[0]
  assert.equal(provider.status, "insufficient")
  assert.equal(provider.guidance.action, "observe")
  assert.equal(provider.emptyAt, null)
  assert.equal(provider.knownAccounts, 1)
  assert.deepEqual(provider.history.at(-2), sample(now - 1, 45, 1))
  assert.deepEqual(provider.history.at(-1), sample(now, 0, 0))
  assert.ok(provider.history.every((p) => p.left <= 50))
  assert.deepEqual(provider.membershipEvents.at(-1), { at: iso(now), kind: "unavailable", label: "codex · expired", capacity: 0, left: 0 })
})

test("canonical IDs retain the full user, trim and lowercase, and ignore future selection changes", async () => {
  const data = await dashboard({ " CodEX | Full|User@EXAMPLE.COM ": readings(12, 15) }, [{
    id: " CODEX | FULL|USER@example.com ", changes: [{ at: iso(now), included: false }, { at: iso(now + HOUR), included: true }],
  }])
  assert.equal(data.accountRoster[0].id, "codex|full|user@example.com")
  assert.equal(data.accountRoster[0].included, false)
  assert.equal(data.accountRoster[0].available, true)
  assert.equal(data.accountRoster[0].firstSeenAt, iso(now - 12 * HOUR))
  assert.equal(data.providers[0].capacity, 0)
  assert.ok(data.providers[0].membershipEvents.every((e) => Date.parse(e.at) <= now))
})

test("selection before first observation never backfills an account or adds unknown demand", async () => {
  const accounts = { "codex|a": readings(72, 15), "codex|b": [point(now - HOUR, 100)] }
  const memberships = [selection("b", [[now - 7 * DAY, false], [now - 2 * DAY, true]])]
  const data = await dashboard(accounts, memberships)
  const provider = data.providers[0]
  near(provider.coverageHours, 71)
  near(provider.guidance.currentDailyBurn, 15)
  assert.equal(data.accountRoster.find((r) => r.user === "b").firstSeenAt, iso(now - HOUR))
  assert.ok(provider.history.filter((p) => Date.parse(p.at) < now - HOUR).every((p) => p.capacity === 100))
  assert.equal(provider.history.find((p) => p.at === iso(now - HOUR)).capacity, 200)
})

test("case variants of one canonical account retain earlier history and count capacity once", async () => {
  const points = readings(72, 15)
  const data = await dashboard({ "CODEX|Full@Example.com": points.slice(0, -1), "codex|full@example.COM": points.slice(-1) })
  assert.equal(data.accountRoster.length, 1)
  assert.equal(data.accountRoster[0].id, "codex|full@example.com")
  assert.equal(data.accountRoster[0].firstSeenAt, iso(now - 72 * HOUR))
  const provider = data.providers[0]
  assert.equal(provider.accounts, 1)
  assert.equal(provider.knownAccounts, 1)
  near(provider.coverageHours, 72)
  near(provider.guidance.currentDailyBurn, 15)
  assert.deepEqual(provider.history.at(-1), sample(now, 30, 1))
})

test("current history and roster agree on exposed rounded account balances", async () => {
  const data = await dashboard({ "codex|a": readings(12, 0, 30.04), "codex|b": readings(12, 0, 30.04) })
  const total = data.accountRoster.reduce((sum, r) => sum + r.left, 0)
  assert.equal(total, 60)
  assert.equal(data.reserve.left, total)
  assert.equal(data.providers[0].left, total)
  assert.equal(data.providers[0].history.at(-1).left, total)
})
