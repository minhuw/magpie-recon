// The sandboxed magpie page cannot fetch anything (connect-src 'none').
// Its only network action is to navigate this frame to the local service.
// Keep DEFAULT_PORT equal to package.json's magpie.page.service.port.
(async () => {
  const DEFAULT_PORT = 3478
  let port = DEFAULT_PORT
  let theme = ""
  let tokens = null
  let service = ""

  try {
    const t = await window.magpie?.ready
    if (t) {
      if (typeof t.dark === "boolean") theme = t.dark ? "dark" : "light"
      if (t.tokens && typeof t.tokens === "object") tokens = t.tokens
    }
  } catch { /* opened outside magpie */ }
  try {
    const s = window.magpie?.service
    if (typeof s === "string" && /^https?:\/\//.test(s)) service = s
  } catch { /* older magpie */ }
  try {
    const o = await window.magpie?.options?.get?.()
    if (o && Number(o.port) > 0) port = Number(o.port)
  } catch { /* default port */ }

  const q = new URLSearchParams()
  if (theme) q.set("theme", theme)
  const slim = {}
  for (const [k, v] of Object.entries(tokens || {})) {
    const s = String(v ?? "").trim()
    if (s) slim[k] = s
  }
  if (Object.keys(slim).length) {
    try { q.set("tokens", btoa(unescape(encodeURIComponent(JSON.stringify(slim))))) } catch { /* theme only */ }
  }

  function armTimeout(p) {
    setTimeout(() => {
      const said = document.getElementById("said")
      if (!said || document.getElementById("boot-retry")) return
      said.textContent = "本机的储备服务没有在听 127.0.0.1:" + p + "。"
      const btn = document.createElement("button")
      btn.id = "boot-retry"
      btn.type = "button"
      btn.textContent = "重试"
      btn.addEventListener("click", () => location.reload())
      said.parentNode.appendChild(btn)
    }, 5000)
  }

  if (service) {
    const base = service.endsWith("/") ? service : service + "/"
    armTimeout(port)
    location.replace(base + "?" + q.toString())
    return
  }

  const target = "http://127.0.0.1:" + port + "/?" + q.toString()
  if (!isLoopback(location.hostname)) {
    showRemote(port, target)
    return
  }
  armTimeout(port)
  location.replace(target)
})()

function isLoopback(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "")
  return h === "" || h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\./.test(h)
}

function showRemote(port, target) {
  const said = document.getElementById("said")
  if (!said) return
  const host = location.hostname.replace(/^\[|\]$/g, "")
  said.textContent = ""
  const p = (text) => {
    const el = document.createElement("p")
    el.textContent = text
    said.appendChild(el)
    return el
  }
  p("储备服务只听运行 magpie 的那台机器的 127.0.0.1:" + port + "，这台电脑连不到。")
  p("在这台电脑上做好端口转发后再点继续：")
  const code = p("ssh -N -L " + port + ":127.0.0.1:" + port + " <用户名>@" + host)
  code.style.fontFamily = "ui-monospace, Menlo, Consolas, monospace"
  const go = document.createElement("button")
  go.type = "button"
  go.textContent = "继续"
  go.addEventListener("click", () => location.replace(target))
  said.appendChild(go)
}
