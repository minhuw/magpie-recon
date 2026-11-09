import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createContext, runInContext } from "node:vm"
import { createHandler } from "../lib/server.mjs"

const HOUR = 3600000, DAY = 24 * HOUR
const now = Date.parse("2026-07-15T12:00:00Z")
const iso = (at) => new Date(at).toISOString()
const source = await readFile(new URL("../ui/app.js", import.meta.url), "utf8")

function presentation() {
  const elements = new Map()
  const context = createContext({
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, { textContent: id === "boot" ? "{}" : "", addEventListener() {} })
        return elements.get(id)
      },
      addEventListener() {},
    },
    addEventListener() {},
  })
  runInContext(source, context)
  return context
}

function provider(action, changePct = null, extra = {}) {
  return { accounts: 1, label: "Codex", guidance: {
    action, changePct, reservePct: 3, coverageHours: 12,
    resetAt: iso(now + 3 * DAY), nextResetAt: iso(now + 3 * DAY), ...extra,
  } }
}

test("top guidance states exactly how much to reduce or increase", () => {
  const context = presentation()
  assert.match(context.guidanceText(provider("reduce", -40), now).title, /减少约 40%/)
  assert.match(context.guidanceText(provider("increase", 80), now).title, /增加约 80%/)
  assert.match(context.guidanceText(provider("hold", -5), now).title, /保持当前用量/)
  assert.match(context.guidanceText(provider("reduce", -100), now).title, /暂缓使用/)
  assert.match(context.guidanceText(provider("reduce", -0.2), now).title, /减少约 1%/)
})

test("unavailable or idle guidance never fabricates a percentage change", () => {
  const context = presentation()
  for (const action of ["idle", "wait", "observe", "stale", "short_limited"]) {
    const text = context.guidanceText(provider(action), now)
    assert.doesNotMatch(text.title, /\d+%|NaN|Infinity/)
  }
  assert.match(context.guidanceText(provider("observe", null, { coverageHours: 2 }), now).reason, /6 小时.*现有 2 小时/)
  assert.match(context.guidanceText({ accounts: 0, label: "Codex" }, now).title, /等待读数|等待周额度读数/)
  assert.match(context.guidanceText(provider("idle", null, { targetDailyBurn: 0 }), now).title, /预留范围/)
})

test("snapshot age is a nonblocking reference note while later calls get actionable refresh guidance", () => {
  const context = presentation()
  const old = provider("reduce", -40)
  old.freshness = { snapshotAccounts: [{ label: "Codex · idle", observedAt: iso(now - 2 * HOUR) }], unconfirmedAccounts: [] }
  assert.match(context.guidanceText(old, now).title, /减少约 40%/)
  assert.match(context.quotaSnapshotText(old), /沿用上次余额.*未见相应网关调用/)
  assert.doesNotMatch(context.quotaSnapshotText(old), /读数较旧|无法判断/)
  const active = provider("stale")
  active.freshness = { snapshotAccounts: [], unconfirmedAccounts: [{ label: "Codex · active", observedAt: iso(now - 2 * HOUR), lastUsedAt: iso(now - 60000) }] }
  const text = context.guidanceText(active, now)
  assert.equal(text.title, "额度尚未覆盖最近调用")
  assert.match(text.reason, /Magpie 用量页刷新账号额度/)
  assert.equal(context.quotaSnapshotText(active), null)
})

test("an empty selection is explained as account selection, not exhaustion or lost history", () => {
  const context = presentation()
  const provider = { accounts: 0, knownAccounts: 4, capacity: 0, left: 0 }
  assert.match(context.guidanceText(provider, now).title, /没有参与预测的可用账号/)
  assert.doesNotMatch(context.guidanceText(provider, now).title, /已耗尽/)
  assert.match(context.outcome(provider, now).detail, /历史记录保留/)
})

test("headline distinguishes confirmed exhaustion from a projection reaching zero", () => {
  const context = presentation()
  assert.equal(context.outcome({ accounts: 1, left: 0 }, now).title, "已耗尽")
  assert.equal(context.outcome({ accounts: 1, left: 5, status: "ready", emptyAt: iso(now) }, now).title, "可能已耗尽")
  assert.equal(context.outcome({ accounts: 1, left: 5, status: "stale" }, now).title, "暂时无法判断")
})

test("reserve selection recalculates recommendations without reusing another policy's cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "magpie-guide-"))
  const at = Date.now(), reset = at + 3 * DAY
  const points = Array.from({ length: 13 }, (_, i) => ({
    at: iso(at - (12 - i) * HOUR), left: 30 + (12 - i) * 15 / 24,
    start: iso(reset - 7 * DAY), resetsAt: iso(reset),
  }))
  await writeFile(join(dir, "quota-history.json"), JSON.stringify({ "codex|a": { week: points } }))
  const server = createServer()
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = server.address().port
  server.on("request", createHandler({ port, token: "test", dir }))
  try {
    for (const [value, reserve, daily] of [["3", 3, 9], ["6", 6, 8], ["0", 0, 10], ["invalid", 3, 9]]) {
      const response = await fetch(`http://127.0.0.1:${port}/api/dashboard?reservePct=${value}`)
      assert.equal(response.status, 200)
      const data = await response.json()
      assert.equal(data.policy.reservePct, reserve)
      assert.equal(data.providers[0].guidance.reservePct, reserve)
      assert.ok(Math.abs(data.providers[0].guidance.targetDailyBurn - daily) < 0.01)
    }
    const page = await fetch(`http://127.0.0.1:${port}/?reservePct=5&theme=dark`)
    const html = await page.text()
    assert.match(html, /"policy":\{"reservePct":5\}/)
    assert.match(html, /function usageGuide/)
    assert.doesNotMatch(html, /src="(?:app|forecast)\.js"/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})
