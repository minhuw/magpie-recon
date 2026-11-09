import assert from "node:assert/strict"
import test from "node:test"
import { analyze } from "../lib/scan.mjs"

const HOUR = 3600000, DAY = 24 * HOUR
const now = Date.parse("2026-07-15T12:00:00Z")
const iso = (at) => new Date(at).toISOString()
function week(lag = 2 * HOUR, daily = 15, left = 30) {
  const reset = now + 3 * DAY
  return Array.from({ length: 13 }, (_, i) => ({
    at: iso(now - lag - (12 - i) * HOUR), left: left + (12 - i) * daily / 24,
    start: iso(reset - 7 * DAY), resetsAt: iso(reset),
  }))
}
function call(user = "idle", at = now - 10 * 60000, extra = {}) {
  return { t: iso(at), provider: "codex", providerAccount: user, status: 200, in: 100, out: 50, ...extra }
}

async function dashboard(records = [], quota = { "codex|idle": { week: week() } }) {
  return analyze(quota, records, now, { offsetMin: 0 })
}

test("an idle account's old snapshot does not block recommendations or invent past consumption", async () => {
  const data = await dashboard()
  const provider = data.providers[0]
  assert.equal(provider.status, "ready")
  assert.equal(provider.guidance.action, "reduce")
  assert.ok(Math.abs(provider.guidance.changePct + 40) < 1e-5)
  assert.equal(provider.projection[0].left, 30)
  assert.equal(provider.emptyAt, iso(now + 2 * DAY))
  assert.equal(data.windows[0].forecastEmptyAt, provider.emptyAt)
  assert.deepEqual(provider.freshness.snapshotAccounts, [{ label: "codex · idle", observedAt: iso(now - 2 * HOUR) }])
  assert.deepEqual(provider.freshness.unconfirmedAccounts, [])
})

test("an idle saved account cannot mark another active and freshly read account stale", async () => {
  const data = await dashboard([call("active")], {
    "codex|idle": { week: week() },
    "codex|active": { week: week(0, 5, 60) },
  })
  const provider = data.providers[0]
  assert.equal(provider.status, "ready")
  assert.equal(provider.projection[0].left, 45)
  assert.equal(provider.freshness.snapshotAccounts.length, 1)
  assert.deepEqual(provider.freshness.unconfirmedAccounts, [])
  assert.notEqual(provider.guidance.action, "stale")
})

test("an old quota snapshot with later successful usage still requires confirmation", async () => {
  const data = await dashboard([call()])
  const provider = data.providers[0]
  assert.equal(provider.status, "stale")
  assert.equal(provider.guidance.action, "stale")
  assert.equal(provider.guidance.changePct, null)
  assert.deepEqual(provider.projection, [])
  assert.deepEqual(provider.freshness.unconfirmedAccounts, [{
    label: "codex · idle", observedAt: iso(now - 2 * HOUR), lastUsedAt: iso(now - 10 * 60000),
  }])
})

test("older, rejected, failed, future, and other-account calls cannot age an idle snapshot", async () => {
  const records = [
    call("idle", now - 3 * HOUR),
    call("idle", now - 5 * 60000, { rejected: true }),
    call("idle", now - 5 * 60000, { status: 429, in: 0, out: 0 }),
    call("idle", now + 60000),
    call("other"),
  ]
  const provider = (await dashboard(records)).providers[0]
  assert.equal(provider.status, "ready")
  assert.equal(provider.projection[0].left, 30)
  assert.deepEqual(provider.freshness.unconfirmedAccounts, [])
})

test("recent quota readings still age observed consumption when calls followed the reading", async () => {
  const reset = now + 3 * DAY
  const point = (at, left) => ({ at: iso(at), left, start: iso(reset - 7 * DAY), resetsAt: iso(reset) })
  const data = await dashboard([call("idle", now - 5 * 60000)], {
    "codex|idle": { week: [point(now - 30 * 60000, 40), point(now - 10 * 60000, 20)] },
  })
  const provider = data.providers[0]
  assert.equal(provider.status, "ready")
  assert.equal(provider.projection[0].left, 10)
  assert.equal(provider.emptyAt, iso(now + 10 * 60000))
  assert.equal(data.windows[0].forecastEmptyAt, provider.emptyAt)
})

test("partial billed failures are conservatively treated as activity, and a new quota read clears it", async () => {
  const records = [call("idle", now - 10 * 60000, { status: 500 })]
  assert.equal((await dashboard(records)).providers[0].status, "stale")
  const recovered = await dashboard(records, { "codex|idle": { week: week(0) } })
  assert.equal(recovered.providers[0].status, "ready")
  assert.deepEqual(recovered.providers[0].freshness.unconfirmedAccounts, [])
})
