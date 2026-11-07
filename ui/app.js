const boot = JSON.parse(document.getElementById("boot").textContent || "{}")
const statusEl = document.getElementById("status")
const app = document.getElementById("app")
const tooltip = document.getElementById("tooltip")

function el(tag, cls, text) {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text != null) node.textContent = text
  return node
}

function svgEl(tag, attrs = {}, text) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
  if (text != null) node.textContent = text
  return node
}

function dur(hours) {
  if (!Number.isFinite(hours)) return "—"
  if (hours < 1) return Math.max(1, Math.round(hours * 60)) + " 分钟"
  if (hours < 48) return (hours < 10 ? (Math.round(hours * 10) / 10).toFixed(1) : String(Math.round(hours))) + " 小时"
  const days = hours / 24
  return (days < 10 ? (Math.round(days * 10) / 10).toFixed(1) : String(Math.round(days))) + " 天"
}

function when(iso) {
  const date = new Date(iso)
  if (!iso || Number.isNaN(date.getTime())) return "—"
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

function dayName(day) {
  return day.slice(5).replace("-", "/")
}

const compactNumber = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })
const decimalNumber = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 })

function accountUnits(value) {
  return value == null ? "—" : decimalNumber.format(value)
}

function tokenValue(value, partial) {
  if (value == null) return "—"
  return compactNumber.format(value) + (partial ? "+" : "")
}

function tokenText(value, partial) {
  return value == null ? "tokens —" : tokenValue(value, partial) + " tokens"
}

function costValue(value, partial) {
  if (value == null) return "—"
  const formatted = Math.abs(value) >= 1000 ? compactNumber.format(value) : (Math.round(value * 100) / 100).toFixed(2)
  return "$" + formatted + (partial ? "+" : "")
}

function costText(value, partial) {
  return "成本 " + costValue(value, partial)
}

function dayDescription(value) {
  return value.day + " · " + accountUnits(value.accountUnits) + " 账号当量 · " + tokenText(value.tokens, value.tokensPartial) + " · " + costText(value.cost, value.costPartial)
}

function positionTooltip(x, y) {
  const rect = tooltip.getBoundingClientRect()
  const gutter = 8
  let left = x + 14
  if (left + rect.width > innerWidth - gutter) left = x - rect.width - 14
  let top = y + 16
  if (top + rect.height > innerHeight - gutter) top = y - rect.height - 16
  tooltip.style.left = Math.max(gutter, Math.min(left, innerWidth - rect.width - gutter)) + "px"
  tooltip.style.top = Math.max(gutter, Math.min(top, innerHeight - rect.height - gutter)) + "px"
}

function showAccountTooltip(accounts, resetAt, x, y) {
  tooltip.replaceChildren()
  tooltip.append(el("div", "tooltip-date", "重置 " + when(resetAt)))
  const list = el("div", "tooltip-accounts")
  for (const account of accounts) {
    const row = el("div", "tooltip-account")
    row.append(el("span", "tooltip-account-name", account.label), el("span", "tooltip-value", account.window))
    list.append(row)
  }
  tooltip.append(list)
  tooltip.hidden = false
  positionTooltip(x, y)
}

function showTooltip(value, x, y) {
  tooltip.replaceChildren()
  tooltip.append(el("div", "tooltip-date", value.day))
  const rows = el("div", "tooltip-rows")
  for (const [label, text] of [
    ["账号当量", accountUnits(value.accountUnits)],
    ["Token", tokenValue(value.tokens, value.tokensPartial)],
    ["成本", costValue(value.cost, value.costPartial)],
  ]) {
    rows.append(el("span", "tooltip-label", label), el("span", "tooltip-value", text))
  }
  tooltip.append(rows)
  tooltip.hidden = false
  positionTooltip(x, y)
}

function hideTooltip() {
  tooltip.hidden = true
}

