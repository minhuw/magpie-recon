// Local page service. Reads Magpie's two usage inputs without changing them;
// account selection is kept separately in this plugin's own timeline.

import { createServer } from "node:http"
import { createReadStream, readFileSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { createInterface } from "node:readline"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"

import { analyze } from "./scan.mjs"
import { readSelection, saveSelection, selectionSignature } from "./selection.mjs"

const uiRoot = fileURLToPath(new URL("../ui/", import.meta.url))
const pageHtml = readFileSync(join(uiRoot, "index.html"), "utf8")
const QUOTA_MAX = 32 * 1024 * 1024

export function resolveDir(opt) {
  const chosen = typeof opt === "string" && opt.trim() ? opt.trim() : (process.env.MAGPIE_RESERVE_DIR || "").trim()
  if (chosen) {
    if (!isAbsolute(chosen)) throw new Error("配置目录要写绝对路径")
    return chosen
  }
  const xdg = process.env.XDG_CONFIG_HOME
  if (xdg && isAbsolute(xdg)) return join(xdg, "magpie")
  return join(homedir(), ".config", "magpie")
}

export function hostAllowed(host, port) {
  const h = String(host || "").trim().toLowerCase()
  const p = String(port)
  return h === `127.0.0.1:${p}` || h === `localhost:${p}`
}

export function originAllowed(origin) {
  return origin == null || origin === "" || origin === "null"
}

export function tokenOk(header, token) {
  if (typeof header !== "string" || typeof token !== "string") return false
  const a = Buffer.from(header)
  const b = Buffer.from(token)
  if (a.length !== b.length || a.length === 0) return false
  return timingSafeEqual(a, b)
}

async function statFile(path) {
  try {
    const st = await stat(path)
    return { path, missing: false, bytes: st.size, mtime: st.mtime.toISOString(), lines: 0, bad: 0 }
  } catch (err) {
    if (err && err.code === "ENOENT") return { path, missing: true, bytes: 0, mtime: null, lines: 0, bad: 0 }
    throw err
  }
}

export async function loadDashboard(dir, now = Date.now(), options = {}) {
  const usagePath = join(dir, "usage.jsonl")
  const quotaPath = join(dir, "quota-history.json")
  const files = { dir, usage: await statFile(usagePath), quota: await statFile(quotaPath) }
  let quota = {}
  if (!files.quota.missing) {
    if (files.quota.bytes > QUOTA_MAX) throw new Error("quota-history.json 超过 32MB，没有读")
    quota = JSON.parse(await readFile(quotaPath, "utf8"))
    files.quota.accounts = quota && typeof quota === "object" && !Array.isArray(quota) ? Object.keys(quota).length : 0
  }
  async function* lines() {
    if (files.usage.missing) return
    const rl = createInterface({ input: createReadStream(usagePath), crlfDelay: Infinity })
    for await (const line of rl) {
      const s = line.replace(/^\uFEFF/, "").trim()
      if (!s) continue
      files.usage.lines++
      try {
        yield JSON.parse(s)
      } catch {
        files.usage.bad++
      }
    }
  }
  const reservePct = Number.isFinite(options.reservePct) ? Math.max(0, Math.min(100, options.reservePct)) : 3
  const selection = await readSelection(dir)
  const dash = await analyze(quota, lines(), now, { ...options, reservePct, memberships: selection.memberships })
  return { ...dash, rosterRevision: selection.revision, policy: { reservePct }, files }
}

function themeCss(query) {
  const lines = []
  const theme = query.get("theme")
  if (theme === "dark" || theme === "light") lines.push(`color-scheme: ${theme};`)
  const raw = query.get("tokens")
  if (raw) {
    try {
      const obj = JSON.parse(Buffer.from(raw, "base64").toString("utf8"))
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        for (const [k, v] of Object.entries(obj)) {
          if (!/^[a-z0-9-]{1,32}$/i.test(k)) continue
          const s = String(v ?? "").trim()
          if (!s || s.length > 80 || /[<>{};\\]/.test(s)) continue
          lines.push(`--magpie-${k}: ${s};`)
        }
      }
    } catch { /* ignore a bad token blob */ }
  }
  return lines.length ? `:root { ${lines.join(" ")} }` : ""
}

