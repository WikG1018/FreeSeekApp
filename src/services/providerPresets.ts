import type { ProviderProtocol } from './providers.js'

type AccessId = 'api' | 'tokenPlan'
export type ProviderAccess = {
  id: AccessId
  url: string
  protocol: ProviderProtocol
  docs: string
  streamUsage?: boolean
  completionTokens?: boolean
}
export type ProviderPreset = {
  id: string
  name: string
  region: 'domestic' | 'international'
  access: ProviderAccess[]
}

const api = (url: string, docs: string, protocol: ProviderProtocol = 'openai'): ProviderAccess => ({
  id: 'api',
  url,
  docs,
  protocol,
})
const plan = (url: string, docs: string): ProviderAccess => ({ ...api(url, docs), id: 'tokenPlan' })
const mimoDocs = 'https://mimo.mi.com/docs/tokenplan/integration'
const miniMaxApi = 'https://api.minimax.cn/v1'
const openCodeOrigin = 'https://opencode.ai'
export const OPEN_CODE_GO_PATH = '/inference/go'
export const isOpenCodeGoUrl = (url: URL) =>
  url.origin === openCodeOrigin && /^\/(?:zen|inference)\/go(?:\/|$)/.test(url.pathname)

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'xiaomimimo',
    name: '小米 MiMo',
    region: 'domestic',
    access: [
      api('https://api.xiaomimimo.com/v1', mimoDocs),
      plan('https://token-plan-cn.xiaomimimo.com/v1', mimoDocs),
    ],
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    region: 'domestic',
    access: [
      api(
        'https://open.bigmodel.cn/api/paas/v4',
        'https://docs.bigmodel.cn/cn/guide/models/text/glm-5'
      ),
    ],
  },
  {
    id: 'kimi',
    name: 'Kimi',
    region: 'domestic',
    access: [api('https://api.moonshot.cn/v1', 'https://platform.kimi.com/docs/api/list-models')],
  },
  {
    id: 'volcengine',
    name: '火山方舟',
    region: 'domestic',
    access: [
      api(
        'https://ark.cn-beijing.volces.com/api/v3',
        'https://docs.volcengine.com/docs/ark/base-url-and-authentication?lang=zh'
      ),
    ],
  },
  {
    id: 'qwen',
    name: '阿里云百炼',
    region: 'domestic',
    access: [
      api(
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
        'https://help.aliyun.com/zh/model-studio/base-url'
      ),
    ],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    region: 'domestic',
    access: [
      {
        ...api(miniMaxApi, 'https://platform.minimax.cn/docs/api-reference/text-openai-api'),
        streamUsage: true,
        completionTokens: true,
      },
      {
        ...plan(miniMaxApi, 'https://platform.minimaxi.com/subscribe/token-plan'),
        streamUsage: true,
        completionTokens: true,
      },
    ],
  },
  {
    id: 'siliconcloud',
    name: '硅基流动',
    region: 'domestic',
    access: [
      api(
        'https://api.siliconflow.cn/v1',
        'https://docs.siliconflow.cn/docs/api/chat-completions-post'
      ),
    ],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    region: 'international',
    access: [
      api(
        'https://generativelanguage.googleapis.com/v1beta',
        'https://ai.google.dev/gemini-api/docs/api-key',
        'gemini'
      ),
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    region: 'international',
    access: [
      {
        ...api('https://api.openai.com/v1', 'https://platform.openai.com/docs/api-reference/chat'),
        streamUsage: true,
        completionTokens: true,
      },
    ],
  },
  {
    id: 'claude',
    name: 'Anthropic',
    region: 'international',
    access: [
      api(
        'https://api.anthropic.com/v1',
        'https://platform.claude.com/docs/en/api/overview',
        'anthropic'
      ),
    ],
  },
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    region: 'international',
    access: [
      {
        ...plan(
          openCodeOrigin + OPEN_CODE_GO_PATH + '/openai/v1',
          openCodeOrigin + '/docs/console/go/'
        ),
        streamUsage: true,
      },
    ],
  },
  {
    id: 'opencode',
    name: 'OpenCode Zen',
    region: 'international',
    access: [
      {
        ...api(
          openCodeOrigin + '/inference/openai/v1',
          openCodeOrigin + '/docs/console/api/inference'
        ),
        streamUsage: true,
      },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    region: 'international',
    access: [
      {
        ...api('https://openrouter.ai/api/v1', 'https://openrouter.ai/docs/quickstart'),
        streamUsage: true,
      },
    ],
  },
]

export const providerPreset = (id?: string) => PROVIDER_PRESETS.find((preset) => preset.id === id)
export const providerAccess = (id?: string, access?: string) =>
  providerPreset(id)?.access.find((item) => item.id === access)
