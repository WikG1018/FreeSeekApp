import { create } from 'zustand'
import { createId } from '../utils/id.js'
import { diagnosticError, logEvent } from './diagnostics/log.js'

export class PersonaError extends Error {
  constructor(readonly reason: 'invalid' | 'storage') {
    super(`Persona ${reason}`)
    this.name = 'PersonaError'
  }
}
const validate = (name: string, prompt: string) => {
  if (!name.trim() || name.trim().length > 80 || prompt.length > 100000) {
    throw new PersonaError('invalid')
  }
}

/** 人设：新会话创建时的 system 提示词快照来源；prompt 为空表示使用默认助手身份 */
export type Persona = {
  id: string
  name: string
  prompt: string
}

const STORAGE_KEY = 'freeseek:personas'
const DEFAULT_KEY = 'freeseek:default-persona'
const BUILTIN_PREFIX = 'builtin-'

/** 内置人设，不可编辑或删除；默认助手不覆盖 system 提示词 */
export const BUILTIN_PERSONAS: Persona[] = [
  {
    id: 'builtin-default',
    name: '默认助手',
    prompt: '',
  },
  {
    id: 'builtin-writer',
    name: '写作助手',
    prompt:
      '你是一位资深中文写作助手，擅长润色、改写、扩写与缩写。先弄清用途与受众再动手；可按需要切换正式、口语、文艺、活泼等文风。修改时保留原意，输出完整成稿，并在末尾用一两句话说明主要改动。',
  },
  {
    id: 'builtin-translator',
    name: '翻译专家',
    prompt:
      '你是一位专业译者，精通中英互译与其他常见语言对。翻译忠实原意与语气，符合目标语言的表达习惯，不逐字直译；专有名词、俚语与歧义处附简要译法说明。未指明方向时，中文译英文、外文译中文。',
  },
  {
    id: 'builtin-coder',
    name: '编程助手',
    prompt:
      '你是一位经验丰富的工程师，熟悉主流编程语言与工程实践。回答先给结论或可直接运行的代码，再解释关键点；代码完整、包含必要导入与用法示例，并注明假设的运行环境；主动指出潜在的坑与更优替代方案。',
  },
  {
    id: 'builtin-xiaohongshu',
    name: '小红书文案',
    prompt:
      '你是小红书资深博主兼文案教练。把用户给的主题写成高互动笔记：3 个吸睛标题备选、开头一句话抓人、正文分段短句、适量 emoji、口语化有网感、结尾自然引导点赞收藏评论。用户给出产品或受众时，围绕卖点与人群定制角度与语气。',
  },
  {
    id: 'builtin-brainstorm',
    name: '头脑风暴',
    prompt:
      '你是发散思维搭档，任务是帮用户打开思路。针对问题先快速给出 8-10 个不同角度的想法，从保守到大胆都覆盖，每个一句话讲清价值；再从中挑 2-3 个最有潜力的展开成可执行方向。不急于否定任何想法，先追求多样与数量。',
  },
]

const isPersona = (value: unknown): value is Persona =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Persona).id === 'string' &&
  (value as Persona).id !== '' &&
  typeof (value as Persona).name === 'string' &&
  (value as Persona).name.trim() !== '' &&
  typeof (value as Persona).prompt === 'string'

const loadCustom = (): Persona[] => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    const seen = new Set<string>()
    return Array.isArray(parsed)
      ? parsed.filter(isPersona).filter((persona) => {
          if (seen.has(persona.id) || persona.id.startsWith(BUILTIN_PREFIX)) {
            return false
          }
          seen.add(persona.id)
          return true
        })
      : []
  } catch {
    return []
  }
}

const persistCustom = (personas: Persona[]) => {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(personas.filter((persona) => !persona.id.startsWith(BUILTIN_PREFIX)))
    )
  } catch (error) {
    logEvent('storage', 'personas.save-failed', diagnosticError(error), 'error')
    throw new PersonaError('storage')
  }
}

const persistDefault = (id: string) => {
  try {
    localStorage.setItem(DEFAULT_KEY, id)
  } catch (error) {
    logEvent('storage', 'persona-default.save-failed', diagnosticError(error), 'error')
    throw new PersonaError('storage')
  }
}

type PersonaState = {
  /** 内置 + 自定义，默认助手恒在首位 */
  personas: Persona[]
  /** 新会话使用的人设；builtin-default 表示不覆盖 system 提示词 */
  defaultId: string
}

const initialDefault = (): string => {
  let saved: string | null = null
  try {
    saved = localStorage.getItem(DEFAULT_KEY)
  } catch {
    /* 存储不可用时使用默认人设。 */
  }
  return saved && [...BUILTIN_PERSONAS, ...loadCustom()].some((p) => p.id === saved)
    ? saved
    : 'builtin-default'
}

export const usePersonas = create<PersonaState>(() => ({
  personas: [...BUILTIN_PERSONAS, ...loadCustom()],
  defaultId: initialDefault(),
}))

