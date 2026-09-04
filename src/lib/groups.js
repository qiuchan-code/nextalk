/**
 * 群聊房间：2~5 个角色 + 你，待在一个群里。
 *
 * 设计参照（星野 / Character.AI 群聊）：角色不自发说话，"你点谁、谁才回"。
 * 好处：每个回合只花一次生成的钱，且方向盘一直握在用户手里。
 */

import { reactive, watch } from 'vue'
import { put, get, getAll, remove, removeMany, getByIndex, newId, STORES } from './db.js'
import { chatOnce, extractJSON } from './client.js'
import { settings, memoryModelName } from './settings.js'
import { applyMemoryUpdates } from './memory.js'

/** 新房间的空壳。charIds 由创建页选，2~5 个 */
export function emptyGroup() {
  return {
    id: newId('grp-'),
    name: '',
    desc: '', // 一句话群描述：什么场景、角色们什么关系。它决定群的气氛
    charIds: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

export function useGroups() {
  const state = reactive({
    list: [],
    loaded: false
  })

  async function reload() {
    const all = (await getAll(STORES.groups)).sort((a, b) => b.updatedAt - a.updatedAt)
    state.list = all
    state.loaded = true
  }

  watch(
    state.list,
    (list) => { localStorage.setItem('zhipianren.groups', list.length) },
    { deep: false }
  )

  async function saveGroup(g) {
    g.updatedAt = Date.now()
    await put(STORES.groups, g)
    await reload()
  }

  async function removeGroup(id) {
    await deleteGroup(id)
    await reload()
  }

  async function getGroup(id) {
    return get(STORES.groups, id)
  }

  return { state, reload, saveGroup, removeGroup, getGroup }
}

/** 删一个房间，连同它的会话和消息一起清掉 */
export async function deleteGroup(id) {
  const sessions = await getByIndex(STORES.sessions, 'groupId', id)
  const sessionIds = sessions.map((s) => s.id)
  let msgIds = []
  for (const sid of sessionIds) {
    const msgs = await getByIndex(STORES.messages, 'sessionId', sid)
    msgIds.push(...msgs.map((m) => m.id))
  }
  await remove(STORES.groups, id)
  if (sessionIds.length) await removeMany(STORES.sessions, sessionIds).catch(() => {})
  if (msgIds.length) await removeMany(STORES.messages, msgIds).catch(() => {})
}

// ————— 房间会话（复用 sessions + messages 两张表）—————

function makeGroupSession(groupId) {
  return {
    id: newId('sess-'),
    groupId,
    charId: '',
    kind: 'group',
    title: '',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    branchTailId: null,
    finished: false
  }
}

export async function listGroupSessions(groupId) {
  return (await getByIndex(STORES.sessions, 'groupId', groupId)).sort(
    (a, b) => b.lastActiveAt - a.lastActiveAt
  )
}

/** 打开最近一条群聊线；没有就开新线 */
export async function openGroupSession(groupId) {
  const sessions = await listGroupSessions(groupId)
  const existing = sessions.find((s) => !s.finished) || sessions[0]
  if (existing) return existing
  const s = makeGroupSession(groupId)
  await put(STORES.sessions, s)
  return s
}

export async function newGroupSession(groupId) {
  const s = makeGroupSession(groupId)
  await put(STORES.sessions, s)
  return s
}

/**
 * 群聊的事后提炼：把一段群聊片段交给模型，为"出场过的每个角色"分别提炼
 * 它记住的关于用户的事实/经历/态度（还是写进各自的 relationship 记忆）。
 * 给足记忆是用户的决定——贵了再说，先用最全的版本。
 */
export async function groupDistill(character, chunk, nameOf) {
  const transcript = chunk
    .filter((m) => m.text && m.text.trim())
    .map((m) => `${m.role === 'user' ? '你' : nameOf(m.charId)}：${m.text.trim()}`)
    .join('\n')
  if (!transcript) return

  const sys = '你是一个记忆整理器，负责从角色扮演对话里提炼值得长期记住的事。'
  const user = `下面是「${character.name}」在一个群聊里与用户（"你"）相处的片段。请以「${character.name}」的视角提炼：
1. 关于用户的稳定事实（profile）
2. 两人之间发生的重要事件（event）
3. 它对待用户的态度/亲密度的变化（relationship）

硬性规则：
- 只记稳定、重要的信息；寒暄、逐字对话、无关闲聊一律不记。
- importance 0~1，越重要越高；用户明确让记住的事给 1。
- 无新信息时，对应数组返回空数组。
- 只输出 JSON，不要任何多余文字或代码块。

输出字段：
- "profile_updates": [{"text":"...","importance":0.8}]
- "event_updates": [{"text":"...","importance":0.7,"valence":1}]
- "relationship": {"affinity_delta":-5,"note":"..."}（affinity_delta 是本次变化量，没有就 0）

群聊片段：
${transcript}`

  try {
    const reply = await chatOnce({
      endpoint: settings.endpoint,
      apiKey: settings.apiKey,
      model: memoryModelName(),
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user }
      ],
      temperature: 0.3
    })
    const json = extractJSON(reply)
    if (!json) return
    await applyMemoryUpdates(character.id, {
      profile: Array.isArray(json.profile_updates) ? json.profile_updates : [],
      event: Array.isArray(json.event_updates) ? json.event_updates : [],
      relationship: json.relationship || null
    })
  } catch (err) {
    console.warn('群聊记忆提炼失败', err)
  }
}
