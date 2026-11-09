// Plugin-owned selection history. First observation is the earliest possible
// membership boundary; a quota window's start is not evidence of membership.
export function accountId(provider, user) {
  return String(provider).trim().toLowerCase() + "|" + String(user).trim().toLowerCase()
}

export function membershipChanges(memberships = []) {
  const result = new Map()
  for (const entry of Array.isArray(memberships) ? memberships : []) {
    const split = String(entry?.id ?? "").indexOf("|")
    if (split <= 0) continue
    const id = accountId(entry.id.slice(0, split), entry.id.slice(split + 1))
    if (id.endsWith("|")) continue
    const changes = result.get(id) || []
    for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
      const at = typeof change?.at === "number" ? change.at : Date.parse(change?.at)
      if (Number.isFinite(at) && typeof change.included === "boolean") changes.push({ at, included: change.included })
    }
    result.set(id, changes)
  }
  for (const [id, changes] of result) {
    // Last recorded decision wins when timestamps coincide.
    result.set(id, [...new Map(changes.sort((a, b) => a.at - b.at).map((c) => [c.at, c])).values()])
  }
  return result
}

export function membershipTrack(account, index, changes) {
  const firstSeenAt = account.points.reduce((first, p) => Math.min(first, p.at), Infinity)
  const id = account.id ?? String(index)
  return { id, firstSeenAt, changes: changes.get(id) || [] }
}

export function includedAt(track, at) {
  if (at < track.firstSeenAt) return false
  let included = true
  for (const change of track.changes) {
    if (change.at > at) break
    included = change.included
  }
  return included
}
