// This plugin's selection timeline only; never edits Magpie account settings.
import { createHmac, randomBytes } from "node:crypto"
import { readFile, rename, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { accountId } from "./membership.mjs"

const queues = new Map()
const MAX_BYTES = 4 * 1024 * 1024
export const selectionPath = (dir) => join(dir, "reserve-membership.json")

export async function readSelection(dir) {
  let text
  try { text = await readFile(selectionPath(dir), "utf8") }
  catch (error) {
    if (error.code === "ENOENT") return { version: 1, revision: 0, memberships: [] }
    throw error
  }
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("插件账号记录超过 4MB")
  let state
  try { state = JSON.parse(text) } catch { throw new Error("插件账号记录无法解析，原文件已保留") }
  if (!state || state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.memberships)) throw new Error("插件账号记录格式无效，原文件已保留")
  const ids = new Set()
  for (const member of state.memberships) {
    const i = typeof member?.id === "string" ? member.id.indexOf("|") : -1
    if (i <= 0 || i === member.id.length - 1 || member.id !== accountId(member.id.slice(0, i), member.id.slice(i + 1)) || ids.has(member.id) || !Array.isArray(member.changes)) throw new Error("插件账号标识无效，原文件已保留")
    ids.add(member.id)
    let previous = -Infinity
    for (const change of member.changes) {
      const at = Date.parse(change?.at)
      if (!Number.isFinite(at) || at < previous || typeof change.included !== "boolean") throw new Error("插件账号变更记录无效，原文件已保留")
      previous = at
    }
  }
  return state
}

export function selectionSignature(secret, revision, id, included) {
  return createHmac("sha256", secret).update(JSON.stringify([revision, id, included])).digest("hex")
}

export async function saveSelection(dir, { id, included, revision, at = Date.now() }) {
  const path = selectionPath(dir)
  const previous = queues.get(path) || Promise.resolve()
  const work = previous.catch(() => {}).then(async () => {
    const state = await readSelection(dir)
    if (state.revision !== revision) {
      const error = new Error("账号选择已变化，请刷新后重试")
      error.code = "REVISION_CONFLICT"
      throw error
    }
    const next = { ...state, revision: state.revision + 1, memberships: state.memberships.map((m) => ({ id: m.id, changes: [...m.changes] })) }
    let member = next.memberships.find((m) => m.id === id)
    if (!member) { member = { id, changes: [] }; next.memberships.push(member) }
    member.changes.push({ at: new Date(Math.max(at, Date.parse(member.changes.at(-1)?.at) || 0)).toISOString(), included })
    // Atomic replacement; an interrupted write leaves the prior timeline intact.
    const temporary = path + "." + randomBytes(8).toString("hex") + ".tmp"
    try {
      await writeFile(temporary, JSON.stringify(next) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" })
      await rename(temporary, path)
    } finally {
      await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error })
    }
    return next
  })
  queues.set(path, work)
  try { return await work }
  finally { if (queues.get(path) === work) queues.delete(path) }
}
