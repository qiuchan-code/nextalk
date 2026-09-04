/**
 * 长期记忆引擎
 *
 * 核心目标：让角色"记得用户"。跨会话生效——下次开聊，它记得你是谁、记得你们聊过什么。
 *
 * 三层记忆（按角色隔离，存 IndexedDB）：
 *   profile       关于用户的稳定事实（在民航大学读电子信息、讨厌被叫全名…）
 *   event         两人之间发生过的事（上周高数考砸了、去看了场电影…）
 *   relationship  角色对用户的态度 + 亲密度数值 0~100
 *
 * 为什么不做向量库/embedding：个人自用场景，量少，一条 prompt 顶多几十条记忆，
 * 用简单的"重要性 × 时间衰减"打分排序就够，犯不上为它搭一套检索服务。
 */

import { getByIndex, put, newId, remove, STORES } from './db.js'
import { chatOnce, extractJSON } from './client.js'
import { settings, memoryModelName } from './settings.js'

const BASE_AFFINITY = 50
// 各层上限（计划里定的）
const CAPS = { profile: 20, event: 30 }

// ---------- 读取 ----------

export async function loadMemories(charId) {
  return (await getByIndex(STORES.memories, 'charId', charId)) || []
}

/**
 * 打分：importance × 时间衰减 × 强化。数值越高越该被注入 prompt。
 * 刚强化过的、重要的记忆排前面；久没被提起的旧记忆逐渐降权（但不会消失）。
 */
export function decayScore(mem, now = Date.now()) {
  const days = (now - (mem.lastReinforcedAt || mem.createdAt || now)) / 86400000
  const decay = Math.exp(-0.05 * days) // 接近 1 个月后衰减到约 2 成
  return (mem.importance ?? 0.5) * decay
}

/** 排序并截取进 prompt 的记忆：profile 前 8、event 前 6，relationship 单独一条 */
export function selectForPrompt(memories, { topProfile = 8, topEvent = 6 } = {}) {
  const now = Date.now()
  const score = (m) => decayScore(m, now)
  const profiles = memories
    .filter((m) => m.layer === 'profile')
    .sort((a, b) => score(b) - score(a))
    .slice(0, topProfile)
  const events = memories
    .filter((m) => m.layer === 'event')
    .sort((a, b) => score(b) - score(a))
    .slice(0, topEvent)
  const relationship = memories.find((m) => m.layer === 'relationship')
  return { profiles, events, relationship }
}

// ---------- 提炼 ----------

