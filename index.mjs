// OpenCode v1 plugin entry. magpie treats {id, server} as one plugin and
// does not call any other export. The function only waits until the local
// page service is listening; the page itself is a redirect to that service.

import { startServer } from "./lib/server.mjs"

const DEFAULT_PORT = 3478

let pending = null
let pendingKey = ""

export default {
  id: "magpie-reserve",
  server: async (_input, options) => {
    const port = Number(options?.port) > 0 ? Number(options.port) : DEFAULT_PORT
    const dir = typeof options?.dir === "string" ? options.dir.trim() : ""
    const key = `${port}\0${dir}`
    if (!pending || pendingKey !== key) {
      pendingKey = key
      pending = startServer({ port, dir })
    }
    await pending
    return {}
  },
}
