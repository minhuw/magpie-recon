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

function guidanceText(provider, now) {
  const guide = provider.guidance
  if (!provider.accounts || !guide) return { state: "observe", title: "等待周额度读数", reason: "读到进行中的周额度窗口后，会在这里显示使用建议。" }
  const change = Number.isFinite(guide.changePct) ? Math.max(1, Math.round(Math.abs(guide.changePct))) : null
  switch (guide.action) {
    case "reduce":
      return {
        state: "reduce",
        title: change >= 100 ? "建议暂缓使用，等待额度恢复" : "用得偏快，建议减少约 " + change + "%",
        reason: guide.emptyAt && Date.parse(guide.emptyAt) <= Date.parse(guide.resetAt)
          ? "按当前节奏，预计 " + when(guide.emptyAt) + " 耗尽周额度；放慢用量可延长可用时间。"
          : "当前节奏难以在重置时保留 " + guide.reservePct + " 个百分点，建议降到目标用量。",
      }
    case "increase":
      return { state: "increase", title: "有余量，可增加约 " + change + "%", reason: "按当前习惯，重置前还有较多额度可用；如有任务，可在常用时段增加使用。" }
    case "hold":
      return { state: "hold", title: "节奏合适，保持当前用量", reason: "当前用量接近目标范围，继续按原有习惯使用即可。" }
    case "idle":
      if (guide.targetDailyBurn <= 0) return { state: "idle", title: "剩余额度已在预留范围内", reason: "当前余额不超过目标安全余量，建议等待重置；如需继续使用，可调低目标预留。" }
      return { state: "idle", title: "当前用量很少，有额度可用", reason: "如有任务，可参考建议日消耗开始使用；当前用量接近零，不换算增幅百分比。" }
    case "wait":
      return { state: "wait", title: "周额度已耗尽，等待重置", reason: "当前所有账号的周额度都已用完，最早于 " + when(guide.nextResetAt) + " 重置。" }
    case "stale":
      return { state: "observe", title: "读数较旧，暂不建议调整用量", reason: "需要最近 30 分钟内的额度读数，更新后再判断该增快还是放慢。" }
    case "short_limited":
      return { state: "observe", title: "短时额度偏紧，暂不建议提速", reason: "周额度仍有余量，但短时窗口正在限制使用；先等待短时额度重置，或使用仍可用的账号。" }
    default:
      return { state: "observe", title: "暂时无法判断快慢", reason: "至少需要 6 小时可比较的额度读数，才能给出增减比例；现有 " + decimalNumber.format(guide.coverageHours || 0) + " 小时。" }
  }
}

