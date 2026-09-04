/**
 * 角色 → system prompt + 采样参数
 *
 * 这里是"性格滑块到底有没有用"的关键。很多同类应用把滑块只写进 prompt 文字里，
 * 模型经常无视，滑了半天没变化，那就是摆设。
 *
 * 所以这里做两件事：
 *   1. 每个维度按档位翻译成明确的行为指令（不是"幽默度 0.8"这种模型看不懂的数字）
 *   2. 同时映射到采样参数（temperature / presence_penalty / 回复长度）
 * 两条腿一起走，拖滑块才能肉眼看出区别。
 */

export const TRAIT_META = [
  {
    key: 'rational',
    name: '理性',
    low: '感性',
    high: '理性',
    hint: '低=跟着感觉走，高=讲逻辑摆道理'
  },
  {
    key: 'humor',
    name: '幽默',
    low: '严肃',
    high: '爱开玩笑',
    hint: '低=正经八百，高=贫嘴、爱接梗'
  },
  {
    key: 'empathy',
    name: '共情',
    low: '冷淡',
    high: '体贴',
    hint: '低=就事论事，高=先照顾情绪'
  },
  {
    key: 'proactive',
    name: '主动',
    low: '被动',
    high: '话痨',
    hint: '低=你问才答，高=主动找话题、追问'
  }
]

export const DEFAULT_TRAITS = {
  rational: 0.5,
  humor: 0.5,
  empathy: 0.6,
  proactive: 0.5
}

/** 把 0~1 分成三档，避免中间值写出模棱两可的指令 */
function tier(v) {
  if (v <= 0.33) return 'low'
  if (v >= 0.67) return 'high'
  return 'mid'
}

const TRAIT_LINES = {
  rational: {
    low: '你更信直觉和感受，说话跳跃、凭印象下判断，不爱讲道理。',
    mid: '你会讲道理，但不会把话说得像分析报告。',
    high: '你习惯把事情理清楚再说，讲因果、讲条件，必要时会直接指出对方哪里想岔了。'
  },
  humor: {
    low: '你说话认真、不开玩笑，也很少用网络梗。',
    mid: '你偶尔会开个小玩笑，但不刻意逗人。',
    high: '你爱贫嘴、爱接梗，能把普通的话讲得有意思，但别硬凑段子。'
  },
  empathy: {
    low: '你不太主动照顾对方情绪，有话直说，甚至有点不近人情。',
    mid: '对方情绪明显不对时你会关心一下，但不会一直哄。',
    high: '你先接住对方的情绪再谈事情，会注意到 ta 没说出口的部分。'
  },
  proactive: {
    low: '你不主动挑起话题，对方问什么你答什么，话不多。',
    mid: '聊到自然的地方你会顺势接话，偶尔反问。',
    high: '你会主动找话题、追问细节、分享自己的事，绝不让对话冷场。'
  }
}

/** 性格 → 给模型的行为指令 */
export function traitsToInstructions(traits = DEFAULT_TRAITS) {
  return TRAIT_META.map((t) => TRAIT_LINES[t.key][tier(traits[t.key] ?? 0.5)])
    .map((line) => '- ' + line)
    .join('\n')
}

const clamp = (v, min, max) => Math.min(max, Math.max(min, v))

/** 亲密度 0~100 → 关系档位。prompt、界面显示共用这一套档位 */
export function affinityLevel(v) {
  const n = Number(v) || 0
  return n >= 75 ? '很亲近' : n >= 45 ? '还算熟' : n >= 20 ? '刚认识不久' : '还很生疏'
}

/**
 * 性格 → 采样参数。
 * 幽默和主动让它更放得开（温度高），理性把它往回拉（温度低）。
 */
export function traitsToSampling(traits = DEFAULT_TRAITS, baseMaxTokens = 1024) {
  const { humor = 0.5, proactive = 0.5, rational = 0.5 } = traits
  return {
    temperature: Number(clamp(0.55 + 0.35 * humor + 0.2 * proactive - 0.25 * rational, 0.35, 1.25).toFixed(2)),
    // 主动的角色话多且爱换话题，给点存在惩罚免得来回车轱辘话
    presencePenalty: Number((0.1 + 0.5 * proactive).toFixed(2)),
    // 话痨给更多字数空间，闷葫芦给少点
    maxTokens: Math.round(baseMaxTokens * (0.7 + 0.6 * proactive))
  }
}

/**
 * 拼出完整的 system prompt。
 * memories / events 是 Phase 3 才会传进来的，现在留好位置。
 */
export function buildSystemPrompt(character, { memories = [], events = [], userName = '' } = {}) {
  const parts = []

  parts.push(
    `你现在要扮演一个叫「${character.name}」的人，和用户对话。` +
      `从现在开始你就是 ${character.name}，不是 AI 助手。`
  )

  if (character.backstory?.trim()) {
    parts.push(`【你是谁】\n${character.backstory.trim()}`)
  }

  parts.push(`【你的性格】\n${traitsToInstructions(character.traits)}`)

  const styleLines = (character.styleLines || []).filter((s) => s && s.trim())
  if (styleLines.length) {
    parts.push(
      `【你的说话方式】\n下面是你平时说话的例子，模仿这个语气和用词习惯：\n` +
        styleLines.map((s) => `「${s.trim()}」`).join('\n')
    )
  }

  // ——— 记忆注入位（Phase 3）———
  const profiles = memories.filter((m) => m.layer === 'profile')
  const pastEvents = memories.filter((m) => m.layer === 'event')
  const rel = memories.find((m) => m.layer === 'relationship')

  if (profiles.length) {
    parts.push(
      `【关于 ta，你记得】\n` + profiles.map((m) => '- ' + m.text).join('\n')
    )
  }
  if (pastEvents.length) {
    parts.push(`【你们之间发生过的事】\n` + pastEvents.map((m) => '- ' + m.text).join('\n'))
  }
  if (rel) {
    const level = affinityLevel(rel.affinity)
    parts.push(
      `【你对 ta 的感觉】\n目前你们${level}（亲密度 ${Math.round(rel.affinity ?? 0)}/100）。${rel.text || ''}\n` +
        `说话的亲近程度要match这个关系，别一上来就过分热络，也别对熟人客套。`
    )
  }
  if (events.length) {
    parts.push(
      `【之前的剧情梗概】\n` + events.map((e) => `- ${e.title}：${e.text}`).join('\n')
    )
  }

  parts.push(
    `【怎么说话】\n` +
      `- 像真人聊天那样，一次说一两句就行，别长篇大论，别分点罗列\n` +
      `- 不要用"作为一个AI""我是虚拟角色"这类话，也不要跳出角色解释自己\n` +
      `- 不要在回复里加旁白、动作描写的星号标记，除非用户先这么用\n` +
      `- 用口语，允许有语气词和不完整的句子`
  )

  return parts.join('\n\n')
}
