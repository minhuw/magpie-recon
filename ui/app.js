const boot = JSON.parse(document.getElementById("boot").textContent || "{}")
const statusEl = document.getElementById("status")
const app = document.getElementById("app")
const tip = document.getElementById("tip")
const compact = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 })

let data = null
let tab = "people"
let selected = null
let timer = 0

function el(tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

function tokens(n) {
  const v = Number(n) || 0
  if (Math.abs(v) < 1000) return String(Math.round(v))
  return compact.format(v)
}

function dur(h) {
  if (h == null || !Number.isFinite(h)) return "—"
  if (h < 1) return Math.max(1, Math.round(h * 60)) + " 分钟"
  if (h < 48) return (h < 10 ? (Math.round(h * 10) / 10).toFixed(1) : String(Math.round(h))) + " 小时"
  const d = h / 24
  return (d < 10 ? (Math.round(d * 10) / 10).toFixed(1) : String(Math.round(d))) + " 天"
}

function when(iso) {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

function cssvar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

function verdictView(d) {
  const v = d.verdict
  const title = {
    tighten: "偏快，会在 reset 前用完",
    loosen: "偏慢，有账号几乎没在花",
    speed: "偏慢，可以加速",
    hold: "和均匀消耗差不多",
    idle: "几乎没有消耗",
    unknown: "还判断不了快慢",
  }[v.id] || "还判断不了快慢"
  const lines = []
  if (v.id === "unknown") {
    lines.push("quota-history.json 里没有还开着的窗口，只能看用量，看不出该快还是该慢。")
  } else if (v.id === "tighten" && v.worst) {
    const w = v.worst
    const bySlope = w.hoursToEmpty != null && w.hoursToEmpty < w.hoursToReset * 0.9
    const empty = bySlope ? "按最近的斜率大约 " + dur(w.hoursToEmpty) + " 后见底" : "已经比均匀消耗少了一截"
    lines.push(w.label + " 的「" + w.window + "」" + empty + "，reset 还要 " + dur(w.hoursToReset) + "。")
    lines.push(v.shortOnly
      ? "都是短窗口，等这次 reset 就行，不必为此补账号。这段时间减速即可。"
      : "减速，或者再补账号。这两个文件看不出还有没有没登上去的号，所以分不清「多登」和「新买」。")
  } else if (v.id === "idle") {
    const names = (v.idle || []).map((w) => w.label).join("、")
    lines.push((names || "这些账号") + " 的窗口还很满，这个周期几乎没有调用。可以少登一些。")
  } else if (v.id === "loosen" || v.id === "speed") {
    lines.push("按现在的速度，到 reset 还会剩不少，可以加速。")
  } else {
    lines.push("最紧的窗口贴着均匀消耗。维持现在的用量就行。")
  }
  if (v.idle && v.idle.length && (v.id === "loosen" || v.id === "speed" || v.id === "hold")) {
    lines.push("这些几乎没在花，可以少登：" + v.idle.map((w) => w.label).join("、") + "。")
  }
  if (!d.log.covered && v.id !== "unknown") {
    lines.push("没有读到用量账本，看不出哪些账号闲着，剩余 token 也换算不了。快慢只来自厂商的剩余百分比。")
  }
  return { title, detail: lines.join("") }
}

function fileLine(d) {
  const parts = []
  const u = d.files && d.files.usage
  const q = d.files && d.files.quota
  if (u) parts.push(u.missing ? "没有 usage.jsonl" : "用量 " + u.lines + " 行" + (u.bad ? "，跳过 " + u.bad + " 行" : ""))
  if (q) parts.push(q.missing ? "没有 quota-history.json" : "额度历史 " + (q.accounts || 0) + " 个账号")
  if (d.files && d.files.dir) parts.push(d.files.dir)
  return parts.join(" · ")
}

function spark(values) {
  const w = 96
  const h = 28
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("class", "spark")
  svg.setAttribute("width", String(w))
  svg.setAttribute("height", String(h))
  svg.setAttribute("viewBox", "0 0 " + w + " " + h)
  const max = Math.max(1, ...values)
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
  const d = values.map((v, i) => {
    const x = values.length === 1 ? w / 2 : (i / (values.length - 1)) * (w - 2) + 1
    const y = h - 2 - (Number(v) / max) * (h - 4)
    return (i ? "L" : "M") + x.toFixed(1) + "," + y.toFixed(1)
  }).join("")
  path.setAttribute("d", d)
  path.setAttribute("fill", "none")
  path.setAttribute("stroke", "currentColor")
  path.setAttribute("stroke-width", "1.5")
  svg.append(path)
  return svg
}

function paceLabel(pace) {
  return { hot: "偏快", cool: "偏慢", even: "差不多", idle: "闲着" }[pace] || pace
}

function stat(label, value, sub) {
  const box = el("div", "stat")
  box.append(el("span", "", label), el("b", "", value))
  if (sub) box.append(el("span", "", sub))
  return box
}

function section(title, note) {
  const wrap = document.createElement("section")
  wrap.append(el("h2", "", title))
  if (note) wrap.append(el("p", "note", note))
  return wrap
}

function drawCandles(canvas, candles) {
  const width = canvas.clientWidth || 640
  const height = 260
  const dpr = Math.min(2, devicePixelRatio || 1)
  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
  const g = canvas.getContext("2d")
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, width, height)
  const pad = { l: 40, r: 8, t: 8, b: 18 }
  const volH = 44
  const plotH = height - pad.t - pad.b - volH
  const vals = candles.flatMap((c) => c.open == null ? [] : [c.low, c.high])
  let min = vals.length ? Math.min(...vals) : 0
  let max = vals.length ? Math.max(...vals) : 100
  const slack = Math.max(2, (max - min) * 0.15)
  min = Math.max(0, min - slack)
  max = Math.min(100, max + slack)
  if (max - min < 5) {
    min = Math.max(0, min - 2)
    max = Math.min(100, max + 2)
  }
  const y = (v) => pad.t + (max - v) / (max - min) * plotH
  const n = Math.max(candles.length, 1)
  const slot = (width - pad.l - pad.r) / n
  g.strokeStyle = cssvar("--line", "#8888")
  g.fillStyle = cssvar("--muted", "#888")
  g.font = "11px sans-serif"
  g.lineWidth = 1
  for (const p of [min, (min + max) / 2, max]) {
    const yy = y(p)
    g.beginPath()
    g.moveTo(pad.l, yy)
    g.lineTo(width - pad.r, yy)
    g.stroke()
    g.fillText(Math.round(p) + "%", 2, yy + 4)
  }
  const hits = []
  candles.forEach((c, i) => {
    const x = pad.l + slot * i + slot / 2
    hits.push({ x0: pad.l + slot * i, x1: pad.l + slot * (i + 1), candle: c })
    if (c.open == null) return
    const up = c.close >= c.open
    const color = up ? cssvar("--up", "#1f8a4c") : cssvar("--down", "#c2413b")
    g.strokeStyle = color
    g.fillStyle = color
    g.beginPath()
    g.moveTo(x, y(c.high))
    g.lineTo(x, y(c.low))
    g.stroke()
    const top = y(Math.max(c.open, c.close))
    const bot = y(Math.min(c.open, c.close))
    g.fillRect(x - Math.max(2, slot * 0.28), top, Math.max(4, slot * 0.56), Math.max(1, bot - top))
  })
  const maxVol = Math.max(1, ...candles.map((c) => c.volume || 0))
  const base = height - pad.b
  g.fillStyle = cssvar("--muted", "#888")
  candles.forEach((c, i) => {
    const h = ((c.volume || 0) / maxVol) * (volH - 8)
    g.globalAlpha = 0.45
    g.fillRect(pad.l + slot * i + slot * 0.2, base - h, Math.max(1, slot * 0.6), h)
    g.globalAlpha = 1
  })
  const label = (i) => {
    const c = candles[i]
    if (!c) return
    g.fillStyle = cssvar("--muted", "#888")
    g.fillText(c.day.slice(5), pad.l + slot * i, height - 4)
  }
  label(0)
  label(Math.floor((candles.length - 1) / 2))
  label(candles.length - 1)
  canvas._hit = hits
}

function drawTrend(canvas, days, values) {
  const width = canvas.clientWidth || 640
  const height = 160
  const dpr = Math.min(2, devicePixelRatio || 1)
  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
  const g = canvas.getContext("2d")
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, width, height)
  const pad = { l: 40, r: 8, t: 10, b: 18 }
  const max = Math.max(1, ...values)
  const y = (v) => pad.t + (1 - v / max) * (height - pad.t - pad.b)
  const x = (i) => values.length === 1 ? (pad.l + width - pad.r) / 2 : pad.l + (i / (values.length - 1)) * (width - pad.l - pad.r)
  g.strokeStyle = cssvar("--line", "#8888")
  g.fillStyle = cssvar("--muted", "#888")
  g.font = "11px sans-serif"
  g.beginPath()
  g.moveTo(pad.l, y(0))
  g.lineTo(width - pad.r, y(0))
  g.stroke()
  g.fillText(tokens(max), 2, y(max) + 4)
  g.beginPath()
  g.strokeStyle = cssvar("--accent", "#3b6ea5")
  g.lineWidth = 1.5
  values.forEach((v, i) => {
    const px = x(i)
    const py = y(v)
    if (i === 0) g.moveTo(px, py)
    else g.lineTo(px, py)
  })
  g.stroke()
  g.fillStyle = cssvar("--muted", "#888")
  const mark = (i) => { if (days[i]) g.fillText(days[i].slice(5), x(i) - 12, height - 4) }
  mark(0)
  mark(Math.floor((days.length - 1) / 2))
  mark(days.length - 1)
}