function outcome(provider, now) {
  if (!provider.accounts) return { title: "没有进行中的窗口", detail: "等待额度读数" }
  if (provider.left <= 0) return { title: "会耗尽", detail: "等待重置" }
  if (provider.status === "stale") return { title: "暂时无法判断", detail: "需要最近 30 分钟内的额度读数" }
  if (provider.status === "insufficient") return { title: "暂时无法判断", detail: "每个账号至少需要两个额度读数" }
  if (provider.emptyAt) {
    return {
      title: "会耗尽",
      headline: provider.emptyAt,
      detail: dur((new Date(provider.emptyAt).getTime() - now) / 3600000) + " 后",
    }
  }
  if (provider.projectedLeftAtReset != null) {
    return { title: "不会耗尽", detail: "下次重置时平均剩余 " + provider.projectedLeftAtReset + "%" }
  }
  return { title: "不会耗尽", detail: "" }
}

function dateName(iso) {
  const date = new Date(iso)
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })
}

function forecastChart(provider, now, width = 520) {
  const height = 216
  const pad = { left: 38, right: 18, top: 32, bottom: 38 }
  const plotBottom = height - pad.bottom
  const plotWidth = width - pad.left - pad.right
  const plotHeight = plotBottom - pad.top
  const start = now - 15 * 86400000
  const end = now + 15 * 86400000
  const reset = Date.parse(provider.resetAt)
  const empty = Date.parse(provider.emptyAt)
  const x = (at) => pad.left + (at - start) / (end - start) * plotWidth
  const y = (left) => pad.top + (100 - left) / 100 * plotHeight
  const result = outcome(provider, now)
  const label = provider.label + "，剩余 " + (provider.left ?? "—") + "%，" + result.title + "，下次重置 " + when(provider.resetAt)
  const chart = svgEl("svg", { class: "forecast-chart", viewBox: `0 0 ${width} ${height}`, role: "group", "aria-label": label })
  chart._source = { provider, now, width }
  chart.append(svgEl("title", {}, label))
  if (provider.resetLabel) chart.append(svgEl("desc", {}, "下次重置窗口：" + provider.resetLabel))

  for (const value of [0, 50, 100]) {
    const yy = y(value)
    chart.append(
      svgEl("line", { class: "grid", x1: pad.left, y1: yy, x2: width - pad.right, y2: yy }),
      svgEl("text", { class: "axis-label", x: pad.left - 10, y: yy + 4, "text-anchor": "end" }, value + "%"),
    )
  }

  if (!provider.accounts) {
    chart.append(svgEl("text", { class: "empty-label", x: pad.left + plotWidth / 2, y: pad.top + plotHeight / 2, "text-anchor": "middle" }, "没有额度读数"))
    return chart
  }

  const nowX = x(now)
  chart.append(svgEl("line", { class: "now-line", x1: nowX, y1: pad.top, x2: nowX, y2: plotBottom }))

  const path = (points) => points
    .filter((point) => {
      const at = Date.parse(point.at)
      return at >= start && at <= end && Number.isFinite(point.left)
    })
    .map((point, index) => (index === 0 ? "M" : "L") + x(Date.parse(point.at)).toFixed(2) + "," + y(point.left).toFixed(2))
    .join(" ")
  const history = Array.isArray(provider.history) ? provider.history : []
  const projection = Array.isArray(provider.projection) ? provider.projection : []
  const historyPath = path(history)
  const projectionPath = path(projection)
  if (historyPath) chart.append(svgEl("path", { class: "history", d: historyPath }))
  if (projectionPath) chart.append(svgEl("path", { class: "projection", d: projectionPath }))

  const resets = []
  for (const account of provider.accountsDetail || []) {
    const resetAt = Date.parse(account.reset)
    const cycle = resetAt - Date.parse(account.start)
    if (!Number.isFinite(resetAt) || !(cycle > 0)) continue
    for (let at = resetAt; at <= end; at += cycle) {
      if (at >= start) resets.push({ at, account })
    }
  }
  const groups = new Map()
  for (const event of resets) {
    const key = String(event.at)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(event.account)
  }
  for (const [key, accounts] of groups) {
    const at = Number(key)
    const xx = x(at)
    const previous = projection.findLast((point) => Date.parse(point.at) < at)
    const marker = svgEl("g", { class: "reset-marker" })
    const names = accounts.map((account) => account.label + " · " + account.window).join("、")
    const description = "周额度重置 " + when(new Date(at).toISOString()) + "：" + names
    const dot = svgEl("circle", { class: "reset-dot", cx: xx, cy: y(previous?.left ?? 100), r: 4.5 })
    marker.append(dot)
    const hit = svgEl("circle", {
      class: "reset-hit",
      cx: xx,
      cy: y(previous?.left ?? 100),
      r: 10,
      tabindex: 0,
      role: "button",
      "aria-label": description,
    })
    const show = (event) => {
      const point = event && Number.isFinite(event.clientX) ? event : hit.getBoundingClientRect()
      const clientX = Number.isFinite(point.clientX) ? point.clientX : point.left + point.width / 2
      const clientY = Number.isFinite(point.clientY) ? point.clientY : point.top
      showAccountTooltip(accounts, new Date(at).toISOString(), clientX, clientY)
    }
    hit.addEventListener("mouseenter", show)
    hit.addEventListener("mousemove", show)
    hit.addEventListener("focus", show)
    hit.addEventListener("mouseleave", hideTooltip)
    hit.addEventListener("blur", hideTooltip)
    marker.append(hit)
    chart.append(marker)
  }

  const nowLeft = Date.parse(projection[0]?.at) === now ? projection[0].left : provider.left
  chart.append(svgEl("circle", { class: "now-point", cx: nowX, cy: y(nowLeft), r: 4.5 }))

  if (Number.isFinite(empty) && empty >= start && empty <= end) {
    const xx = x(empty)
    const labelX = Math.max(pad.left + 34, Math.min(width - pad.right - 34, xx))
    chart.append(
      svgEl("circle", { class: "empty-point", cx: xx, cy: y(0), r: 4 }),
      svgEl("text", { class: "empty-time", x: labelX, y: y(0) - 11, "text-anchor": "middle" }, "全部耗尽"),
    )
  }

  chart.append(
    svgEl("text", { class: "axis-label", x: pad.left, y: height - 10 }, dateName(start)),
    svgEl("text", { class: "axis-label", x: nowX, y: height - 10, "text-anchor": "middle" }, "现在"),
    svgEl("text", { class: "axis-label", x: width - pad.right, y: height - 10, "text-anchor": "end" }, dateName(end)),
  )
  return chart
}