/** 提炼一段正在进行的对话，返回 {updates, scene}（不落库） */
export async function distill(character, messages) {
  const transcript = messages
    .filter((m) => m.text && m.text.trim())
    .map((m) => `${m.role === 'user' ? '用户' : character.name}：${m.text.trim()}`)
    .join('\n')

  const sys = '你是一个记忆整理器，负责从角色扮演对话里提炼值得长期记住的事。'
  const user = `下面是「${character.name}」与用户的对话。请提炼：
1. 关于用户的稳定事实（profile）
2. 两人之间发生的重要事件（event）
3. 角色对用户态度/亲密度的变化（relationship），以及一段给用户看的一两句话剧情小结（scene）

硬性规则：
- 只记稳定、重要的信息；寒暄、逐字对话、无关闲聊一律不记。
- importance 0~1，越重要越高；用户明确让记住的事给 1。
- 无新信息时，对应数组返回空数组。
- 只输出 JSON，不要任何多余文字或代码块。

输出字段：
- "profile_updates": [{"text":"...","importance":0.8}]
- "event_updates": [{"text":"...","importance":0.7,"valence":1}]
- "relationship": {"affinity_delta":-5,"note":"..."}（affinity_delta 是本次变化量，没有就 0）
- "scene": "一两句话的剧情小结"

对话：
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
    if (!json) return null
    return {
      updates: {
        profile: Array.isArray(json.profile_updates) ? json.profile_updates : [],
        event: Array.isArray(json.event_updates) ? json.event_updates : [],
        relationship: json.relationship || null
      },
      scene: json.scene ? String(json.scene).slice(0, 200) : ''
    }
  } catch (err) {
    // 提炼失败就静默跳过，下次再补，不影响聊天
    console.warn('记忆提炼失败', err)
    return null
  }
}

// ---------- 亲密度 ----------

/** 读当前亲密度（0~100）。还没有 relationship 记忆时返回 null */
export async function getAffinity(charId) {
  const all = await loadMemories(charId)
  const rel = all.find((m) => m.layer === 'relationship')
  return rel ? Math.round(rel.affinity ?? BASE_AFFINITY) : null
}

/**
 * 手动设置亲密度：捏角色时的"初始值"和之后想掰回来都用它。
 * 没有 relationship 记忆就先建一条（没提炼过的角色也可以设置初始亲密度）。
 */
export async function setAffinity(charId, value) {
  const v = Math.max(0, Math.min(100, Math.round(Number(value) || 0)))
  const all = await loadMemories(charId)
  let rel = all.find((m) => m.layer === 'relationship')
  if (!rel) {
    rel = {
      id: newId('mem-'),
      charId,
      layer: 'relationship',
      text: '',
      importance: 0.8,
      createdAt: Date.now(),
      lastReinforcedAt: Date.now(),
      affinity: v
    }
  } else {
    rel.affinity = v
    rel.lastReinforcedAt = Date.now()
  }
  await put(STORES.memories, rel)
}

// ---------- 落库 ----------

async function upsertMemory(charId, layer, { text, importance = 0.5, valence }) {
  if (!text) return
  const all = await loadMemories(charId)
  const existing = all.find((m) => m.layer === layer && m.text === text)
  if (existing) {
    existing.importance = Math.max(existing.importance ?? 0, importance)
    existing.lastReinforcedAt = Date.now()
    await put(STORES.memories, existing)
    return
  }
  const mem = {
    id: newId('mem-'),
    charId,
    layer,
    text,
    importance,
    valence: typeof valence === 'number' ? valence : 0,
    createdAt: Date.now(),
    lastReinforcedAt: Date.now()
  }
  await put(STORES.memories, mem)
}

/** 把提炼结果写进库，含亲密度累积和超上限合并 */
export async function applyMemoryUpdates(charId, updates) {
  if (!updates) return
  for (const it of updates.profile || []) await upsertMemory(charId, 'profile', it)
  for (const it of updates.event || []) await upsertMemory(charId, 'event', it)

  if (updates.relationship) {
    const all = await loadMemories(charId)
    let rel = all.find((m) => m.layer === 'relationship')
    if (!rel) {
      rel = {
        id: newId('mem-'),
        charId,
        layer: 'relationship',
        text: updates.relationship.note || '',
        importance: 0.8,
        createdAt: Date.now(),
        lastReinforcedAt: Date.now(),
        affinity: BASE_AFFINITY
      }
    } else {
      rel.affinity = (rel.affinity ?? BASE_AFFINITY) + (updates.relationship.affinity_delta || 0)
      rel.affinity = Math.max(0, Math.min(100, Math.round(rel.affinity)))
      if (updates.relationship.note) rel.text = updates.relationship.note
      rel.lastReinforcedAt = Date.now()
    }
    await put(STORES.memories, rel)
  }

  await capAndTrim(charId)
}

/** 超上限时，把"最不重要的一批"喂给模型合并成一条更概括的旧记忆。淘汰但不丢。 */
async function capAndTrim(charId, layer = 'event') {
  const all = await loadMemories(charId)
  const list = all.filter((m) => m.layer === layer)
  const cap = CAPS[layer] || 30
  if (list.length <= cap) return

  // 按得分从小到大排，取最冷的一批
  const sorted = list.sort((a, b) => decayScore(a) - decayScore(b))
  const trim = sorted.slice(0, list.length - cap)

  // 把它们合并成一条概括（profile 层就简单删掉最冷的一条）
  if (layer === 'event' && trim.length > 1) {
    const texts = trim.map((m) => m.text)
    const mergedInfo = await summarizeTexts(texts)
    if (mergedInfo) {
      const keptText = trim[0].text
      const keepId = trim[0].id
      await remove(STORES.memories, keepId)
      await upsertMemory(charId, 'event', {
        text: mergedInfo,
        importance: 0.5 // 概括性的旧记忆，不受过高评分
      })
      // 其余的被合并掉的删除
      for (const m of trim.slice(1)) await remove(STORES.memories, m.id)
      return
    }
  }
  for (const m of trim) await remove(STORES.memories, m.id)
}

async function summarizeTexts(texts) {
  try {
    const reply = await chatOnce({
      endpoint: settings.endpoint,
      apiKey: settings.apiKey,
      model: memoryModelName(),
      messages: [
        {
          role: 'user',
          content:
            '把下面几条关于同一段关系的旧记忆，合并压缩成一句更概括的话，保留重要事实。只输出这一句话：\n' +
            texts.join('\n')
        }
      ],
      temperature: 0.3
    })
    return reply.trim().slice(0, 200) || null
  } catch {
    return null
  }
}

// ---------- 事件簿 ----------

export async function saveEventEntry(sessionId, { title, text }) {
  if (!text && !title) return
  const entry = {
    id: newId('ev-'),
    sessionId,
    kind: 'scene',
    title: title || '一段回忆',
    text,
    createdAt: Date.now()
  }
  await put(STORES.events, entry)
  return entry
}

export async function loadEvents(sessionId) {
  const list = await getByIndex(STORES.events, 'sessionId', sessionId)
  return list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
}

/** 提炼后把剧情小结记进事件簿 */
export function recordScene(sessionId, sceneText) {
  if (sceneText) return saveEventEntry(sessionId, { title: '小结', text: sceneText })
  return Promise.resolve()
}
