import { put, get, getAll, getByIndex, newId, STORES } from './db.js'

/** 常驻的会话状态。每次只开一个会话（Phase 1 够用，Phase 2 再加会话列表）。 */

let active = null

export function activeSession() {
  return active
}

/** 打开某个角色的"最近一个会话"，没有就新建一个 */
export async function openSession(characterId) {
  const sessions = (await getByIndex(STORES.sessions, 'charId', characterId)).sort(
    (a, b) => b.lastActiveAt - a.lastActiveAt
  )
  const existing = sessions.find((s) => !s.finished) || sessions[0]
  if (existing) {
    active = existing
    return existing
  }

  const s = {
    id: newId('sess-'),
    characterId,
    charId: characterId,
    title: '',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    branchTailId: null, // 当前分支的"尾部消息"id（Phase 2 回溯用）
    finished: false
  }
  await put(STORES.sessions, s)
  active = s
  return s
}

/** 把某条消息设为会话的"当前尾部"，回溯时用来标记分支点 */
export async function setTail(sid, messageId) {
  active = await get(STORES.sessions, sid)
  if (active) {
    active.branchTailId = messageId
    active.lastActiveAt = Date.now()
    await put(STORES.sessions, active)
  }
  return active
}

export function touchSession(sid) {
  if (active && active.id === sid) {
    active.lastActiveAt = Date.now()
    put(STORES.sessions, active)
  }
}

/** 这个角色的常用记忆入口，Phase 3 会用到 */
export async function loadMessages(sessionId) {
  const list = await getByIndex(STORES.messages, 'sessionId', sessionId)
  return list.sort((a, b) => seqOf(a) - seqOf(b))
}

/** 从消息 id 提取递增序号（newId 生成，时间戳在前） */
function seqOf(msg) {
  const t = msg?.createdAt || 0
  return t
}

export function saveMessage(msg) {
  touchSession(msg.sessionId)
  return put(STORES.messages, msg)
}