// apiCors is what a sandboxed macOS WKWebView needs to read an API
// response. The desktop page's frame has an opaque origin, so WebKit sends
// Origin: null, or sometimes no Origin, and refuses the body unless this
// answer names that origin. The failure is just "Load failed". The HTML
// itself stays without these headers, so another page cannot read the token
// out of it. A website's real origin is refused before this runs.
function apiCors() {
  return {
    "access-control-allow-origin": "null",
    "access-control-allow-headers": "x-reserve-token",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-private-network": "true",
    vary: "Origin",
  }
}

function send(res, status, type, body, cors) {
  const headers = {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...(cors ? apiCors() : {}),
  }
  res.writeHead(status, headers)
  res.end(status === 204 ? undefined : body)
}

export function createHandler({ port, token, dir }) {
  let cache = null
  const secret = token || randomBytes(32).toString("hex")
  const cleanQuery = (query) => {
    const clean = new URLSearchParams(query)
    for (const key of ["id", "included", "revision", "signature", "notice"]) clean.delete(key)
    return clean
  }
  const returnUrl = (query, notice) => {
    const clean = cleanQuery(query)
    if (notice) clean.set("notice", notice)
    const parameters = clean.toString()
    return "/" + (parameters ? "?" + parameters : "")
  }
  const redirect = (res, location) => {
    res.writeHead(303, { location, "cache-control": "no-store", "referrer-policy": "no-referrer" })
    res.end()
  }
  // Account controls use signed, revision-bound navigation intents. This
  // remains usable in Magpie's frame where fetch and forms may be blocked.
  // The MAC is only embedded in non-CORS HTML, never in /api/dashboard.
  const accountActions = (query, dashboard) => (dashboard.accountRoster || []).flatMap((account) => {
    const included = !account.included
    if (included && !account.available) return []
    const revision = dashboard.rosterRevision
    const params = cleanQuery(query)
    params.set("accounts", "open")
    params.set("id", account.id)
    params.set("included", included ? "1" : "0")
    params.set("revision", revision)
    params.set("signature", selectionSignature(secret, revision, account.id, included))
    return [{ id: account.id, included, href: "/accounts/set?" + params }]
  })
  // css and the script are in the page. A separate app.js stays cached by
  // the desktop webview and keeps sending a token this process no longer has.
  const htmlFor = (query, dashboard) => {
    const boot = JSON.stringify({ dashboard, accountActions: accountActions(query, dashboard), notice: query.get("notice") }).replace(/</g, "\\u003c")
    const css = readFileSync(join(uiRoot, "app.css"), "utf8")
    const chartJs = readFileSync(join(uiRoot, "forecast.js"), "utf8")
    const js = readFileSync(join(uiRoot, "app.js"), "utf8")
    return pageHtml
      .replace('<link rel="stylesheet" href="app.css">', `<style>${css}</style>`)
      .replace('<style id="theme"></style>', `<style id="theme">${themeCss(query)}</style>`)
      .replace('<script id="boot" type="application/json"></script>', `<script id="boot" type="application/json">${boot}</script>`)
      .replace('<script src="forecast.js"></script>', () => `<script>${chartJs}</script>`)
      .replace('<script src="app.js"></script>', () => `<script>${js}</script>`)
  }

  const dashboardFor = (reservePct) => {
    const at = Date.now()
    if (!cache || cache.reservePct !== reservePct || at - cache.at > 15000) {
      const entry = { at, reservePct, promise: null }
      entry.promise = Promise.resolve()
        .then(() => loadDashboard(resolveDir(dir), at, { reservePct }))
        .catch((err) => {
          if (cache === entry) cache = null
          throw err
        })
      cache = entry
    }
    return cache.promise
  }

  return function handler(req, res) {
    if (!hostAllowed(req.headers.host, port)) return send(res, 403, "text/plain; charset=utf-8", "forbidden")
    if (!originAllowed(req.headers.origin)) return send(res, 403, "text/plain; charset=utf-8", "forbidden")
    if (req.method === "OPTIONS") return send(res, 204, "text/plain; charset=utf-8", "", true)
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "text/plain; charset=utf-8", "method")
    let url
    try {
      url = new URL(req.url || "/", `http://127.0.0.1:${port}`)
    } catch {
      return send(res, 400, "text/plain; charset=utf-8", "bad url")
    }
    const requestedReserve = url.searchParams.get("reservePct")
    const number = requestedReserve?.trim() ? Number(requestedReserve) : NaN
    const reservePct = Number.isFinite(number) && number >= 0 && number <= 100 ? number : 3
    if (url.pathname === "/accounts/set") {
      if (req.method !== "GET") return send(res, 405, "text/plain; charset=utf-8", "method")
      const id = url.searchParams.get("id")
      const includedText = url.searchParams.get("included")
      const revisionText = url.searchParams.get("revision") || ""
      const revision = Number(revisionText)
      if (!id || !["0", "1"].includes(includedText) || !/^(0|[1-9][0-9]*)$/.test(revisionText) || !Number.isSafeInteger(revision)) return send(res, 400, "text/plain; charset=utf-8", "invalid account selection")
      const included = includedText === "1"
      if (!tokenOk(url.searchParams.get("signature"), selectionSignature(secret, revision, id, included))) return send(res, 403, "text/plain; charset=utf-8", "forbidden")
      Promise.resolve().then(async () => {
        // Recheck actual quota availability, not a potentially stale page cache.
        const current = await loadDashboard(resolveDir(dir), Date.now(), { reservePct })
        const account = current.accountRoster.find((a) => a.id === id)
        if (current.rosterRevision !== revision || !account || included && !account.available) {
          cache = null
          return redirect(res, returnUrl(url.searchParams, "selection-changed"))
        }
        await saveSelection(resolveDir(dir), { id, included, revision })
        cache = null
        redirect(res, returnUrl(url.searchParams))
      }).catch((error) => {
        cache = null
        if (error.code === "REVISION_CONFLICT") return redirect(res, returnUrl(url.searchParams, "selection-changed"))
        send(res, 500, "text/html; charset=utf-8", htmlFor(cleanQuery(url.searchParams), { error: "无法保存账号选择：" + error.message }))
      })
      return
    }
    // The numbers are in the page itself. The desktop frame can navigate
    // here, but WebKit refuses its later fetch and only says "Load failed".
    if (url.pathname === "/") {
      dashboardFor(reservePct).then(
        (body) => send(res, 200, "text/html; charset=utf-8", htmlFor(url.searchParams, body)),
        (err) => send(res, 200, "text/html; charset=utf-8", htmlFor(url.searchParams, { error: err && err.message ? err.message : String(err) })),
      )
      return
    }
    if (url.pathname === "/app.css") return send(res, 200, "text/css; charset=utf-8", readFileSync(join(uiRoot, "app.css")))
    if (url.pathname === "/app.js") return send(res, 200, "text/javascript; charset=utf-8", readFileSync(join(uiRoot, "app.js")))
    if (url.pathname !== "/api/dashboard") return send(res, 404, "text/plain; charset=utf-8", "not found")
    // Loopback and the Host check are what keep this local. A token on a
    // second request only broke the desktop page: its cached script sent
    // the previous process's token.
    dashboardFor(reservePct).then(
      (body) => send(res, 200, "application/json; charset=utf-8", JSON.stringify(body), true),
      (err) => send(res, 500, "application/json; charset=utf-8", JSON.stringify({ error: err && err.message ? err.message : String(err) }), true),
    )
    return undefined
  }
}

// startServer listens on 127.0.0.1 and resolves once it is open. A taken
// port keeps being tried; the promise stays pending until one attempt works.
export function startServer({ port, dir }) {
  const token = randomBytes(16).toString("hex")
  const handler = createHandler({ port, token, dir })
  let said = false
  let opened
  const ready = new Promise((resolve) => { opened = resolve })
  const attempt = () => {
    const srv = createServer(handler)
    srv.once("error", (err) => {
      srv.on("error", () => {})
      srv.close()
      if (!said) {
        said = true
        const why = err && (err.code || err.message) ? err.code || err.message : err
        console.error(`[magpie-recon] 127.0.0.1:${port} isn't open (${why}); still trying`)
      }
      setTimeout(attempt, 300)
    })
    srv.listen(port, "127.0.0.1", () => {
      said = false
      console.log(`[magpie-recon] http://127.0.0.1:${port}`)
      opened()
    })
  }
  attempt()
  return ready
}
