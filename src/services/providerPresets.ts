import type { ProviderProtocol } from './providers.js'
import type { Locale } from './settings.js'

type AccessId = 'api' | 'tokenPlan' | 'codingPlan' | 'go'
export type ProviderAccess = {
  id: AccessId
  connectionName?: string
  connectionNameEn?: string
  url: string
  modelListUrl?: string
  protocol: ProviderProtocol
  docs: string
  streamUsage?: boolean
  completionTokens?: boolean
}
export type ProviderPreset = {
  id: string
  name: string
  nameEn?: string
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
    nameEn: 'Xiaomi MiMo',
    region: 'domestic',
    access: [
      api('https://api.xiaomimimo.com/v1', mimoDocs),
      plan('https://token-plan-cn.xiaomimimo.com/v1', mimoDocs),
    ],
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    nameEn: 'Zhipu GLM',
    region: 'domestic',
    access: [
      api(
        'https://open.bigmodel.cn/api/paas/v4',
        'https://docs.bigmodel.cn/cn/guide/models/text/glm-5'
      ),
      {
        ...api(
          'https://open.bigmodel.cn/api/coding/paas/v4',
          'https://docs.bigmodel.cn/cn/coding-plan/tool/others'
        ),
        id: 'codingPlan',
        connectionName: '智谱 GLM · Coding Plan',
        connectionNameEn: 'Zhipu GLM · Coding Plan',
      },
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
    nameEn: 'Volcengine Ark',
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
    nameEn: 'Alibaba Cloud Model Studio',
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
    nameEn: 'SiliconFlow',
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
    id: 'opencode',
    name: 'OpenCode',
    region: 'international',
    access: [
      {
        ...api(
          openCodeOrigin + '/inference/openai/v1',
          openCodeOrigin + '/docs/console/api/inference'
        ),
        connectionName: 'OpenCode Zen',
        modelListUrl: openCodeOrigin + '/inference/v1/models',
        streamUsage: true,
      },
      {
        ...api(
          openCodeOrigin + OPEN_CODE_GO_PATH + '/openai/v1',
          openCodeOrigin + '/docs/console/go/'
        ),
        id: 'go',
        connectionName: 'OpenCode Go',
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

export const presetName = (preset: ProviderPreset, locale: Locale): string =>
  locale === 'en-US' ? (preset.nameEn ?? preset.name) : preset.name

export const presetConnectionName = (
  preset: ProviderPreset,
  access: ProviderAccess,
  locale: Locale
): string =>
  (locale === 'en-US' ? access.connectionNameEn : undefined) ??
  access.connectionName ??
  presetName(preset, locale) +
    (preset.access.length > 1 && access.id === 'tokenPlan' ? ' · Token Plan' : '')

export const providerPreset = (id?: string) =>
  PROVIDER_PRESETS.find((preset) => preset.id === (id === 'opencode-go' ? 'opencode' : id))
export const providerAccess = (id?: string, access?: string) =>
  providerPreset(id)?.access.find(
    (item) => item.id === (id === 'opencode-go' && access === 'tokenPlan' ? 'go' : access)
  )