function providerPanel(provider, now) {
  const panel = el("article", "provider")
  const color = provider.id === "codex" ? "var(--codex)" : provider.id === "claude" ? "var(--claude)" : "var(--accent)"
  panel.style.setProperty("--provider", color)
  const head = el("div", "provider-head")
  head.append(el("h3", "", provider.label))
  const remaining = el("strong", "", provider.left == null ? "—" : provider.left + "%")
  remaining.setAttribute("aria-label", "剩余 " + (provider.left == null ? "未知" : provider.left + "%"))
  head.append(remaining)
  panel.append(head)

  const result = outcome(provider, now)
  panel.append(el("p", "outcome", result.title))
  if (result.headline) panel.append(el("strong", "exhaustion-time", when(result.headline)))
  if (result.detail) panel.append(el("p", "outcome-detail", result.detail))
  else panel.append(el("p", "outcome-detail", " "))
  panel.append(forecastChart(provider, now))

  if (provider.accounts) {
    panel.append(el("p", "provider-meta", provider.accounts + " 个账号"))
  }
  return panel
}

function selectDay(panel, day) {
  const value = panel._daily.values.find((item) => item.day === day)
  if (!value) return
  panel._selectedDay = day
  panel.querySelector(".day-date").textContent = dayName(day)
  panel.querySelector(".day-account").textContent = accountUnits(value.accountUnits)
  panel.querySelector(".day-usage").textContent = tokenText(value.tokens, value.tokensPartial) + " · " + costText(value.cost, value.costPartial)
  for (const column of panel.querySelectorAll(".day-column")) {
    const on = column.dataset.day === day
    column.classList.toggle("on", on)
    column.querySelector(".day-hit")?.setAttribute("aria-pressed", String(on))
  }
}

