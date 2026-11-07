// Local page service. Listens on 127.0.0.1 only and reads two files in
// magpie's config directory: usage.jsonl and quota-history.json.

import { createServer } from "node:http"
import { createReadStream, readFileSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { createInterface } from "node:readline"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"

import { analyze } from "./scan.mjs"

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

export async function loadDashboard(dir, now = Date.now()) {
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
  const dash = await analyze(quota, lines(), now)
  return { ...dash, files }
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
  const htmlFor = (query) => pageHtml
    .replace('<style id="theme"></style>', `<style id="theme">${themeCss(query)}</style>`)
    .replace('<script id="boot" type="application/json"></script>', `<script id="boot" type="application/json">${JSON.stringify({ token })}</script>`)

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
    if (url.pathname === "/") return send(res, 200, "text/html; charset=utf-8", htmlFor(url.searchParams))
    if (url.pathname === "/app.css") return send(res, 200, "text/css; charset=utf-8", readFileSync(join(uiRoot, "app.css")))
    if (url.pathname === "/app.js") return send(res, 200, "text/javascript; charset=utf-8", readFileSync(join(uiRoot, "app.js")))
    if (url.pathname !== "/api/dashboard") return send(res, 404, "text/plain; charset=utf-8", "not found")
    const presented = req.headers["x-reserve-token"] || url.searchParams.get("t")
    if (!tokenOk(presented, token)) {
      return send(res, 403, "application/json; charset=utf-8", JSON.stringify({ error: "这个页面的服务不认这张请求" }), true)
    }
    const now = Date.now()
    if (!cache || now - cache.at > 15000) {
      const at = now
      const promise = Promise.resolve()
        .then(() => loadDashboard(resolveDir(dir)))
        .catch((err) => {
          if (cache && cache.at === at) cache = null
          throw err
        })
      cache = { at, promise }
    }
    cache.promise.then(
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
