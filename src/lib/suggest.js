/**
 * 备用回复生成器：给"重说备选"和"灵感回复"用。
 *
 * 两种东西不是一回事：
 *   alternateReplies  —— 角色说的话的多个版本（助手角色 → 模型以角色身份答），供"重说"挑
 *   inspireReplies    —— 你接下来可能说的话（用户角色 → 模型揣摩"你"的口气），供"灵感"挑
 * 所以 prompt、角色配比、生成方式都不同。
 */

import { chatOnce, streamChat, extractJSON } from './client.js'
import { settings } from './settings.js'
import { buildSystemPrompt, traitsToSampling } from './prompt.js'

const clamp = (v, min, max) => Math.min(max, Math.max(min, v))
const REQUEST_TIMEOUT = 25000 // 单次请求 25 秒还没回就算失败，别让用户干等

/** 限制并发的小水池，避免 8 个请求同时怼上 API 被限流 */
async function runPool(tasks, limit = 3) {
  const results = new Array(tasks.length)
  let i = 0
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (i < tasks.length) {
      const idx = i++
      try {
        results[idx] = await tasks[idx]()
      } catch {
        results[idx] = null
      }
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * 生成"角色可能说的话"的多个版本。
 * history 是 {role, content} 数组（不含被替换的那条回复，也不含 system）。
 * 同一段上下文跑 count 次，每次用一点温度抖动制造差异，再去重。
 */
export async function alternateReplies(character, history, count = 3) {
  const base = traitsToSampling(character.traits)
  const maxTokens = Math.min(base.maxTokens, 420) // 备选不用太长，够挑就行
  const msgs = [{ role: 'system', content: buildSystemPrompt(character) }, ...history]

  const tasks = Array.from({ length: count }, (_, i) => {
    const jitter = ((i % 3) - 1) * 0.16 // 让每条的"胆量"略有不同
    return () => {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT)
      return chatOnce({
        endpoint: settings.endpoint,
        apiKey: settings.apiKey,
        model: settings.model,
        messages: msgs,
        temperature: clamp(base.temperature + jitter, 0.3, 1.4),
        maxTokens,
        presencePenalty: base.presencePenalty,
        signal: ctrl.signal
      }).finally(() => clearTimeout(timer))
    }
  })

  const results = await runPool(tasks, 3)
  // 去掉空的和重复的；模型偶尔会吐模板僵话，开头带星号/旁白的也滤掉
  const unique = [...new Set(results.filter(Boolean).map((s) => s.trim()).filter(Boolean))]
  const clean = unique.filter((s) => !/^\s*[※*·-]\s/.test(s) && s.length <= 800)
  return clean
}

/**
 * 生成"你接下来可以说的话"，逐字流式返回。
 * 必须流式：非流式要等模型把整段生成完才有字，屏幕干等会像挂掉。
 * 让模型"每行一句"，调用方按换行拆出来，边生成边显示。
 */
export async function* inspireRepliesStream(character, historyText, count = 3, signal) {
  const sys = '你在角色扮演里充当"接话参谋"，替用户琢磨接下来可以怎么回。'
  const user = `下面是用户和「${character.name}」的一段对话。请以"用户本人"的立场，给出 ${count} 条接下来用户可以说的话。

要求：
- 角度多样：推进剧情、表达好感、打趣、提问、吐槽、闹别扭、撒娇……
- 每句开头可带一个用（全角括号）括起来的动作或神态，表现当下的心情状态，例如（笑着说）（把杯子往前推了推）（脸微微发红）（耸耸肩）；没有合适的动作就只说话
- 每句一行，一句话不超过 30 字（括号内容不算长度），口吻自然，别像 AI 写的
- 要紧贴当下语境、顺着角色的梗走
- 直接输出这些句子，每句一行，不要编号、不要方括号、不要 JSON、不要任何额外说明

最近对话：
${historyText}`

  yield* streamChat({
    endpoint: settings.endpoint,
    apiKey: settings.apiKey,
    model: settings.model,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ],
    temperature: 0.9,
    maxTokens: 320,
    signal
  })
}