function usageTable(rows, kind) {
  const wrap = el("div", "table-wrap")
  const table = document.createElement("table")
  const head = document.createElement("tr")
  for (const [text, cls] of [["", ""], ["24 小时", "num"], ["3 天", "num"], ["7 天", "num"], ["30 天", "num"], ["30 天趋势", ""]]) {
    head.append(el("th", cls, text))
  }
  table.append(head)
  const totals = data.totals
  const totalRow = document.createElement("tr")
  totalRow.className = "click" + (selected && selected.kind === "total" ? " on" : "")
  totalRow.append(el("td", "name", "全部"))
  for (const id of ["h24", "d3", "d7", "d30"]) totalRow.append(el("td", "num", tokens(totals[id].tokens)))
  const totalDaily = data.candles.map((c) => c.volume || 0)
  const totalSpark = document.createElement("td")
  totalSpark.append(spark(totalDaily))
  totalRow.append(totalSpark)
  totalRow.addEventListener("click", () => pick({ kind: "total" }))
  table.append(totalRow)
  rows.forEach((row, index) => {
    const tr = document.createElement("tr")
    tr.className = "click" + (selected && selected.kind === kind && selected.index === index ? " on" : "")
    const name = el("td", "name", row.name)
    name.title = row.name
    tr.append(name)
    for (const id of ["h24", "d3", "d7", "d30"]) {
      const cell = el("td", "num", tokens(row[id].tokens))
      if (row[id].calls) cell.title = row[id].calls + " 次" + (row[id].errors ? "，" + row[id].errors + " 次失败" : "")
      tr.append(cell)
    }
    const trend = document.createElement("td")
    trend.append(spark(row.daily || []))
    tr.append(trend)
    tr.addEventListener("click", () => pick({ kind, index }))
    table.append(tr)
  })
  wrap.append(table)
  return wrap
}

