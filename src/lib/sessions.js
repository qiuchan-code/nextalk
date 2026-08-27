import { put, get, getAll, getByIndex, remove, removeMany, newId, STORES } from './db.js'

/** 常驻的会话状态。一次只展开一个会话，但一个角色可以有好几条对话线。 */

let active = null

export function activeSession() {
  return active
}

function makeSession(characterId) {
  return {
    id: newId('sess-'),
    characterId,
    charId: characterId,
    title: '',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    branchTailId: null, // 当前分支的"尾部消息"id（重说/回溯指针）
    finished: false
  }
}

/** 某个角色的全部会话（按最近活跃排序），给会话切换器用 */
export async function listSessions(characterId) {
  return (await getByIndex(STORES.sessions, 'charId', characterId)).sort(
    (a, b) => b.lastActiveAt - a.lastActiveAt
  )
}

/** 打开最近的未完结会话；没有就新建 */
export async function openSession(characterId) {
  const sessions = await listSessions(characterId)
  const existing = sessions.find((s) => !s.finished) || sessions[0]
  if (existing) {
    active = existing
    return existing
  }
  const s = makeSession(characterId)
  await put(STORES.sessions, s)
  active = s
  return s
}

/** 无论有没有旧会话，都开一条全新对话线 */
export async function newSession(characterId) {
  const s = makeSession(characterId)
  await put(STORES.sessions, s)
  active = s
  return s
}

export async function getSession(sid) {
  return get(STORES.sessions, sid)
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
  // 用 seq 排序而不是 createdAt：同一毫秒里连发的几条时间戳会撞，顺序就乱了
  return list.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
}

// 消息序号。每个会话内部自增，跨会话无所谓（排序只在单会话内比）。
// 计数器放模块级，同一会话内先后创建的消息序号必然递增。
let seqCounter = 0
export function nextSeq() {
  return seqCounter++
}

export function saveMessage(msg) {
  touchSession(msg.sessionId)
  return put(STORES.messages, msg)
}

/** 把某条消息（含）之后的消息全部删掉，用于重说/回溯。返回删掉了几条 */
export async function removeMessagesFrom(messageId) {
  const msg = await get(STORES.messages, messageId)
  if (!msg) return 0
  const all = await getByIndex(STORES.messages, 'sessionId', msg.sessionId)
  const cut = all.filter((m) => m.createdAt >= msg.createdAt || m.id === messageId)
  const ids = cut.map((m) => m.id)
  await removeMany(STORES.messages, ids)
  return ids.length
}
