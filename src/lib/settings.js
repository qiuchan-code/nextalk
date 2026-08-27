import { reactive, watch } from 'vue'

const STORAGE_KEY = 'zhipianren.settings.v1'

/**
 * 常用服务商预设。endpoint 存完整地址（含 /chat/completions），
 * 因为各家路径规则不统一（DeepSeek 没有 /v1，智谱是 /api/paas/v4），
 * 与其在代码里猜路径，不如让用户看到完整地址，出错时一眼能发现。
 *
 * canBrowser 是实测结论：浏览器直连需要对方返回 CORS 头。
 */
export const PROVIDERS = [
  {
    name: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-chat',
    canBrowser: true,
    note: '便宜、中文好、角色扮演不死板，推荐首选'
  },
  {
    name: '智谱 GLM',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model: 'glm-4-flash',
    canBrowser: true,
    note: 'glm-4-flash 免费额度大，适合练手'
  },
  {
    name: '硅基流动',
    endpoint: 'https://api.siliconflow.cn/v1/chat/completions',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    canBrowser: true,
    note: '一个 Key 能调很多开源模型，新号送额度'
  },
  {
    name: 'MiniMax',
    endpoint: 'https://api.minimax.chat/v1/text/chatcompletion_v2',
    model: 'MiniMax-Text-01',
    canBrowser: true,
    note: '星野自家的模型，角色扮演是强项'
  },
  {
    name: 'OpenRouter',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'deepseek/deepseek-chat',
    canBrowser: true,
    note: '一个 Key 转接全球模型，需要梯子'
  },
  {
    name: 'Kimi（网页版用不了）',
    endpoint: 'https://api.moonshot.cn/v1/chat/completions',
    model: 'moonshot-v1-8k',
    canBrowser: false,
    note: '实测它不返回跨域头，浏览器会直接拦截请求，只能在服务端调用'
  }
]

const defaults = {
  endpoint: PROVIDERS[0].endpoint,
  apiKey: '',
  model: PROVIDERS[0].model,
  maxTokens: 1024,
  // 记忆相关（Phase 3 用）
  memoryModel: '', // 留空 = 用对话模型
  memoryEveryN: 8, // 每多少条消息提炼一次记忆
  historyWindow: 14, // 每次发给模型的原文消息条数
  // 聊天区背景（Phase 5 优化）：颜色或自定义壁纸，空 = 纸质默认
  chatBgColor: '', // hex 颜色
  chatBgImage: ''  // 自定义壁纸 dataURL，设了就盖过颜色
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 设置存 localStorage 而不是 IndexedDB：
 * 数据小、要同步读（启动就得知道有没有配 Key）、丢了也就重填一次。
 *
 * API Key 存在浏览器里安全吗？安全。代码里没有密钥，别人打开你部署的网址
 * 看到的是空设置页，得填他自己的 Key。真正的风险只有你自己的设备被入侵。
 */
export const settings = reactive({ ...defaults, ...load() })

watch(
  settings,
  (val) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(val))
    } catch (err) {
      console.warn('设置保存失败', err)
    }
  },
  { deep: true }
)

/** 配齐了才能聊天 */
export function isConfigured() {
  return Boolean(settings.apiKey && settings.endpoint && settings.model)
}

/** 给记忆提炼这类后台任务用的模型（可以指定便宜的） */
export function memoryModelName() {
  return settings.memoryModel?.trim() || settings.model
}