function dailyChart(provider, panel, width = 520) {
  const values = provider.values || []
  const height = 180
  const pad = { left: 38, right: 10, top: 16, bottom: 30 }
  const plotBottom = height - pad.bottom
  const plotWidth = width - pad.left - pad.right
  const plotHeight = plotBottom - pad.top
  const max = Math.max(1, ...values.map((value) => value.accountUnits || 0))
  const top = Math.ceil(max * 2) / 2
  const y = (value) => plotBottom - value / top * plotHeight
  const chart = svgEl("svg", {
    class: "daily-chart",
    viewBox: `0 0 ${width} ${height}`,
    role: "group",
    "aria-label": provider.label + " 每日账号当量；选择日期查看 token 和成本",
  })
  chart._source = { provider, panel, width }
  chart.append(svgEl("title", {}, provider.label + " 每日用量"))

  for (const value of [0, top / 2, top]) {
    const yy = y(value)
    chart.append(
      svgEl("line", { class: "grid", x1: pad.left, y1: yy, x2: width - pad.right, y2: yy }),
      svgEl("text", { class: "axis-label", x: pad.left - 9, y: yy + 4, "text-anchor": "end" }, decimalNumber.format(value)),
    )
  }

  const slot = values.length ? plotWidth / values.length : plotWidth
  values.forEach((value, index) => {
    const column = svgEl("g", { class: "day-column" + (value.day === panel._selectedDay ? " on" : ""), "data-day": value.day })
    if (value.accountUnits != null) {
      const barWidth = Math.max(2, slot * 0.56)
      const barHeight = value.accountUnits > 0 ? Math.max(2, plotBottom - y(value.accountUnits)) : 1
      column.append(svgEl("rect", {
        class: "day-bar",
        x: pad.left + slot * index + (slot - barWidth) / 2,
        y: plotBottom - barHeight,
        width: barWidth,
        height: barHeight,
        rx: Math.min(2, barWidth / 2),
      }))
    }
    const hit = svgEl("rect", {
      class: "day-hit",
      x: pad.left + slot * index,
      y: pad.top,
      width: slot,
      height: plotHeight,
      tabindex: 0,
      role: "button",
      "aria-label": dayDescription(value),
      "aria-pressed": String(value.day === panel._selectedDay),
    })
    const select = () => selectDay(panel, value.day)
    hit.addEventListener("mouseenter", (event) => showTooltip(value, event.clientX, event.clientY))
    hit.addEventListener("mousemove", (event) => {
      if (tooltip.hidden) showTooltip(value, event.clientX, event.clientY)
      else positionTooltip(event.clientX, event.clientY)
    })
    hit.addEventListener("mouseleave", hideTooltip)
    hit.addEventListener("focus", () => {
      select()
      const rect = hit.getBoundingClientRect()
      showTooltip(value, rect.left + rect.width / 2, rect.top)
    })
    hit.addEventListener("blur", hideTooltip)
    hit.addEventListener("click", (event) => {
      select()
      showTooltip(value, event.clientX, event.clientY)
    })
    hit.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault()
        select()
      }
    })
    column.append(hit)
    chart.append(column)
  })

  for (const index of [...new Set([0, Math.floor((values.length - 1) / 2), values.length - 1])]) {
    if (index < 0 || !values[index]) continue
    const anchor = index === 0 ? "start" : index === values.length - 1 ? "end" : "middle"
    chart.append(svgEl("text", {
      class: "axis-label",
      x: pad.left + slot * (index + (anchor === "middle" ? 0.5 : anchor === "end" ? 1 : 0)),
      y: height - 8,
      "text-anchor": anchor,
    }, dayName(values[index].day)))
  }
  return chart
}

function dailyPanel(provider) {
  const panel = el("article", "daily-provider")
  const color = provider.id === "codex" ? "var(--codex)" : provider.id === "claude" ? "var(--claude)" : "var(--accent)"
  panel.style.setProperty("--provider", color)
  panel._daily = provider
  panel._selectedDay = provider.values?.at(-1)?.day
  const head = el("div", "daily-head")
  head.append(el("h3", "", provider.label), el("span", "day-date muted"))
  const summary = el("div", "day-summary")
  const account = el("div", "day-account-wrap")
  account.append(el("strong", "day-account"), el("span", "muted", "账号当量"))
  summary.append(account, el("span", "day-usage muted"))
  panel.append(head, summary, dailyChart(provider, panel))
  if (panel._selectedDay) selectDay(panel, panel._selectedDay)
  return panel
}

