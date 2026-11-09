// Shared viewport and hourly quota charts. Loaded before app.js; helpers and
// page elements are provided by app.js before any of these functions are called.
const HOUR = 3600000
const DAY = 24 * HOUR
let forecastView = null
let forecastNow = 0
let forecastFrame = 0
let chartSerial = 0

function dateName(at) {
  return new Date(at).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })
}

function setForecastView(start, end) {
  const min = forecastNow - 15 * DAY
  const max = forecastNow + 15 * DAY
  const span = Math.max(HOUR, Math.min(max - min, end - start))
  start = Math.max(min, Math.min(start, max - span))
  forecastView = { start, end: start + span }
  hideTooltip()
  if (!forecastFrame) forecastFrame = requestAnimationFrame(() => {
    forecastFrame = 0
    for (const chart of app.querySelectorAll(".forecast-chart")) {
      const { provider, now, width } = chart._source
      const focused = document.activeElement === chart
      const replacement = forecastChart(provider, now, width)
      chart.replaceWith(replacement)
      if (focused) replacement.focus({ preventScroll: true })
    }
    updateForecastControls()
  })
}

function zoomForecast(factor, anchor = (forecastView.start + forecastView.end) / 2) {
  const { start, end } = forecastView
  const span = Math.max(HOUR, Math.min(30 * DAY, (end - start) * factor))
  const next = anchor - (anchor - start) / (end - start) * span
  setForecastView(next, next + span)
}

function updateForecastControls() {
  const { start, end } = forecastView
  const span = end - start
  for (const button of app.querySelectorAll("[data-chart-range]")) {
    const range = Number(button.dataset.chartRange)
    const active = range ? Math.abs(end - forecastNow) < 1 && Math.abs(span - range) < 1 : span === 30 * DAY
    button.setAttribute("aria-pressed", String(active))
  }
  const disabled = { earlier: start <= forecastNow - 15 * DAY, later: end >= forecastNow + 15 * DAY, in: span <= HOUR, out: span >= 30 * DAY }
  for (const button of app.querySelectorAll("[data-chart-action]")) button.disabled = disabled[button.dataset.chartAction]
  app.querySelector(".chart-range").textContent = when(new Date(start).toISOString()) + " 至 " + when(new Date(end).toISOString())
}

function forecastControls(now) {
  const toolbar = el("div", "chart-toolbar")
  const ranges = el("div", "chart-control-group")
  ranges.setAttribute("role", "group")
  ranges.setAttribute("aria-label", "图表时间范围")
  for (const [label, range] of [["近 48 小时", 2 * DAY], ["近 7 天", 7 * DAY], ["全部", 0]]) {
    const button = el("button", "", label)
    button.type = "button"
    button.dataset.chartRange = range
    button.addEventListener("click", () => range ? setForecastView(now - range, now) : setForecastView(now - 15 * DAY, now + 15 * DAY))
    ranges.append(button)
  }
  const actions = el("div", "chart-control-group")
  actions.setAttribute("role", "group")
  actions.setAttribute("aria-label", "图表缩放和平移")
  for (const [action, label, path] of [
    ["earlier", "向前平移", "M10 3 5 8l5 5"],
    ["out", "缩小时间范围", "M3 8h10"],
    ["in", "放大时间范围", "M3 8h10M8 3v10"],
    ["later", "向后平移", "m6 3 5 5-5 5"],
  ]) {
    const button = el("button", "chart-icon")
    button.type = "button"
    button.dataset.chartAction = action
    button.setAttribute("aria-label", label)
    button.title = label
    const icon = svgEl("svg", { viewBox: "0 0 16 16", width: 16, height: 16, "aria-hidden": "true" })
    icon.append(svgEl("path", { d: path, fill: "none", stroke: "currentColor", "stroke-width": 1.5, "stroke-linecap": "round", "stroke-linejoin": "round" }))
    button.append(icon)
    button.addEventListener("click", () => {
      if (action === "in" || action === "out") zoomForecast(action === "in" ? 0.5 : 2)
      else {
        const shift = (forecastView.end - forecastView.start) * (action === "earlier" ? -0.5 : 0.5)
        setForecastView(forecastView.start + shift, forecastView.end + shift)
      }
    })
    actions.append(button)
  }
  toolbar.append(ranges, actions)
  return toolbar
}

function chartSample(points, at, interpolate = false) {
  let low = 0
  let high = points.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (points[mid].at <= at) low = mid + 1
    else high = mid
  }
  const previous = points[low - 1]
  if (!previous) return null
  const next = points[low]
  if (!interpolate || !next) return previous
  const ratio = (at - previous.at) / (next.at - previous.at)
  return { ...previous, at, left: previous.left + (next.left - previous.left) * ratio }
}

