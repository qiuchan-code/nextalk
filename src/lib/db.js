/**
 * IndexedDB 封装
 *
 * 为什么不用 localStorage：头像 base64 一张就可能几百 KB，聊天记录只增不减，
 * 而 localStorage 上限 5MB 且读写是同步的——手机上会直接卡住主线程。
 * IndexedDB 异步、容量按硬盘算，才是存这些东西的正经地方。
 *
 * 这里不引任何库，就是把回调式的 IDB API 包成 Promise，约 100 行，每行你都能看懂。
 */

const DB_NAME = 'zhipianren'
const DB_VERSION = 3

export const STORES = {
  characters: 'characters',
  sessions: 'sessions',
  messages: 'messages',
  memories: 'memories',
  events: 'events',
  groups: 'groups'
}

let dbPromise = null

function openDB() {
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)

    // 只在数据库第一次创建、或者版本号提高时触发，用来建表和索引。
    // 每个 store 都写成"不存在才建"，这样旧版本升级时能补上缺失的表。
    req.onupgradeneeded = (e) => {
      const db = e.target.result
      // 升级期间只有 e.target.transaction 这个"升级事务"可用：
      // 再开新事务（db.transaction(...)）会抛 InvalidStateError，整个升级失败。
      // 教训：v3 加 groupId 索引这么写，导致老用户升级后永远"翻开中"。
      const upgradeTx = e.target.transaction

      if (!db.objectStoreNames.contains(STORES.characters)) {
        db.createObjectStore(STORES.characters, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORES.sessions)) {
        const s = db.createObjectStore(STORES.sessions, { keyPath: 'id' })
        s.createIndex('charId', 'charId')
      }
      if (!db.objectStoreNames.contains(STORES.messages)) {
        const s = db.createObjectStore(STORES.messages, { keyPath: 'id' })
        s.createIndex('sessionId', 'sessionId')
      }
      if (!db.objectStoreNames.contains(STORES.memories)) {
        const s = db.createObjectStore(STORES.memories, { keyPath: 'id' })
        s.createIndex('charId', 'charId')
      }
      if (!db.objectStoreNames.contains(STORES.events)) {
        const s = db.createObjectStore(STORES.events, { keyPath: 'id' })
        s.createIndex('sessionId', 'sessionId')
      }
      if (!db.objectStoreNames.contains(STORES.groups)) {
        const s = db.createObjectStore(STORES.groups, { keyPath: 'id' })
        s.createIndex('charIds', 'charIds', { multiEntry: true })
      }
      // v3：群聊的会话也要能被"按房间"找到，老库的 sessions 补一个 groupId 索引
      if (db.objectStoreNames.contains(STORES.sessions)) {
        const s = upgradeTx.objectStore(STORES.sessions)
        if (!s.indexNames.contains('groupId')) s.createIndex('groupId', 'groupId')
      }
    }

    req.onsuccess = () => resolve(req.result)
    req.onerror = () => {
      // 打开失败时清掉缓存，下次调用还能重试；否则一次失败会把整个页面焊死
      dbPromise = null
      reject(req.error)
    }
  })

  return dbPromise
}

/** 把一次事务包成 Promise */
async function tx(storeName, mode, run) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode)
    const store = t.objectStore(storeName)
    let result
    try {
      result = run(store)
    } catch (err) {
      reject(err)
      return
    }
    t.oncomplete = () => resolve(result?.result ?? result)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  })
}

export async function put(storeName, obj) {
  await tx(storeName, 'readwrite', (s) => s.put(JSON.parse(JSON.stringify(obj))))
  return obj
}

export async function putMany(storeName, list) {
  await tx(storeName, 'readwrite', (s) => {
    for (const obj of list) s.put(JSON.parse(JSON.stringify(obj)))
  })
  return list
}

export async function get(storeName, id) {
  return tx(storeName, 'readonly', (s) => s.get(id))
}

export async function getAll(storeName) {
  return (await tx(storeName, 'readonly', (s) => s.getAll())) || []
}

export async function remove(storeName, id) {
  return tx(storeName, 'readwrite', (s) => s.delete(id))
}

export async function removeMany(storeName, ids) {
  return tx(storeName, 'readwrite', (s) => {
    for (const id of ids) s.delete(id)
  })
}

/** 按索引查，比如查某个会话下的全部消息 */
export async function getByIndex(storeName, indexName, value) {
  return (
    (await tx(storeName, 'readonly', (s) => s.index(indexName).getAll(value))) || []
  )
}

export async function clearStore(storeName) {
  return tx(storeName, 'readwrite', (s) => s.clear())
}

/** 生成一个够用的唯一 id（时间戳 + 随机后缀，天然按时间有序） */
export function newId(prefix = '') {
  return (
    prefix +
    Date.now().toString(36) +
    '-' +
    Math.random().toString(36).slice(2, 8)
  )
}
