import { reactive, watch } from 'vue'
import { put, get, getAll, remove, newId, STORES } from './db.js'

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
    await remove(STORES.characters, id)
    await reload()
  }

  async function getCharacter(id) {
    return get(STORES.characters, id)
  }

  return { state, reload, saveCharacter, removeCharacter, getCharacter }
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
