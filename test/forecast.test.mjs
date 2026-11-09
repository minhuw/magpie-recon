import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { createContext, runInContext } from "node:vm"

const source = await readFile(new URL("../ui/forecast.js", import.meta.url), "utf8")
const HOUR = 3600000
const DAY = 24 * HOUR
const now = Date.parse("2026-07-15T12:00:00Z")

function chartContext() {
  const context = createContext({ hideTooltip() {}, requestAnimationFrame() { return 1 } })
  runInContext(source, context)
  runInContext(`forecastNow = ${now}; forecastView = { start: ${now - DAY}, end: ${now} }`, context)
  return context
}

function view(context) {
  return JSON.parse(runInContext("JSON.stringify(forecastView)", context))
}

test("chart viewport limits zoom and panning to one hour through the available thirty days", () => {
  const context = chartContext()
  context.setForecastView(now - 40 * DAY, now - 39 * DAY)
  assert.deepEqual(view(context), { start: now - 15 * DAY, end: now - 14 * DAY })
  context.setForecastView(now + 39 * DAY, now + 40 * DAY)
  assert.deepEqual(view(context), { start: now + 14 * DAY, end: now + 15 * DAY })
  context.setForecastView(now - HOUR, now - HOUR + 1000)
  assert.deepEqual(view(context), { start: now - HOUR, end: now })
  context.setForecastView(now - 40 * DAY, now + 40 * DAY)
  assert.deepEqual(view(context), { start: now - 15 * DAY, end: now + 15 * DAY })
})

test("chart zoom keeps the pointed time in the same position", () => {
  const context = chartContext()
  context.zoomForecast(0.5, now - 6 * HOUR)
  assert.deepEqual(view(context), { start: now - 15 * HOUR, end: now - 3 * HOUR })
  context.zoomForecast(2, now - 6 * HOUR)
  assert.deepEqual(view(context), { start: now - DAY, end: now })
})

test("total-quota axis follows four and five account capacity without rewriting earlier ranges", () => {
  const context = chartContext()
  const provider = { accounts: 5, capacity: 500, history: [
    { at: new Date(now - 2 * DAY).toISOString(), left: 320, capacity: 400 },
    { at: new Date(now - DAY).toISOString(), left: 420, capacity: 500 },
    { at: new Date(now).toISOString(), left: 400, capacity: 500 },
  ], projection: [] }
  assert.equal(context.quotaScale(provider, now - 2 * DAY, now - DAY - 1), 400)
  assert.equal(context.quotaScale(provider, now - DAY, now), 500)
  assert.equal(context.quotaScale({ ...provider, accounts: 0, capacity: 0 }, now - 2 * DAY, now), 500)
  const sample = context.chartSample([{ at: 0, left: 300, capacity: 400, accounts: 4 }, { at: 10, left: 200, capacity: 400, accounts: 4 }], 5, true)
  assert.equal(sample.left, 250)
  assert.equal(sample.capacity, 400)
  assert.equal(sample.accounts, 4)
})

test("history inspection keeps observed zeros until reset while forecasts interpolate", () => {
  const context = chartContext()
  const points = [{ at: 0, left: 20 }, { at: 10, left: 0 }, { at: 20, left: 100 }]
  assert.equal(context.chartSample(points, -1), null)
  assert.equal(context.chartSample(points, 15).left, 0)
  assert.equal(context.chartSample(points, 15).at, 10)
  assert.equal(context.chartSample(points, 20).left, 100)
  assert.equal(context.chartSample(points, 15, true).left, 50)
  assert.equal(context.chartSample([], 0), null)
})