function usageGuide(providers, now, reservePct = providers.find((p) => p.guidance)?.guidance.reservePct ?? 3) {
  const section = el("section", "usage-guide")
  section.setAttribute("aria-labelledby", "usage-guide-title")
  const title = el("h2", "", "使用建议")
  title.id = "usage-guide-title"
  const heading = el("div", "guide-heading")
  const policy = el("label", "guide-policy muted", "重置时目标预留 ")
  const select = el("select", "")
  select.setAttribute("aria-label", "每账号安全余量")
  const choices = [...new Set([0, 3, 5, 10, reservePct])].sort((a, b) => a - b)
  for (const value of choices) {
    const option = el("option", "", value + " 个百分点")
    option.value = value
    option.selected = value === reservePct
    select.append(option)
  }
  select.addEventListener("change", () => {
    const url = new URL(location.href)
    url.searchParams.set("reservePct", select.value)
    location.assign(url.href)
  })
  policy.append(select)
  heading.append(title, policy)
  section.append(heading, el("p", "note", "目标是持续用到周额度重置，并留出安全余量。增减比例指额度消耗速度。"))
  const list = el("div", "guide-list")
  for (const provider of providers) {
    const guide = provider.guidance
    const text = guidanceText(provider, now)
    const row = el("article", "guide-row guide-" + text.state)
    row.setAttribute("aria-label", provider.label + " 使用建议")
    row.append(el("h3", "guide-provider", provider.label))
    const body = el("div", "guide-body")
    body.append(el("p", "guide-action", text.title), el("p", "guide-reason muted", text.reason))
    if (guide?.accountsEmpty > 0 && guide.accountsEmpty < guide.totalAccounts) {
      body.append(el("p", "guide-reason muted", "已有 " + guide.accountsEmpty + " 个账号周额度耗尽，后续用量按转移到其余账号估算。"))
    }
    row.append(body)
    const rates = el("dl", "guide-rates")
    const rate = (value) => Number.isFinite(value) ? decimalNumber.format(value) + " 个百分点 / 天" : "暂无法估算"
    const stale = guide?.action === "stale"
    for (const [label, value] of [["按当前节奏", stale ? null : guide?.currentDailyBurn], [guide?.action === "observe" || guide?.action === "idle" ? "日预算参考" : "建议日消耗", stale ? null : guide?.targetDailyBurn]]) {
      rates.append(el("dt", "muted", label), el("dd", "", rate(value)))
    }
    row.append(rates)
    if (guide) {
      const details = el("details", "guide-details")
      details.append(el("summary", "", "建议依据"))
      details.append(el("p", "", "以 " + when(guide.resetAt) + " 前的使用为计划，每个账号预留 " + guide.reservePct + " 个百分点。目标附近约 10% 的偏差通常建议保持；预计提前耗尽时仍建议减速。"))
      const pattern = guide.seasonal === "weekly" ? "参考每周和日内规律" : guide.seasonal === "daily" ? "参考日内规律" : "按近期用量估计，尚未启用时段规律"
      details.append(el("p", "", "有效观测 " + decimalNumber.format(guide.coverageHours) + " 小时；" + pattern + "。近期读数权重更高，额度耗尽后的停用不当作需求下降。"))
      details.append(el("p", "", "日消耗指未来 24 小时的估计；多账号时取每账号平均值，不能直接等同请求量或 token 数。"))
      if (guide.assumption) details.append(el("p", "", "多账号按容量相同、请求可互相切换估算；不同订阅档位的结果需要结合实际容量判断。"))
      for (const limited of guide.shortLimited || []) details.append(el("p", "", limited.label + " · " + limited.window + " 剩余 " + limited.left + "%，重置于 " + when(limited.reset) + "。"))
      row.append(details)
    }
    list.append(row)
  }
  section.append(list)
  return section
}

function outcome(provider, now) {
  if (!provider.accounts) return { title: "没有进行中的窗口", detail: "等待额度读数" }
  if (provider.left <= 0) return { title: "已耗尽", detail: "等待重置" }
  if (provider.status === "stale") return { title: "暂时无法判断", detail: "需要最近 30 分钟内的额度读数" }
  if (provider.status === "insufficient") return { title: "暂时无法判断", detail: "需要至少 20 分钟可比较的额度读数" }
  if (provider.emptyAt && Date.parse(provider.emptyAt) <= now) return { title: "可能已耗尽", detail: "估计用量已超过最后读数，需要更新额度确认" }
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
  const summary = el("div", "forecast-summary")
  summary.append(el("p", "outcome", result.title))
  if (result.headline) summary.append(el("strong", "exhaustion-time", when(result.headline)))
  if (result.detail) summary.append(el("p", "outcome-detail", result.detail))
  panel.append(summary, forecastChart(provider, now))

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
  forecastNow = now
  forecastView = { start: now - 15 * DAY, end: now + 15 * DAY }
  const figure = el("figure", "forecast")
  const figureHead = el("div", "figure-head")
  const title = el("h2", "", "额度耗尽预测")
  title.id = "forecast-title"
  figureHead.append(title, el("p", "note", "只看周额度；历史按小时显示并保留小时内极值，虚线按近期用量和已识别的时段规律估算。"))
  figure.append(figureHead, forecastControls(now), el("p", "chart-range muted"))

  const byId = new Map((data.providers || []).map((provider) => [provider.id, provider]))
  const providers = ["codex", "claude"].map((id) => byId.get(id) || { id, label: id === "codex" ? "Codex" : "Claude", left: null, accounts: 0 })
  for (const provider of data.providers || []) {
    if (provider.id !== "codex" && provider.id !== "claude") providers.push(provider)
  }
  app.append(usageGuide(providers, now, data.policy?.reservePct))
  const grid = el("div", "provider-grid")
  for (const provider of providers) grid.append(providerPanel(provider, now))
  figure.append(grid)
  const help = el("figcaption", "note", "可查看前后各 15 天；圆点为周额度重置。拖动平移，按住 Ctrl / ⌘ 滚轮缩放；聚焦图表后也可用方向键和 + / −。")
  help.id = "forecast-help"
  figure.append(help)
  app.append(figure)
  updateForecastControls()

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
