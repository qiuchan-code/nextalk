import { reactive, watch } from 'vue'
import { put, get, getAll, remove, removeMany, getByIndex, newId, STORES } from './db.js'

/**
 * 角色仓库。角色是独立于会话的"永久资产"，改动一个角色，
 * 它所有会话都会跟着用新的人设说话。这符合直觉：改的是"这个人"，不是"这次聊天"。
 */

// 捏角色的初始值。第一次用能直接改，不用先面对一堆空输入框。
export function emptyCharacter() {
  return {
    id: newId('char-'),
    name: '',
    avatar: '', // 压缩后的 dataURL（≤512px JPEG）
    backstory: '',
    greeting: '',
    styleLines: [],
    traits: { rational: 0.5, humor: 0.5, empathy: 0.6, proactive: 0.5 },
    affinity: 50, // 初始亲密度：真正生效在保存时写入 relationship 记忆
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

export function useCharacters() {
  const state = reactive({
    list: [],
    loaded: false
  })

  async function reload() {
    const all = (await getAll(STORES.characters)).sort((a, b) => b.updatedAt - a.updatedAt)
    state.list = all
    state.loaded = true
  }

  watch(
    state.list,
    (list) => { localStorage.setItem('zhipianren.characters', list.length) },
    { deep: false }
  )

  async function saveCharacter(char) {
    char.updatedAt = Date.now()
    await put(STORES.characters, char)
    await reload()
  }

  async function removeCharacter(id) {
    await deleteCharacter(id)
    await reload()
  }

  async function getCharacter(id) {
    return get(STORES.characters, id)
  }

  return { state, reload, saveCharacter, removeCharacter, getCharacter }
}

/** 删一个角色，同时清掉它名下的会话、消息、记忆、事件，免得留孤儿数据 */
export async function deleteCharacter(id) {
  const sessions = await getByIndex(STORES.sessions, 'charId', id)
  const sessionIds = sessions.map((s) => s.id)

  // 该角色全部会话的消息
  const msgIds = []
  for (const sid of sessionIds) {
    const msgs = await getByIndex(STORES.messages, 'sessionId', sid)
    msgIds.push(...msgs.map((m) => m.id))
  }
  // 该角色全部会话的事件，和它自己的记忆
  const evIds = []
  for (const sid of sessionIds) {
    const evs = await getByIndex(STORES.events, 'sessionId', sid)
    evIds.push(...evs.map((e) => e.id))
  }
  const mems = await getByIndex(STORES.memories, 'charId', id)
  const memIds = mems.map((m) => m.id)

  await remove(STORES.characters, id)
  if (sessionIds.length) await removeMany(STORES.sessions, sessionIds).catch(() => {})
  if (msgIds.length) await removeMany(STORES.messages, msgIds).catch(() => {})
  if (evIds.length) await removeMany(STORES.events, evIds).catch(() => {})
  if (memIds.length) await removeMany(STORES.memories, memIds).catch(() => {})
}

/** 把上传的图片压缩成小尺寸 base64，避免一张头像撑爆 IndexedDB */
export function compressAvatar(file, maxW = 512, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, maxW / img.width)
      const w = Math.round(img.width * scale)
      const h = Math.round(img.height * scale)
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0, w, h)
      URL.revokeObjectURL(url)
      // 压缩时带一点白边，更像拍立得
      resolve(canvas.toDataURL('image/jpeg', quality))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('这图片打不开'))
    }
    img.src = url
  })
}
