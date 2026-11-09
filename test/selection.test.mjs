import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createHandler } from "../lib/server.mjs"
import { readSelection, selectionPath } from "../lib/selection.mjs"

const HOUR = 3600000, DAY = 24 * HOUR
const iso = (at) => new Date(at).toISOString()
function bootOf(html) {
  const match = html.match(/<script id="boot" type="application\/json">([\s\S]*?)<\/script>/)
  assert.ok(match, "embedded dashboard missing")
  return JSON.parse(match[1])
}
async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), "magpie-selection-"))
  const now = Date.now(), reset = now + 3 * DAY
  const quota = Object.fromEntries(Array.from({ length: 4 }, (_, n) => ["codex|user" + n, { week: Array.from({ length: 13 }, (_, i) => ({ at: iso(now - (12 - i) * HOUR), left: 100, start: iso(reset - 7 * DAY), resetsAt: iso(reset) })) }]))
  const quotaText = JSON.stringify(quota)
  await writeFile(join(dir, "quota-history.json"), quotaText)
  await writeFile(join(dir, "usage.jsonl"), "")
  const server = createServer()
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = server.address().port
  const attach = (token) => { server.removeAllListeners("request"); server.on("request", createHandler({ port, token, dir })) }
  attach("selection-test-secret")
  const base = `http://127.0.0.1:${port}`
  try { await run({ base, dir, quota, quotaText, attach }) }
  finally { await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true, force: true }) }
}

test("account selection is signed, persists, invalidates cache, and retains historical quota", async () => fixture(async ({ base, dir, quotaText, attach }) => {
  const initial = bootOf(await (await fetch(base + "/?reservePct=5&theme=dark")).text())
  assert.equal(initial.dashboard.providers[0].capacity, 400)
  assert.equal(initial.dashboard.rosterRevision, 0)
  assert.equal(initial.accountActions.length, 4)
  const action = initial.accountActions[0]
  const bad = new URL(action.href, base)
  bad.searchParams.set("included", "1")
  assert.equal((await fetch(bad)).status, 403)
  assert.equal((await readSelection(dir)).revision, 0)
  assert.equal((await fetch(base + action.href, { method: "HEAD" })).status, 405)
  const changed = await fetch(base + action.href, { redirect: "manual" })
  assert.equal(changed.status, 303)
  assert.equal(changed.headers.get("location"), "/?reservePct=5&theme=dark&accounts=open")
  const state = await readSelection(dir)
  assert.equal(state.revision, 1)
  assert.equal(state.memberships[0].id, action.id)
  assert.equal(state.memberships[0].changes[0].included, false)
  const data = await (await fetch(base + "/api/dashboard?reservePct=5")).json()
  assert.equal(data.providers[0].capacity, 300)
  assert.equal(data.providers[0].left, 300)
  assert.ok(data.providers[0].history.some((p) => p.capacity === 400))
  assert.ok(data.providers[0].membershipEvents.some((e) => e.kind === "excluded"))
  assert.equal(data.accountActions, undefined)
  assert.equal(JSON.stringify(data).includes("signature"), false)
  assert.equal(await readFile(join(dir, "quota-history.json"), "utf8"), quotaText)
  assert.equal(await readFile(join(dir, "usage.jsonl"), "utf8"), "")
  // Restart the handler: the choice survives, old write intents do not.
  attach("different-service-secret")
  assert.equal((await fetch(base + action.href)).status, 403)
  const restarted = bootOf(await (await fetch(base + "/?reservePct=5")).text())
  assert.equal(restarted.dashboard.providers[0].capacity, 300)
  const include = restarted.accountActions.find((a) => a.id === action.id)
  assert.equal(include.included, true)
  assert.equal((await fetch(base + include.href, { redirect: "manual" })).status, 303)
  const restored = await (await fetch(base + "/api/dashboard?reservePct=5")).json()
  assert.equal(restored.providers[0].capacity, 400)
  assert.equal((await readSelection(dir)).memberships[0].changes.length, 2)
}))

test("stale and concurrent navigation intents cannot overwrite a later account choice", async () => fixture(async ({ base, dir }) => {
  const page = bootOf(await (await fetch(base + "/")).text())
  const results = await Promise.all(page.accountActions.slice(0, 2).map((a) => fetch(base + a.href, { redirect: "manual" })))
  assert.ok(results.every((r) => r.status === 303))
  assert.ok(results.some((r) => r.headers.get("location").includes("selection-changed")))
  assert.equal((await readSelection(dir)).revision, 1)
  const data = await (await fetch(base + "/api/dashboard")).json()
  assert.equal(data.providers[0].accounts, 3)
  assert.equal(data.rosterRevision, 1)
}))

test("damaged plugin selection history is preserved rather than overwritten", async () => fixture(async ({ base, dir }) => {
  const page = bootOf(await (await fetch(base + "/")).text())
  await writeFile(selectionPath(dir), "broken selection history")
  const response = await fetch(base + page.accountActions[0].href)
  assert.equal(response.status, 500)
  assert.match(await response.text(), /原文件已保留/)
  assert.equal(await readFile(selectionPath(dir), "utf8"), "broken selection history")
}))

test("new account snapshots are automatically included without discarding stored exclusions", async () => fixture(async ({ base, dir, quota, attach }) => {
  const page = bootOf(await (await fetch(base + "/")).text())
  await fetch(base + page.accountActions[0].href)
  quota["codex|brand-new"] = { week: [quota["codex|user0"].week.at(-1)] }
  await writeFile(join(dir, "quota-history.json"), JSON.stringify(quota))
  attach("new-handler")
  const data = await (await fetch(base + "/api/dashboard")).json()
  assert.equal(data.providers[0].accounts, 4)
  assert.equal(data.providers[0].capacity, 400)
  assert.equal(data.providers[0].status, "ready")
  assert.equal(data.accountRoster.find((a) => a.id === "codex|brand-new").included, true)
  assert.equal(data.accountRoster.find((a) => a.id === page.accountActions[0].id).included, false)
}))
