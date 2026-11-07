const boot = JSON.parse(document.getElementById("boot").textContent || "{}")
const statusEl = document.getElementById("status")
const app = document.getElementById("app")

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

function outcome(provider, now) {
  if (!provider.accounts) return { title: "没有进行中的窗口", detail: "等待额度读数" }
  if (provider.left <= 0) return { title: "全部额度已用尽", detail: "等待重置" }
  if (provider.status === "stale") return { title: "读数过旧，无法估算", detail: "需要最近 30 分钟内的额度读数" }
  if (provider.status === "insufficient") return { title: "暂时无法估算", detail: "每个账号至少需要两个额度读数" }
  if (provider.emptyAt) {
    return {
      title: "预计全部额度 " + when(provider.emptyAt) + " 耗尽",
      detail: dur((new Date(provider.emptyAt).getTime() - now) / 3600000) + " 后",
    }
  }
  if (provider.firstEmptyAt) {
    const at = new Date(provider.firstEmptyAt).getTime()
    return {
      title: at <= now ? "已有账号耗尽" : "最早账号 " + when(provider.firstEmptyAt) + " 耗尽",
      detail: at <= now ? "其他账号仍有额度" : dur((at - now) / 3600000) + " 后 · 单账号预测",
    }
  }
  if (provider.projectedLeftAtReset != null) {
    return { title: "各账号重置前不会耗尽", detail: "下次重置时平均剩余 " + provider.projectedLeftAtReset + "%" }
  }
  return { title: "重置前不会耗尽", detail: "" }
}

function forecastChart(provider, now, width = 520) {
  const height = 216
  const pad = { left: 38, right: 18, top: 32, bottom: 38 }
  const plotBottom = height - pad.bottom
  const plotWidth = width - pad.left - pad.right
  const plotHeight = plotBottom - pad.top
  const reset = Date.parse(provider.resetAt)
  const empty = Date.parse(provider.emptyAt)
  const end = Math.max(now + 30 * 60000, Number.isFinite(reset) ? reset : 0, Number.isFinite(empty) ? empty : 0)
  const safeEnd = end > now ? end : now + 30 * 60000
  const x = (at) => pad.left + (at - now) / (safeEnd - now) * plotWidth
  const y = (left) => pad.top + (100 - left) / 100 * plotHeight
  const result = outcome(provider, now)
  const label = provider.label + "，剩余 " + (provider.left ?? "—") + "%，" + result.title + "，下次重置 " + when(provider.resetAt)
  const chart = svgEl("svg", { class: "forecast-chart", viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": label })
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

  chart.append(svgEl("text", { class: "axis-label", x: pad.left, y: height - 10 }, "现在"))

  if (Number.isFinite(reset)) {
    const xx = x(reset)
    chart.append(
      svgEl("line", { class: "reset-line", x1: xx, y1: pad.top, x2: xx, y2: plotBottom }),
      svgEl("text", { class: "reset-label", x: xx, y: 15, "text-anchor": "end" }, "下次重置"),
      svgEl("text", { class: "axis-label", x: xx, y: height - 10, "text-anchor": "end" }, when(provider.resetAt)),
    )
  }

  const nowX = x(now)
  const projection = Array.isArray(provider.projection) ? provider.projection : []
  const nowLeft = Date.parse(projection[0]?.at) === now ? projection[0].left : provider.left
  const nowY = y(nowLeft)
  if (projection.length > 1) {
    const d = projection.map((point, index) => {
      const prefix = index === 0 ? "M" : "L"
      return prefix + x(Date.parse(point.at)).toFixed(2) + "," + y(point.left).toFixed(2)
    }).join(" ")
    chart.append(svgEl("path", { class: "projection", d }))
  }
  chart.append(svgEl("circle", { class: "now-point", cx: nowX, cy: nowY, r: 4.5 }))

  if (Number.isFinite(empty)) {
    const xx = x(empty)
    const labelX = Math.max(pad.left + 48, Math.min(width - pad.right - 48, xx))
    chart.append(
      svgEl("circle", { class: "empty-point", cx: xx, cy: y(0), r: 4 }),
      svgEl("text", { class: "empty-time", x: labelX, y: y(0) - 11, "text-anchor": "middle" }, "全部耗尽 " + when(provider.emptyAt)),
    )
  }
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
  if (result.detail) panel.append(el("p", "outcome-detail", result.detail))
  else panel.append(el("p", "outcome-detail", " "))
  panel.append(forecastChart(provider, now))

  if (provider.accounts) {
    panel.append(el("p", "provider-meta", provider.accounts + " 个账号"))
  }
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

function fitForecastCharts() {
  for (const chart of app.querySelectorAll(".forecast-chart")) {
    const source = chart._source
    const width = Math.round(chart.getBoundingClientRect().width)
    if (!source || !width || width === source.width) continue
    chart.replaceWith(forecastChart(source.provider, source.now, width))
  }
}

function render(data) {
  app.replaceChildren()
  const now = Date.parse(data.now)
  const figure = el("figure", "forecast")
  const figureHead = el("div", "figure-head")
  const title = el("h2", "", "额度耗尽预测")
  title.id = "forecast-title"
  figureHead.append(title, el("p", "note", "各账号分别按最近速度外推，再合并剩余；不跨重置。"))
  figure.append(figureHead)

  const byId = new Map((data.providers || []).map((provider) => [provider.id, provider]))
  const providers = ["codex", "claude"].map((id) => byId.get(id) || { id, label: id === "codex" ? "Codex" : "Claude", left: null, accounts: 0 })
  for (const provider of data.providers || []) {
    if (provider.id !== "codex" && provider.id !== "claude") providers.push(provider)
  }
  const grid = el("div", "provider-grid")
  for (const provider of providers) grid.append(providerPanel(provider, now))
  figure.append(grid)
  figure.append(el("figcaption", "note", "顶部为最近读数，曲线为估算；百分比按账号平均。"))
  app.append(figure)
  if (data.windows.length) app.append(windowDetails(data.windows))
  fitForecastCharts()
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
let resizeFrame = 0
addEventListener("resize", () => {
  cancelAnimationFrame(resizeFrame)
  resizeFrame = requestAnimationFrame(fitForecastCharts)
})
show()