function quotaScale(provider, start, end) {
  let maximum = 0
  for (const points of [provider.history || [], provider.projection || []]) {
    let preceding = null
    for (const point of points) {
      const at = Date.parse(point.at)
      if (at < start) { preceding = point; continue }
      if (at > end) break
      maximum = Math.max(maximum, point.left || 0, point.capacity || 0)
    }
    if (preceding) maximum = Math.max(maximum, preceding.left || 0, preceding.capacity || 0)
  }
  return Math.max(100, Math.ceil((maximum || provider.capacity || provider.accounts * 100 || 100) / 100) * 100)
}

function forecastChart(provider, now, width = 520) {
  const height = 240
  const pad = { left: 38, right: 18, top: 24, bottom: 46 }
  const plotBottom = height - pad.bottom
  const plotWidth = width - pad.left - pad.right
  const plotHeight = plotBottom - pad.top
  const { start, end } = forecastView
  const empty = Date.parse(provider.emptyAt)
  const x = (at) => pad.left + (at - start) / (end - start) * plotWidth
  const maximum = quotaScale(provider, start, end)
  const y = (left) => pad.top + (maximum - left) / maximum * plotHeight
  const result = outcome(provider, now)
  const label = provider.label + "，剩余 " + (provider.left ?? "—") + "% ，" + result.title + "，" + when(new Date(start).toISOString()) + " 至 " + when(new Date(end).toISOString())
  const chart = svgEl("svg", { class: "forecast-chart", viewBox: `0 0 ${width} ${height}`, role: "group", tabindex: 0, "aria-label": label, "aria-describedby": "forecast-help" })
  chart._source = { provider, now, width }
  chart.dataset.start = start
  chart.dataset.end = end
  chart.dataset.maximum = maximum
  chart.append(svgEl("title", {}, label))
  const clipId = "forecast-clip-" + chartSerial++
  const defs = svgEl("defs")
  const clip = svgEl("clipPath", { id: clipId })
  clip.append(svgEl("rect", { x: pad.left - 3, y: pad.top - 6, width: plotWidth + 6, height: plotHeight + 12 }))
  defs.append(clip)
  chart.append(defs)
  const plot = svgEl("g", { "clip-path": `url(#${clipId})` })

  for (const value of [0, maximum / 2, maximum]) {
    const yy = y(value)
    chart.append(
      svgEl("line", { class: "grid", x1: pad.left, y1: yy, x2: width - pad.right, y2: yy }),
      svgEl("text", { class: "axis-label", x: pad.left - 10, y: yy + 4, "text-anchor": "end" }, value + "%"),
    )
  }
  const detailed = end - start <= 3 * DAY
  for (const [at, anchor] of [[start, "start"], [(start + end) / 2, "middle"], [end, "end"]]) {
    const tick = svgEl("text", { class: "axis-label", x: x(at), y: plotBottom + 19, "text-anchor": anchor }, dateName(at))
    if (detailed) tick.append(svgEl("tspan", { x: x(at), dy: 15 }, new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })))
    chart.append(tick)
  }
  if (!provider.accounts && !provider.history?.length) {
    chart.append(svgEl("text", { class: "empty-label", x: pad.left + plotWidth / 2, y: pad.top + plotHeight / 2, "text-anchor": "middle" }, "没有额度读数"))
    return chart
  }

  const parse = (points) => (points || []).map((p) => ({ at: Date.parse(p.at), left: p.left, capacity: p.capacity ?? provider.capacity ?? provider.accounts * 100, accounts: p.accounts ?? provider.accounts })).filter((p) => Number.isFinite(p.at) && Number.isFinite(p.left))
  const history = parse(provider.history)
  const projection = parse(provider.projection)
  const path = (points, step = false) => {
    if (!points.length || points[0].at > end || points[points.length - 1].at < start) return ""
    const first = points.findIndex((p) => p.at >= start)
    if (first < 0) return ""
    const last = points.findIndex((p) => p.at > end)
    const visible = points.slice(Math.max(0, first - 1), last < 0 ? undefined : last + 1)
    return visible.map((p, i) => {
      const xx = x(p.at).toFixed(2)
      const yy = y(p.left).toFixed(2)
      return i === 0 ? `M${xx},${yy}` : step ? `L${xx},${y(visible[i - 1].left).toFixed(2)}L${xx},${yy}` : `L${xx},${yy}`
    }).join(" ")
  }
  const historyPath = path(history, true)
  const projectionPath = path(projection)
  const capacityHistory = path(history.map((p) => ({ ...p, left: p.capacity })), true)
  const capacityProjection = path(projection.map((p) => ({ ...p, left: p.capacity })), true)
  if (capacityHistory) plot.append(svgEl("path", { class: "capacity-line", d: capacityHistory }))
  if (capacityProjection) plot.append(svgEl("path", { class: "capacity-line", d: capacityProjection }))
  if (historyPath) plot.append(svgEl("path", { class: "history", d: historyPath }))
  if (projectionPath) plot.append(svgEl("path", { class: "projection", d: projectionPath }))
  if (!historyPath && !projectionPath) chart.append(svgEl("text", { class: "empty-label", x: pad.left + plotWidth / 2, y: pad.top + plotHeight / 2, "text-anchor": "middle" }, "这一时段没有额度读数"))

  if (now >= start && now <= end && provider.accounts) {
    const nowX = x(now)
    plot.append(svgEl("line", { class: "now-line", x1: nowX, y1: pad.top, x2: nowX, y2: plotBottom }))
    const nowLeft = projection[0]?.at === now ? projection[0].left : provider.left
    plot.append(svgEl("circle", { class: "now-point", cx: nowX, cy: y(nowLeft), r: 4.5 }))
    chart.append(svgEl("text", { class: "axis-label", x: Math.min(width - pad.right, Math.max(pad.left + 12, nowX)), y: pad.top - 10, "text-anchor": nowX > width - 40 ? "end" : "middle" }, "现在"))
  }
  chart.append(plot)

  const groups = new Map()
  for (const account of provider.accountsDetail || []) {
    const resetAt = Date.parse(account.reset)
    const cycle = resetAt - Date.parse(account.start)
    if (!Number.isFinite(resetAt) || !(cycle > 0)) continue
    // The current window's start is the last known reset; later ones are projected.
    for (let at = resetAt - cycle; at <= end; at += cycle) {
      if (at < start) continue
      if (!groups.has(at)) groups.set(at, [])
      groups.get(at).push(account)
    }
  }
  for (const [at, accounts] of groups) {
    const xx = x(at)
    const sample = chartSample(at <= now ? history : projection, at, at > now)
    if (!sample) continue
    const marker = svgEl("g", { class: "reset-marker" })
    const description = "周额度重置 " + when(new Date(at).toISOString()) + "：" + accounts.map((a) => a.label + " · " + a.window).join("、")
    marker.append(svgEl("circle", { class: "reset-dot", cx: xx, cy: y(sample.left), r: 4.5 }))
    const hit = svgEl("circle", { class: "reset-hit", cx: xx, cy: y(sample.left), r: 10, tabindex: 0, role: "button", "aria-label": description })
    const show = (event) => {
      const rect = hit.getBoundingClientRect()
      showAccountTooltip(accounts, new Date(at).toISOString(), event?.clientX ?? rect.x + rect.width / 2, event?.clientY ?? rect.y + rect.height / 2)
    }
    hit.addEventListener("pointermove", show)
    hit.addEventListener("click", show)
    hit.addEventListener("focus", () => show())
    hit.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); show() }
    })
    hit.addEventListener("pointerleave", hideTooltip)
    hit.addEventListener("blur", hideTooltip)
    marker.append(hit)
    plot.append(marker)
  }
  const membershipGroups = new Map()
  const kinds = { observed: "首次记录", included: "纳入统计", excluded: "排除统计", unavailable: "缺少当前周额度" }
  for (const event of provider.membershipEvents || []) {
    const at = Date.parse(event.at)
    if (at < start || at > end) continue
    if (!membershipGroups.has(at)) membershipGroups.set(at, [])
    membershipGroups.get(at).push(event)
  }
  for (const [at, events] of membershipGroups) {
    const last = events.at(-1)
    const xx = x(at), yy = y(last.left)
    const marker = svgEl("g", { class: "membership-marker" })
    marker.append(svgEl("path", { class: "membership-dot", d: `M${xx},${yy - 5}l5,5 -5,5 -5,-5Z` }))
    const description = "账号统计变化 " + when(new Date(at).toISOString()) + "：" + events.map((e) => kinds[e.kind] + " " + e.label).join("、") + "，总容量 " + last.capacity + "%"
    const hit = svgEl("circle", { class: "reset-hit membership-hit", cx: xx, cy: yy, r: 12, tabindex: 0, role: "button", "aria-label": description })
    const show = (event) => {
      const rect = hit.getBoundingClientRect()
      tooltip.replaceChildren(el("div", "tooltip-date", "账号变化 " + when(new Date(at).toISOString())))
      const list = el("div", "tooltip-accounts")
      for (const entry of events) list.append(el("div", "", kinds[entry.kind] + " · " + entry.label))
      list.append(el("div", "tooltip-value", "总容量 " + last.capacity + "% · 剩余 " + last.left + "%"))
      tooltip.append(list)
      tooltip.hidden = false
      positionTooltip(event?.clientX ?? rect.x, event?.clientY ?? rect.y)
    }
    hit.addEventListener("pointermove", show)
    hit.addEventListener("click", show)
    hit.addEventListener("focus", () => show())
    hit.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); show() } })
    hit.addEventListener("pointerleave", hideTooltip)
    hit.addEventListener("blur", hideTooltip)
    marker.append(hit)
    plot.append(marker)
  }
  if (Number.isFinite(empty) && empty >= start && empty <= end) {
    const xx = x(empty)
    plot.append(svgEl("circle", { class: "empty-point", cx: xx, cy: y(0), r: 4 }))
    chart.append(svgEl("text", { class: "empty-time", x: Math.max(pad.left + 34, Math.min(width - pad.right - 34, xx)), y: y(0) - 11, "text-anchor": "middle" }, "全部耗尽"))
  }

  const cursor = svgEl("g", { class: "chart-cursor", visibility: "hidden", "pointer-events": "none" })
  const cursorLine = svgEl("line", { x1: 0, x2: 0, y1: pad.top, y2: plotBottom })
  const cursorDot = svgEl("circle", { cx: 0, cy: 0, r: 4 })
  cursor.append(cursorLine, cursorDot)
  plot.append(cursor)
  const timeAt = (clientX) => {
    const rect = chart.getBoundingClientRect()
    return start + Math.max(0, Math.min(1, ((clientX - rect.left) / rect.width * width - pad.left) / plotWidth)) * (end - start)
  }
  const inspect = (event) => {
    if (event.target.closest?.(".reset-hit")) { cursor.setAttribute("visibility", "hidden"); return }
    const at = timeAt(event.clientX)
    const actual = at <= now
    const sample = chartSample(actual ? history : projection, at, !actual)
    if (!sample) { cursor.setAttribute("visibility", "hidden"); hideTooltip(); return }
    const xx = x(at)
    cursorLine.setAttribute("x1", xx)
    cursorLine.setAttribute("x2", xx)
    cursorDot.setAttribute("cx", xx)
    cursorDot.setAttribute("cy", y(sample.left))
    cursor.setAttribute("visibility", "visible")
    tooltip.replaceChildren(el("div", "tooltip-date", when(new Date(sample.at).toISOString())))
    const rows = el("div", "tooltip-rows")
    rows.append(el("span", "tooltip-label", actual ? "历史总剩余" : "预测总剩余"), el("span", "tooltip-value", Math.round(sample.left * 10) / 10 + "%"))
    rows.append(el("span", "tooltip-label", "统计容量"), el("span", "tooltip-value", sample.capacity + "% · " + sample.accounts + " 个账号"))
    tooltip.append(rows)
    tooltip.hidden = false
    positionTooltip(event.clientX, event.clientY)
  }
  chart.addEventListener("pointermove", (event) => {
    if (!chart.parentElement?.classList.contains("chart-dragging")) inspect(event)
  })
  chart.addEventListener("pointerleave", () => { cursor.setAttribute("visibility", "hidden"); hideTooltip() })
  chart.addEventListener("wheel", (event) => {
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    zoomForecast(Math.exp(Math.max(-1, Math.min(1, event.deltaY * 0.005))), timeAt(event.clientX))
  }, { passive: false })
  chart.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !event.isPrimary || event.target.closest?.(".reset-hit")) return
    const owner = chart.parentElement
    const initial = { ...forecastView }
    const origin = event.clientX
    const pixels = chart.getBoundingClientRect().width * plotWidth / width
    let moved = false
    owner.setPointerCapture(event.pointerId)
    const move = (next) => {
      if (next.pointerId !== event.pointerId || Math.abs(next.clientX - origin) < 4 && !moved) return
      moved = true
      owner.classList.add("chart-dragging")
      const shift = (origin - next.clientX) / pixels * (initial.end - initial.start)
      setForecastView(initial.start + shift, initial.end + shift)
    }
    const stop = (next) => {
      if (next.pointerId !== event.pointerId) return
      owner.removeEventListener("pointermove", move)
      owner.removeEventListener("pointerup", stop)
      owner.removeEventListener("pointercancel", stop)
      if (owner.hasPointerCapture(event.pointerId)) owner.releasePointerCapture(event.pointerId)
      owner.classList.remove("chart-dragging")
      if (!moved && next.type !== "pointercancel") inspect(next)
    }
    owner.addEventListener("pointermove", move)
    owner.addEventListener("pointerup", stop)
    owner.addEventListener("pointercancel", stop)
  })
  chart.addEventListener("keydown", (event) => {
    if (event.target !== chart) return
    if (event.key === "+" || event.key === "=") zoomForecast(0.5)
    else if (event.key === "-") zoomForecast(2)
    else if (event.key === "Home") setForecastView(now - 15 * DAY, now + 15 * DAY)
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const shift = (end - start) * (event.key === "ArrowLeft" ? -0.25 : 0.25)
      setForecastView(start + shift, end + shift)
    } else return
    event.preventDefault()
  })
  return chart
}