function windowTable(rows) {
  const wrap = el("div", "table-wrap")
  const table = document.createElement("table")
  const head = document.createElement("tr")
  for (const [text, cls] of [["账号", ""], ["窗口", ""], ["剩余", "num"], ["均匀消耗应剩", "num"], ["差距", "num"], ["reset", ""], ["判断", ""]]) {
    head.append(el("th", cls, text))
  }
  table.append(head)
  for (const w of rows) {
    const tr = document.createElement("tr")
    const name = el("td", "name", w.label)
    name.title = w.label
    if (w.binding) name.append(el("span", "mark", " · 用来判断"))
    tr.append(name, el("td", "", w.window), el("td", "num", w.left + "%"), el("td", "num", w.even + "%"))
    const gap = el("td", "num", (w.gap > 0 ? "+" : "") + w.gap)
    tr.append(gap, el("td", "", when(w.reset)))
    const pace = el("td", "pill " + w.pace, paceLabel(w.pace))
    const bits = []
    if (w.hoursToEmpty != null) bits.push("大约 " + dur(w.hoursToEmpty) + " 后见底")
    if (w.remaining != null) bits.push("估算还剩 " + tokens(w.remaining) + " token")
    if (w.unseen) bits.push("账本里这个周期几乎没有它的调用")
    if (bits.length) pace.title = bits.join("，")
    tr.append(pace)
    table.append(tr)
  }
  wrap.append(table)
  return wrap
}

