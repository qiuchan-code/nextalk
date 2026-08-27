/**
 * 数据导出/导入（备份与恢复）
 *
 * 数据都住在浏览器 IndexedDB 里，清缓存就会没，所以给个手动备份。
 * 导出 = 把所有表序列化成一个 JSON 文件下载；导入 = 清空重建 + 按版本做最小迁移。
 *
 * 刻意不备份 API Key：它本身是明文，跟着备份文件传出去容易泄露，
 * 换设备重新填一次就好。
 */

import { getAll, putMany, clearStore, STORES } from './db.js'

const BACKUP_VERSION = 1
const STORE_ORDER = ['characters', 'sessions', 'messages', 'memories', 'events']

export async function exportAll() {
  const data = {}
  for (const name of STORE_ORDER) data[name] = await getAll(STORES[name])
  const blob = new Blob([JSON.stringify({ app: 'zhipianren', version: BACKUP_VERSION, at: Date.now(), data })], {
    type: 'application/json'
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const d = new Date()
  const stamp = `${d.getFullYear()}${d.getMonth() + 1}${d.getDate()}-${d.getHours()}${d.getMinutes()}`
  a.href = url
  a.download = `纸片人备份-${stamp}.json`
  a.click()
  URL.revokeObjectURL(url)
  return { characters: data.characters.length, messages: data.messages.length }
}

export async function importAll(file) {
  const text = await file.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('这个文件不是有效 JSON')
  }
  const data = parsed?.data
  if (!data || parsed.app !== 'zhipianren') {
    throw new Error('这不是一个"纸片人"备份文件')
  }

  // 从旧版本迁移（现在只有 v1，预留扩展位）
  const version = parsed.version || 1

  for (const name of STORE_ORDER) {
    await clearStore(STORES[name])
    const rows = data[name] || []
    if (rows.length) await putMany(STORES[name], rows)
  }

  return { characters: (data.characters || []).length }
}
