// OpenCode v1 plugin entry. magpie treats {id, server} as one plugin and
// does not call any other export. The desktop page navigates this frame to
// the local service, so the port has to be open before magpie shows the
// page. A taken port must not use up magpie's 20s load limit.

import { startServer } from "./lib/server.mjs"

const DEFAULT_PORT = 3478

let pending = null
let pendingKey = ""

export default {
  id: "magpie-recon",
  server: async (_input, options) => {
    const port = Number(options?.port) > 0 ? Number(options.port) : DEFAULT_PORT
    const dir = typeof options?.dir === "string" ? options.dir.trim() : ""
    const key = `${port}\0${dir}`
    if (!pending || pendingKey !== key) {
      pendingKey = key
      pending = startServer({ port, dir })
    }
    await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 3000))])
    return {}
  },
}