function pick(next) {
  selected = next
  const on = app.querySelectorAll("tr.on")
  on.forEach((n) => n.classList.remove("on"))
  renderTrend()
  const rows = app.querySelectorAll("tr.click")
  const list = tab === "people" ? data.people : data.accounts
  let at = 0
  rows.forEach((tr) => {
    const isTotal = at === 0
    const index = at - 1
    at++
    const hit = isTotal ? next.kind === "total" : next.kind === tab && next.index === index
    if (hit) tr.classList.add("on")
  })
}

function trendSeries() {
  if (!data) return { title: "", values: [] }
  if (selected && selected.kind === "people" && data.people[selected.index]) {
    const row = data.people[selected.index]
    return { title: row.name + " 的 30 天", values: row.daily }
  }
  if (selected && selected.kind === "accounts" && data.accounts[selected.index]) {
    const row = data.accounts[selected.index]
    return { title: row.name + " 的 30 天", values: row.daily }
  }
  return { title: "全部调用的 30 天", values: data.candles.map((c) => c.volume || 0) }
}

function renderTrend() {
  const canvas = document.getElementById("trend")
  const title = document.getElementById("trendTitle")
  if (!canvas || !data) return
  const series = trendSeries()
  if (title) title.textContent = series.title
  drawTrend(canvas, data.days, series.values)
}

