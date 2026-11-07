// OpenCode v1 plugin entry. magpie treats {id, server} as one plugin and
// does not call any other export. The page is a redirect to the local
// service. magpie gives this function 20s; a taken port must not fail the
// load, so the listen keeps retrying on its own.

import { startServer } from "./lib/server.mjs"

const DEFAULT_PORT = 3478

let startedKey = ""

export default {
  id: "magpie-recon",
  server: async (_input, options) => {
    const port = Number(options?.port) > 0 ? Number(options.port) : DEFAULT_PORT
    const dir = typeof options?.dir === "string" ? options.dir.trim() : ""
    const key = `${port}\0${dir}`
    if (startedKey !== key) {
      startedKey = key
      startServer({ port, dir })
    }
    return {}
  },
}