/** 仅恢复已校验的本机人设备份；内置人设始终来自当前版本。 */
export const restorePersonas = (custom: Persona[], defaultId: string): void => {
  const personas = [...BUILTIN_PERSONAS, ...custom]
  const selected = personas.some((persona) => persona.id === defaultId)
    ? defaultId
    : 'builtin-default'
  // 聊天数据库已完成恢复；偏好存储失败由日志记录，不能再把整次导入误报失败。
  try {
    persistCustom(personas)
    persistDefault(selected)
  } catch {
    /* 保留本次进程内恢复结果。 */
  }
  usePersonas.setState({ personas, defaultId: selected })
}

export const isBuiltin = (persona: Persona): boolean => persona.id.startsWith(BUILTIN_PREFIX)

const commit = (personas: Persona[], defaultId = usePersonas.getState().defaultId) => {
  let oldCustom: string | null, oldDefault: string | null
  try {
    oldCustom = localStorage.getItem(STORAGE_KEY)
    oldDefault = localStorage.getItem(DEFAULT_KEY)
  } catch {
    throw new PersonaError('storage')
  }
  try {
    persistCustom(personas)
    persistDefault(defaultId)
  } catch (error) {
    try {
      if (oldCustom === null) {
        localStorage.removeItem(STORAGE_KEY)
      } else {
        localStorage.setItem(STORAGE_KEY, oldCustom)
      }
      if (oldDefault === null) {
        localStorage.removeItem(DEFAULT_KEY)
      } else {
        localStorage.setItem(DEFAULT_KEY, oldDefault)
      }
    } catch {
      /* 持续不可写时保持内存中的旧状态。 */
    }
    throw error
  }
  usePersonas.setState({ personas, defaultId })
}

export const addPersona = (name: string, prompt: string): string => {
  validate(name, prompt)
  if (usePersonas.getState().personas.filter((p) => !isBuiltin(p)).length >= 200) {
    throw new PersonaError('invalid')
  }
  const persona: Persona = { id: createId(), name: name.trim(), prompt: prompt.trim() }
  commit([...usePersonas.getState().personas, persona])
  return persona.id
}

export const updatePersona = (id: string, name: string, prompt: string): void => {
  validate(name, prompt)
  commit(
    usePersonas
      .getState()
      .personas.map((persona) =>
        persona.id === id && !isBuiltin(persona)
          ? { ...persona, name: name.trim(), prompt: prompt.trim() }
          : persona
      )
  )
}

export const removePersona = (id: string): void => {
  if (id.startsWith(BUILTIN_PREFIX)) {
    return
  }
  const { personas, defaultId } = usePersonas.getState()
  commit(
    personas.filter((persona) => persona.id !== id),
    defaultId === id ? 'builtin-default' : defaultId
  )
}

export const setDefaultPersona = (id: string): void => {
  if (usePersonas.getState().personas.some((persona) => persona.id === id)) {
    commit(usePersonas.getState().personas, id)
  }
}

/** 新会话的人设快照；默认助手（无自定义提示词）返回 null */
export const activePersona = (): { name: string; prompt: string } | null => {
  const { personas, defaultId } = usePersonas.getState()
  const persona = personas.find((item) => item.id === defaultId)
  return persona && persona.prompt.trim() !== ''
    ? { name: persona.name, prompt: persona.prompt }
    : null
}

/** 全量校验后追加，外部 ID 和默认选择不覆盖本机设置。 */
export const importPersonas = async (file: File): Promise<number> => {
  if (file.size > 16 * 1024 * 1024) {
    throw new PersonaError('invalid')
  }
  const text = await file.text()
  let items: unknown
  if (/\.(txt|md|markdown)$/i.test(file.name)) {
    items = [{ name: file.name.replace(/\.[^.]+$/, ''), prompt: text }]
  } else {
    try {
      const data = JSON.parse(text) as unknown
      if (Array.isArray(data)) {
        items = data
      } else if (data && typeof data === 'object') {
        const object = data as Record<string, unknown>
        if (
          object.freeseek_personas_version !== undefined &&
          object.freeseek_personas_version !== 1
        ) {
          throw new PersonaError('invalid')
        }
        items = object.personas ?? [object]
      }
    } catch {
      throw new PersonaError('invalid')
    }
  }
  if (!Array.isArray(items) || !items.length || items.length > 200) {
    throw new PersonaError('invalid')
  }
  const additions = items.map((item) => {
    if (!item || typeof item !== 'object') {
      throw new PersonaError('invalid')
    }
    const value = item as Record<string, unknown>,
      name = value.name ?? value.act,
      prompt = value.prompt ?? value.systemPrompt
    if (typeof name !== 'string' || typeof prompt !== 'string') {
      throw new PersonaError('invalid')
    }
    validate(name, prompt)
    return { id: createId(), name: name.trim(), prompt: prompt.trim() }
  })
  const current = usePersonas.getState().personas
  if (current.filter((p) => !isBuiltin(p)).length + additions.length > 200) {
    throw new PersonaError('invalid')
  }
  commit([...current, ...additions])
  return additions.length
}
export const exportPersonas = (): { name: string; blob: Blob } | null => {
  const personas = usePersonas
    .getState()
    .personas.filter((p) => !isBuiltin(p))
    .map(({ name, prompt }) => ({ name, prompt }))
  return personas.length
    ? {
        name: `freeseek-personas-${new Date().toISOString().slice(0, 10)}.json`,
        blob: new Blob([JSON.stringify({ freeseek_personas_version: 1, personas }, null, 2)], {
          type: 'application/json',
        }),
      }
    : null
}
