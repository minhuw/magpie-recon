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
      "5 hours": [{ at: iso(now - 60000), left: 5, start: iso(now - 4 * HOUR), resetsAt: iso(now + HOUR) }],
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
  assert.equal(dash.verdict.shortOnly, true)
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