function windowDetails(rows) {
  const details = el("details", "windows")
  const summary = el("summary", "", "账号窗口 ")
  summary.append(el("span", "muted", String(rows.length)))
  details.append(summary)
  const wrap = el("div", "table-wrap")
  const table = document.createElement("table")
  const head = document.createElement("tr")
  for (const [text, cls] of [["账号", ""], ["窗口", ""], ["剩余", "num"], ["预计耗尽", ""], ["重置", ""]]) {
    const th = el("th", cls, text)
    th.scope = "col"
    head.append(th)
  }
  table.append(head)
  for (const row of rows) {
    const tr = document.createElement("tr")
    const account = el("td", "account", row.label)
    account.title = row.label
    let empty = "—"
    if (row.left <= 0) empty = "已耗尽"
    else if (row.forecastEmptyAt) empty = Date.parse(row.forecastEmptyAt) < Date.parse(row.reset) ? when(row.forecastEmptyAt) : "重置前不会"
    tr.append(account, el("td", "", row.window), el("td", "num", row.left + "%"), el("td", "", empty), el("td", "", when(row.reset)))
    table.append(tr)
  }
  wrap.append(table)
  details.append(wrap)
  return details
}

function fitCharts() {
  for (const chart of app.querySelectorAll(".forecast-chart, .daily-chart")) {
    const source = chart._source
    const width = Math.round(chart.getBoundingClientRect().width)
    if (!source || !width || width === source.width) continue
    const replacement = chart.classList.contains("forecast-chart")
      ? forecastChart(source.provider, source.now, width)
      : dailyChart(source.provider, source.panel, width)
    chart.replaceWith(replacement)
  }
}

function render(data) {
  hideTooltip()
  app.replaceChildren()
  const now = Date.parse(data.now)
  const figure = el("figure", "forecast")
  const figureHead = el("div", "figure-head")
  const title = el("h2", "", "额度耗尽预测")
  title.id = "forecast-title"
  figureHead.append(title, el("p", "note", "只看周额度；实线为实际剩余，虚线按近 3 天平均速度估算。"))
  figure.append(figureHead)

  const byId = new Map((data.providers || []).map((provider) => [provider.id, provider]))
  const providers = ["codex", "claude"].map((id) => byId.get(id) || { id, label: id === "codex" ? "Codex" : "Claude", left: null, accounts: 0 })
  for (const provider of data.providers || []) {
    if (provider.id !== "codex" && provider.id !== "claude") providers.push(provider)
  }
  const grid = el("div", "provider-grid")
  for (const provider of providers) grid.append(providerPanel(provider, now))
  figure.append(grid)
  figure.append(el("figcaption", "note", "前后各 15 天；圆点为周额度重置。"))
  app.append(figure)

  const dailyById = new Map((data.dailyProviders || []).map((provider) => [provider.id, provider]))
  const dailyFigure = el("figure", "daily-usage")
  const dailyTitle = el("h2", "", "每日用量")
  dailyTitle.id = "daily-title"
  const dailyHead = el("div", "figure-head")
  dailyHead.append(dailyTitle, el("p", "note", "1 账号当量 = 各账号最长窗口当天下降百分比之和；重置回升不计。"))
  dailyFigure.append(dailyHead)
  const dailyGrid = el("div", "daily-grid")
  for (const provider of providers) {
    const daily = dailyById.get(provider.id) || {
      id: provider.id,
      label: provider.label,
      values: data.days.map((day) => ({ day, tokens: null, cost: null, accountUnits: null })),
    }
    dailyGrid.append(dailyPanel(daily))
  }
  dailyFigure.append(dailyGrid)
  app.append(dailyFigure)
  if (data.windows.length) app.append(windowDetails(data.windows))
  fitCharts()
}

function show() {
  const data = boot.dashboard
  if (!data) {
    statusEl.textContent = "页面没有带上额度数据。"
    return
  }
  if (data.error) {
    statusEl.textContent = data.error
    return
  }
  render(data)
  statusEl.textContent = data.files?.quota?.missing ? "没有找到 quota-history.json" : when(data.now) + " 更新"
}

document.getElementById("reload").addEventListener("click", (event) => {
  event.currentTarget.disabled = true
  event.currentTarget.textContent = "刷新中…"
  location.reload()
})
document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest?.(".day-hit, .reset-hit")) hideTooltip()
})
addEventListener("scroll", hideTooltip, true)
let resizeFrame = 0
addEventListener("resize", () => {
  hideTooltip()
  cancelAnimationFrame(resizeFrame)
  resizeFrame = requestAnimationFrame(fitCharts)
})
show()