function render(d) {
  data = d
  app.replaceChildren()
  const view = verdictView(d)
  const banner = el("div", "banner")
  banner.dataset.id = d.verdict.id
  banner.append(el("b", "", view.title), el("p", "", view.detail))
  app.append(banner)

  const reserveSub = []
  if (d.reserve.remainingTokens != null && d.burn.tokensPerHour > 0) {
    reserveSub.push("按账本约剩 " + tokens(d.reserve.remainingTokens) + " token，还能用 " + dur(d.reserve.remainingTokens / d.burn.tokensPerHour))
    if (d.reserve.partial) reserveSub.push("只有一部分窗口换算得出")
  } else if (d.reserve.left == null) reserveSub.push("没有还开着的窗口")
  else reserveSub.push(d.reserve.accounts + " 个账号，各取最紧的窗口")
  const stats = el("div", "stats")
  stats.append(
    stat("总剩余", d.reserve.left == null ? "—" : d.reserve.left + "%", reserveSub.join("，")),
    stat("消耗速度", tokens(d.burn.tokensPerHour) + "/时", "最近 " + d.burn.hours + " 小时的平均"),
    stat("预计见底", d.reserve.hoursToEmpty == null ? "这个周期内不会" : dur(d.reserve.hoursToEmpty) + " 后", "按剩余百分比的最近斜率"),
    stat("下次 reset", d.reserve.nextReset ? dur(d.windows.filter((w) => w.binding).reduce((m, w) => Math.min(m, w.hoursToReset), Infinity)) + " 后" : "—", d.reserve.nextResetLabel || ""),
  )
  app.append(stats)

  const chart = section("总剩余", "每个账号取最长的窗口（通常是周或月），画剩余百分比的平均。阳线是剩余变多，多半是 reset；阴线是在消耗。底下的柱是当天的 token。")
  const chartBox = el("div", "card")
  const candles = document.createElement("canvas")
  candles.id = "candles"
  chartBox.append(candles)
  chart.append(chartBox)
  app.append(chart)

  const wins = section("各账号的窗口", "一个账号有多个窗口时，用最紧的那个判断快慢。剩余 token 用这个周期里账本记到的调用、按已用百分比反推；用得太少就不推。")
  if (!d.windows.length) wins.append(el("p", "note", "没有还开着的窗口。"))
  else wins.append(windowTable(d.windows))
  app.append(wins)

  const usage = section("用量", "人是网关钥匙的名字。大家共用一把钥匙时，这里分不出人。24 小时、3 天、7 天、30 天都是从现在往回数，不是自然日。")
  const tabs = el("div", "tabs")
  for (const [id, label] of [["people", "网关钥匙"], ["accounts", "订阅账号"]]) {
    const b = el("button", "", label)
    b.type = "button"
    b.setAttribute("aria-pressed", String(tab === id))
    b.addEventListener("click", () => { tab = id; selected = { kind: "total" }; render(data) })
    tabs.append(b)
  }
  usage.append(tabs)
  const rows = tab === "people" ? d.people : d.accounts
  if (!rows.length) usage.append(el("p", "note", d.log.covered ? "这 30 天没有调用。" : "没有 usage.jsonl，没有按人的用量。"))
  else usage.append(usageTable(rows, tab))
  const trendCard = el("div", "card")
  trendCard.append(el("p", "note", ""))
  trendCard.firstChild.id = "trendTitle"
  const trend = document.createElement("canvas")
  trend.id = "trend"
  trendCard.append(trend)
  usage.append(trendCard)
  app.append(usage)

  const foot = el("p", "note", "只读 usage.jsonl 和 quota-history.json（额度历史是 JSON，不是 JSONL）。不读 providers.json，所以看不到钥匙，也看不到没写进这两个文件的号。")
  app.append(foot)

  drawCandles(candles, d.candles)
  renderTrend()
  candles.addEventListener("mousemove", (ev) => showTip(ev, candles))
  candles.addEventListener("mouseleave", () => { tip.hidden = true })
}

function showTip(ev, canvas) {
  const rect = canvas.getBoundingClientRect()
  const x = ev.clientX - rect.left
  const hit = (canvas._hit || []).find((h) => x >= h.x0 && x < h.x1)
  if (!hit) { tip.hidden = true; return }
  const c = hit.candle
  tip.hidden = false
  tip.textContent = c.open == null
    ? c.day + "  没有额度读数  " + tokens(c.volume) + " token"
    : c.day + "  开 " + c.open + "%  高 " + c.high + "%  低 " + c.low + "%  收 " + c.close + "%  " + tokens(c.volume) + " token"
  tip.style.left = Math.min(ev.clientX + 12, window.innerWidth - tip.offsetWidth - 8) + "px"
  tip.style.top = (ev.clientY + 16) + "px"
}

async function load() {
  statusEl.textContent = "正在读 usage.jsonl 和 quota-history.json…"
  try {
    const res = await fetch("api/dashboard", { headers: { "x-reserve-token": boot.token || "" } })
    const body = await res.json()
    if (!res.ok) throw new Error(body.error || "读失败")
    if (!selected) selected = { kind: "total" }
    const y = document.scrollingElement ? document.scrollingElement.scrollTop : 0
    render(body)
    if (document.scrollingElement) document.scrollingElement.scrollTop = y
    statusEl.textContent = fileLine(body)
  } catch (err) {
    statusEl.textContent = err && err.message ? err.message : String(err)
  }
}

document.getElementById("reload").addEventListener("click", () => load())
addEventListener("resize", () => {
  if (!data) return
  const candles = document.getElementById("candles")
  if (candles) drawCandles(candles, data.candles)
  renderTrend()
})
load()
timer = setInterval(() => { if (!document.hidden) load() }, 60000)
document.addEventListener("visibilitychange", () => { if (!document.hidden) load() })
void timer
