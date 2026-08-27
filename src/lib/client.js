/**
 * OpenAI 兼容接口客户端
 *
 * 为什么不用 EventSource：它只支持 GET，没法带 Authorization 头和 POST body。
 * 所以必须自己用 fetch + ReadableStream 手动解析 SSE。
 *
 * 最大的坑在 parseSSE：网络传过来的 chunk 是按字节切的，一条 JSON 可能被从
 * 中间劈成两半（前一半在这个 chunk 结尾，后一半在下个 chunk 开头）。所以要用
 * buffer 攒着，只处理"完整到有换行符"的行，剩下的半截留给下一轮。
 */

/** 把 HTTP 错误翻译成人话 */
async function describeError(res) {
  let detail = ''
  try {
    const text = await res.text()
    try {
      const json = JSON.parse(text)
      detail = json?.error?.message || json?.message || json?.base_resp?.status_msg || text
    } catch {
      detail = text
    }
  } catch {
    /* 读不出来就算了 */
  }
  detail = String(detail || '').slice(0, 300)

  const hints = {
    400: '请求格式不对，多半是模型名写错了',
    401: 'API Key 不对、过期了，或者没填',
    402: '账户余额不足，去充点钱',
    403: '没有权限，可能是这个 Key 用不了这个模型',
    404: '接口地址不对（检查 baseURL 结尾是不是漏了 /chat/completions），或者模型名不存在',
    429: '请求太频繁 / 超出配额了，等一会儿再试',
    500: '模型服务端出错了，不是你的锅',
    502: '网关错误，稍后重试',
    503: '模型服务繁忙，稍后重试'
  }
  const hint = hints[res.status] || '请求失败'
  return `${hint}（HTTP ${res.status}）${detail ? '\n' + detail : ''}`
}

/** fetch 层面的错误（断网、跨域被拦、超时）也翻译成人话 */
function describeNetworkError(err) {
  if (err?.name === 'AbortError') return null // 用户主动停止，不算错误
  const msg = String(err?.message || err)
  if (/Failed to fetch|NetworkError|load failed/i.test(msg)) {
    return (
      '连不上模型服务。可能原因：\n' +
      '1. 网络断了或者被墙\n' +
      '2. 接口地址写错了\n' +
      '3. 这家服务商不允许网页直连（比如 Kimi/Moonshot 就不行）'
    )
  }
  return msg
}

const commonHeaders = (apiKey) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${apiKey}`
})

/**
 * 流式对话。用法：
 *   for await (const piece of streamChat({...})) { text += piece }
 */
export async function* streamChat({
  endpoint,
  apiKey,
  model,
  messages,
  temperature = 0.8,
  maxTokens = 1024,
  presencePenalty = 0,
  signal
}) {
  let res
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: commonHeaders(apiKey),
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        temperature,
        max_tokens: maxTokens,
        presence_penalty: presencePenalty
      }),
      signal
    })
  } catch (err) {
    const msg = describeNetworkError(err)
    if (msg === null) return
    throw new Error(msg)
  }

  if (!res.ok) throw new Error(await describeError(res))
  if (!res.body) throw new Error('服务端没有返回数据流')

  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      // stream: true —— 告诉 decoder 后面还有数据，别把半个汉字当成乱码
      buffer += decoder.decode(value, { stream: true })

      // 只处理完整的行，最后一段（可能是半条 JSON）留在 buffer 里
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line) continue
        if (line.startsWith(':')) continue // SSE 心跳注释
        if (!line.startsWith('data:')) continue

        const data = line.slice(5).trim()
        if (data === '[DONE]') return

        let json
        try {
          json = JSON.parse(data)
        } catch {
          continue // 不完整或非 JSON，跳过
        }

        // 有些服务商把错误塞在流里返回
        if (json.error) {
          throw new Error(json.error.message || JSON.stringify(json.error))
        }

        const delta = json.choices?.[0]?.delta
        if (!delta) continue

        // DeepSeek-R1 之类推理模型会先吐思维链，这里只取正文
        const piece = delta.content
        if (piece) yield piece
      }
    }
  } catch (err) {
    const msg = describeNetworkError(err)
    if (msg === null) return
    throw err instanceof Error ? err : new Error(msg)
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 非流式的单次调用。给后台任务用（记忆提炼、事件簿摘要），
 * 这些不需要打字机效果，等结果一次拿回来更简单。
 */
export async function chatOnce({
  endpoint,
  apiKey,
  model,
  messages,
  temperature = 0.3,
  maxTokens = 1024,
  signal
}) {
  let res
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: commonHeaders(apiKey),
      body: JSON.stringify({ model, messages, stream: false, temperature, max_tokens: maxTokens }),
      signal
    })
  } catch (err) {
    const msg = describeNetworkError(err)
    if (msg === null) return ''
    throw new Error(msg)
  }
  if (!res.ok) throw new Error(await describeError(res))
  const json = await res.json()
  return json.choices?.[0]?.message?.content ?? ''
}

/**
 * 从模型回复里抠出 JSON。
 * 模型经常不听话，会写成 ```json ... ``` 或者前后加一堆废话，这里都兼容掉。
 */
export function extractJSON(text) {
  if (!text) return null
  let s = String(text).trim()

  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()

  try {
    return JSON.parse(s)
  } catch {
    /* 继续尝试 */
  }

  // 退而求其次：截取第一个 { 到最后一个 }
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1))
    } catch {
      return null
    }
  }
  return null
}
