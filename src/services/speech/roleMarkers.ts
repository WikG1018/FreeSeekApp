/**
 * 角色配音的标记协议与解析器。纯函数，不依赖 React 或浏览器 API。
 *
 * 聊天模型在回答里用 ⟦ ⟧ 标注「谁在说话、这段什么语气」，前台渲染前剥掉，朗读时按段取音色。
 *
 *   首次出场（完整声明）：
 *     ⟦新角色：林黛玉｜别名：林妹妹、颦儿｜音色：茉莉｜性格：多愁善感，说话轻柔｜重要性：主角⟧
 *   之后每段：
 *     ⟦黛玉｜语气：委屈，声音发颤⟧你别管我。
 *
 * ⟦ ⟧ 是 U+27E6 / U+27E7：Markdown 不认识、正常文本不出现、输入法打不出来。
 */

export type MiMoPresetVoice =
  | '冰糖'
  | '茉莉'
  | '苏打'
  | '白桦'
  | 'Mia'
  | 'Chloe'
  | 'Milo'
  | 'Dean'
  | 'mimo_default'

export const MIMO_PRESET_VOICES: ReadonlyArray<{ id: MiMoPresetVoice; label: string }> = [
  { id: '冰糖', label: '活泼少女 · 中文女声' },
  { id: '茉莉', label: '知性女声 · 中文女声' },
  { id: '苏打', label: '阳光少年 · 中文男声' },
  { id: '白桦', label: '成熟沉稳 · 中文男声' },
  { id: 'Mia', label: '英文女声' },
  { id: 'Chloe', label: '英文女声' },
  { id: 'Milo', label: '英文男声' },
  { id: 'Dean', label: '英文男声' },
]

/**
 * 默认音色。旁白和路人默认不能相同：多轮实测里小丫鬟的台词和旁白都是白桦，
 * 听起来就是旁白自己在演。设置、解析兜底、路人升级时补音色，都用这两个值。
 */
export const DEFAULT_NARRATOR_VOICE: MiMoPresetVoice = '白桦'
export const DEFAULT_EXTRA_VOICE: MiMoPresetVoice = '苏打'

export type RoleImportance = 'lead' | 'supporting' | 'extra'

/** 存在会话上的角色；接续新对话时随 InheritedContext 一起走 */
export type VoiceRole = {
  id: string
  name: string
  aliases: string[]
  /** 音色二选一：预置 ID（出声快）或描述（更贴合，但每段要等整段合成完） */
  preset?: MiMoPresetVoice
  description?: string
  /** 性格底色：约束语气的范围，用户可编辑 */
  nature: string
  importance: RoleImportance
  /** user 设定过的角色，模型不能再改音色/别名/性格 */
  source: 'model' | 'user'
  createdAt: number
}

export type VoiceSegment = {
  roleId: string
  /** 本段语气，模型临场写 */
  tone: string
  text: string
}

export type ParsedReply = {
  /** 按出现顺序的朗读段；没有任何标记时为空 */
  segments: VoiceSegment[]
  /** 剥掉所有标记的正文，渲染用 */
  plain: string
  /** 这次回答里首次出场、需要写进会话角色表的角色 */
  newRoles: VoiceRole[]
  /** 已有角色的别名新增（模型补声明） */
  aliasAdditions: Array<{ roleId: string; aliases: string[] }>
  /** 已有角色的重要性升级（只升不降） */
  promotions: Array<{ roleId: string; to: RoleImportance }>
  /** 模型后补的完整声明：早先按裸名字猜出来的角色，用声明里的音色/性格补齐 */
  updates: Array<{ roleId: string; patch: Partial<VoiceRole> }>
  /** 路人补建：标记里出现但表里没有的名字 */
  unknownNames: string[]
}

/**
 * 标注的开括号。不收 ASCII '['，避免把 Markdown 链接当成标注。
 *
 * 实测模型不会老老实实用 ⟦⟧：mimo 会换成 〕收尾，也会整段改用「」或【】。
 * 所以放开常见括号，但只有「结构明显像标注」的才算标签——
 * ⟦ 和 ［ 是生僻字符，出现即认；其余括号在中文正文里太常见，
 * 必须内容带 ｜ 分隔或直接以「新角色」「语气：」开头才认。
 */
const OPENERS = ['⟦', '［', '【', '「', '『', '〔'] as const
const STRONG_OPENERS = new Set(['⟦', '［'])
/** 收尾字符：模型经常写错配对的那一个，任何一种收尾都算结束 */
const CLOSERS = new Set(['⟧', '〕', '】', '］', ']', '」', '』'])
/** 标注不会跨行：找不到收尾时最多读到行末，避免把整段回答当成标注吞掉 */
const TAG_MAX_LENGTH = 400
/** 标注里会出现的键名；除此之外的键当作角色名（模型常写「贾母：次要｜语气：…」） */
const KNOWN_KEYS = new Set(['新角色', '角色', '角色名', '别名', '音色', '性格', '重要性', '语气', '_bare'])
/**
 * 判断一行是不是标注行。
 *
 * 实测跟着括号样式追是死路：模型会用 ⟧ 收尾、会换成「」【】、干脆不写括号。
 * 所以按结构认：带 ｜ 分隔、含 语气/音色/性格 这类字段、且不是一整段正文。
 * 普通对话「不敢。」没有 ｜，正文里带 ｜ 的散文几乎不存在，误判风险很低。
 */
const FIELD_HINTS = ['新角色', '角色', '别名', '音色', '性格', '重要性', '语气']
const looksLikeTagLine = (line: string) => {
  const text = line.trim()
  if (!text || text.length > 160) {
    return false
  }
  if (!/[｜|]/.test(text)) {
    return false
  }
  // 去掉外面可能套着的括号再判断
  const inner = text.replace(/^[「『【〔⟦［[(]+/, '').replace(/[」』】〕⟧］\])]+$/, '')
  return FIELD_HINTS.some((hint) => inner.includes(`${hint}：`) || inner.includes(`${hint}:`))
}
const NARRATOR = '旁白'
const RANK: Record<RoleImportance, number> = { extra: 0, supporting: 1, lead: 2 }

const IMPORTANCE_WORDS: Record<string, RoleImportance> = {
  主角: 'lead',
  主要: 'lead',
  次要: 'supporting',
  配角: 'supporting',
  路人: 'extra',
  龙套: 'extra',
  lead: 'lead',
  supporting: 'supporting',
  extra: 'extra',
}

const isPresetVoice = (value: string): value is MiMoPresetVoice =>
  (MIMO_PRESET_VOICES as ReadonlyArray<{ id: string }>).some((voice) => voice.id === value) ||
  value === 'mimo_default'

const clean = (value: string | undefined) => value?.trim() ?? ''

/** 提示词让模型在没有别名时写「别名：无」「Aliases：none」，这些占位词不是真别名 */
const NO_ALIAS = /^(无|没有|暂无|无别名|none|n\/a|na|-|—|–)$/i

/** 把「别名：林妹妹、颦儿」拆成数组；去空、去重、去掉和主名相同的、去掉占位词 */
const splitAliases = (raw: string, name: string) => {
  const seen = new Set<string>([name])
  const out: string[] = []
  for (const alias of raw.split(/[、,，;；/\s]+/)) {
    const item = clean(alias)
    if (item && !seen.has(item) && !NO_ALIAS.test(item)) {
      seen.add(item)
      out.push(item)
    }
  }
  return out
}

/**
 * 解析标注内部：按 ｜ 或 | 切成 key:value。
 * 模型常写「贾母：次要｜语气：慈和欢喜」——这里的键是角色名不是字段名，
 * 所以额外返回第一个非字段键，供调用方当角色名用。
 */
const parseFields = (inner: string) => {
  const fields = new Map<string, string>()
  let looseName = ''
  let looseValue = ''
  for (const part of inner.split(/[｜|]/)) {
    const index = part.search(/[:：]/)
    if (index < 0) {
      const bare = clean(part)
      if (bare && !looseName) {
        looseName = bare
      }
      continue
    }
    const key = clean(part.slice(0, index))
    const value = clean(part.slice(index + 1))
    if (!key) {
      continue
    }
    const lowered = key.toLowerCase()
    if (KNOWN_KEYS.has(lowered) || KNOWN_KEYS.has(key)) {
      fields.set(lowered, value)
    } else if (!looseName) {
      // 不认识的键：极可能是「角色名：重要性」
      looseName = key
      looseValue = value
    }
  }
  return { fields, looseName, looseValue }
}

export type RoleLookup = (name: string) => VoiceRole | undefined

/** 一个识别出来的标注：在原文里的起止位置和内容 */
type TagMark = { start: number; end: number; inner: string }

/**
 * 扫出所有标注。两条路并用：
 *
 * 1. 括号包裹的（⟦…⟧、⟦…〕、「…」、【…】）：不依赖括号配对，遇到任意收尾字符即结束；
 * 2. 裸行（模型经常干脆不写括号）：整行结构像标注就认。
 *
 * 只靠括号会被模型的各种变体打穿，只靠行结构又会漏掉「⟦旁白⟧台词」这种把台词接在同行的写法，
 * 所以两条都要。
 */
const scanMarks = (text: string): TagMark[] => {
  const marks: TagMark[] = []
  let index = 0
  while (index < text.length) {
    const opener = OPENERS.find((item) => text.startsWith(item, index))
    if (!opener) {
      index += 1
      continue
    }
    const contentStart = index + opener.length
    let cursor = contentStart
    while (cursor < text.length && cursor - contentStart <= TAG_MAX_LENGTH) {
      const char = text[cursor]
      if (CLOSERS.has(char) || char === '\n') {
        break
      }
      cursor += 1
    }
    const closed = cursor < text.length && CLOSERS.has(text[cursor])
    if (!closed) {
      // 没闭合（流式还没写完或模型漏了）：不算标注，交给 strip 的尾巴处理
      index = contentStart
      continue
    }
    const inner = text.slice(contentStart, cursor)
    const strong = STRONG_OPENERS.has(opener)
    if (!inner.trim()) {
      // 空的生僻括号是模型留下的残渣，照样要剥掉；解析阶段会因为没名字而跳过
      if (strong) {
        marks.push({ start: index, end: cursor + 1, inner })
      }
      index = contentStart
      continue
    }
    if (!strong && !looksLikeTagLine(inner)) {
      index = contentStart
      continue
    }
    marks.push({ start: index, end: cursor + 1, inner })
    index = cursor + 1
  }
  return mergeWithBareLines(text, marks)
}

/**
 * 补上「裸行」标注：模型经常整行不写括号，例如
 *   旁白｜音色：茉莉｜语气：平缓铺垫
 * 逐行扫，行整行像标注就把它整行当成一个标注。
 */
const mergeWithBareLines = (text: string, marks: TagMark[]): TagMark[] => {
  // 这一行已经有括号标注时不能再按整行识别：同行写法「⟦旁白⟧台词」会把台词一起吞掉
  const overlaps = (start: number, end: number) =>
    marks.some((mark) => mark.start < end && mark.end > start)
  const extra: TagMark[] = []
  let offset = 0
  for (const rawLine of text.split('\n')) {
    const start = offset
    const end = offset + rawLine.length
    offset = end + 1
    if (!rawLine.trim() || overlaps(start, end) || !looksLikeTagLine(rawLine)) {
      continue
    }
    const leading = rawLine.length - rawLine.trimStart().length
    const inner = rawLine
      .trim()
      .replace(/^[「『【〔⟦［[(]+/, '')
      .replace(/[」』】〕⟧］\])]+$/, '')
    extra.push({ start: start + leading, end: start + leading + rawLine.trim().length, inner })
  }
  return [...marks, ...extra].sort((a, b) => a.start - b.start)
}

/** 按主名和别名查表 */
export const createRoleLookup = (roles: ReadonlyArray<VoiceRole>): RoleLookup => {
  const index = new Map<string, VoiceRole>()
  for (const role of roles) {
    index.set(role.name, role)
    for (const alias of role.aliases) {
      if (!index.has(alias)) {
        index.set(alias, role)
      }
    }
  }
  const names = roles.map((role) => ({ role, name: role.name }))
  return (name) => {
    const exact = index.get(name)
    if (exact) {
      return exact
    }
    // 模型常写简称（黛玉 ↔ 林黛玉、宝玉 ↔ 贾宝玉）。只在唯一命中时归并，
    // 宁可多建一个角色，也不要把两个人错并成一个人。
    if (name.length < 2) {
      return undefined
    }
    const candidates = names.filter(
      ({ name: full }) =>
        full !== name &&
        (full.endsWith(name) || full.startsWith(name) || name.endsWith(full) || name.startsWith(full))
    )
    const unique = new Set(candidates.map(({ role }) => role.id))
    return unique.size === 1 ? candidates[0].role : undefined
  }
}

export const defaultRoleVoice = (
  importance: RoleImportance,
  narratorVoice: MiMoPresetVoice,
  extraVoice: MiMoPresetVoice
): Pick<VoiceRole, 'preset' | 'description'> => ({
  preset: importance === 'extra' ? extraVoice : narratorVoice,
})

/**
 * 解析一条回答。`existing` 是会话当前的角色表。
 * 不修改入参；所有变更以 newRoles / aliasAdditions / promotions 返回，由调用方合并。
 */
export const parseRoleMarkers = (
  text: string,
  existing: ReadonlyArray<VoiceRole>,
  options: {
    narratorVoice?: MiMoPresetVoice
    extraVoice?: MiMoPresetVoice
    now?: number
    /** false = 用户把「主角默认音色」设成了预置：模型写的音色描述不采纳，按没写处理，落回预置 */
    allowDescription?: boolean
  } = {}
): ParsedReply => {
  const narratorVoice = options.narratorVoice ?? DEFAULT_NARRATOR_VOICE
  const extraVoice = options.extraVoice ?? DEFAULT_EXTRA_VOICE
  const now = options.now ?? 0
  const allowDescription = options.allowDescription ?? true
  const lookup = createRoleLookup(existing)
  const segments: VoiceSegment[] = []
  const newRoles: VoiceRole[] = []
  const aliasAdditions: ParsedReply['aliasAdditions'] = []
  const promotions: ParsedReply['promotions'] = []
  const updates: ParsedReply['updates'] = []
  const unknownNames: string[] = []
  const newLookup = new Map<string, VoiceRole>()
  const resolve = (name: string) => lookup(name) ?? newLookup.get(name)

  const marks = scanMarks(text)
  let plain = ''
  let cursor = 0
  for (const [index, mark] of marks.entries()) {
    // 标记之前的文本照常显示
    plain += text.slice(cursor, mark.start)
    const nextStart = marks[index + 1]?.start ?? text.length
    // 标记之后到下一个标记之前的全部文本都要渲染……
    const rest = text.slice(mark.end, nextStart)
    plain += rest
    cursor = nextStart
    // ……但只有第一个段落（到空行为止）是这个角色的台词；空行之后的叙述没有归属，不朗读
    const speech = clean(rest.split(/\n\s*\n/)[0])
    const { fields, looseName, looseValue } = parseFields(mark.inner)

    const isNew = fields.has('新角色')
    const name = clean(
      fields.get('新角色') ?? fields.get('角色') ?? fields.get('角色名') ?? fields.get('_bare') ?? looseName
    )
    if (!name) {
      continue
    }
    const tone = clean(fields.get('语气'))
    let role = resolve(name)
    // 没写「新角色」声明、表里也没有：按规划补建，否则模型只写「⟦旁白⟧」时整个功能都失效
    const autoCreate = !role && !isNew
    if (isNew || autoCreate) {
      const declaredAliases = splitAliases(fields.get('别名') ?? '', name)
      const declaredNature = clean(fields.get('性格'))
      const isNarrator = name === NARRATOR
      // 重要性可以写在「重要性：」里，也可以写在「角色名：次要」那一侧
      const importanceWord = (clean(fields.get('重要性')) || looseValue).toLowerCase()
      const importance =
        IMPORTANCE_WORDS[importanceWord] ?? (isNarrator ? 'supporting' : 'extra')
      const declaredVoice = clean(fields.get('音色'))
      if (role) {
        // 已有角色：用户设定过的音色一律不动。模型早先按裸名字猜出来的路人，
        // 允许用后到的完整声明补齐——否则「先出现「黛玉」、再出现新角色：林黛玉」会留下两个声音。
        const additions = declaredAliases.filter((alias) => !resolve(alias))
        if (additions.length) {
          aliasAdditions.push({ roleId: role.id, aliases: additions })
          for (const alias of additions) {
            newLookup.set(alias, role)
          }
        }
        if (role.source === 'model') {
          const patch: Partial<VoiceRole> = {}
          // 描述只给主角/次要，而且要用户没关；旁白和路人任何时候都只用预置
          const mayDescribe = allowDescription && !isNarrator && role.importance !== 'extra'
          if (declaredVoice && isPresetVoice(declaredVoice) && !role.description) {
            patch.preset = declaredVoice
          } else if (declaredVoice && !isPresetVoice(declaredVoice) && mayDescribe && role.description !== declaredVoice) {
            patch.description = declaredVoice
            // 有了描述就不能再留着预置，否则显示和朗读都还按预置走
            patch.preset = undefined
          }
          if (declaredNature && declaredNature !== role.nature) {
            patch.nature = declaredNature
          }
          if (Object.keys(patch).length) {
            updates.push({ roleId: role.id, patch })
          }
        }
        // RANK 里 extra=0、lead=2，升级就是新值比旧值大
        if (RANK[importance] > RANK[role.importance]) {
          promotions.push({ roleId: role.id, to: importance })
        }
      } else {
        if (autoCreate) {
          unknownNames.push(name)
        }
        // 旁白和路人只能用预置；主角/次要可以写描述——除非用户把主角音色设成了「预置」
        const usePreset =
          !allowDescription ||
          isNarrator ||
          importance === 'extra' ||
          !declaredVoice ||
          isPresetVoice(declaredVoice)
        const fallback = defaultRoleVoice(importance, narratorVoice, extraVoice)
        const created: VoiceRole = {
          id: `role-${now}-${newRoles.length}-${name}`,
          name,
          aliases: declaredAliases,
          nature: declaredNature || (isNarrator ? '冷静客观' : ''),
          importance,
          source: 'model',
          createdAt: now,
          ...(usePreset
            ? { preset: (isPresetVoice(declaredVoice) ? declaredVoice : fallback.preset) as MiMoPresetVoice }
            : { description: declaredVoice }),
        }
        newRoles.push(created)
        newLookup.set(name, created)
        for (const alias of declaredAliases) {
          newLookup.set(alias, created)
        }
        role = created
      }
    } else if (!role) {
      continue
    }
    if (speech && role) {
      segments.push({ roleId: role.id, tone, text: speech })
    }
  }
  plain += text.slice(cursor)

  return {
    segments,
    plain,
    newRoles,
    aliasAdditions,
    promotions,
    updates,
    unknownNames: [...new Set(unknownNames)],
  }
}

/**
 * 渲染用：剥掉所有标注。
 * 末尾残留的开括号（流式还没写完，或模型漏了收尾）一律连同后面一起藏起来——
 * 未闭合的标注永远不是正文内容，显示出来只会是噪音。
 */
export const stripRoleMarkers = (text: string) => {
  const marks = scanMarks(text)
  if (!marks.length) {
    const dangling = danglingOpener(text)
    return dangling < 0 ? text : text.slice(0, dangling)
  }
  let out = ''
  let cursor = 0
  for (const mark of marks) {
    out += text.slice(cursor, mark.start)
    cursor = mark.end
  }
  out += text.slice(cursor)
  const dangling = danglingOpener(out)
  return dangling < 0 ? out : out.slice(0, dangling)
}

/**
 * 最后一个「开了但没收」的标注起点；没有返回 -1。
 * 只认两种情况，避免把正文里的【注意】这类强调误判：
 *   - 生僻开括号（⟦ ［）出现即认；
 *   - 【 之后到行末都没有任何收尾字符。
 */
const danglingOpener = (text: string) => {
  let found = -1
  for (let index = 0; index < text.length; index += 1) {
    const opener = OPENERS.find((item) => text.startsWith(item, index))
    if (!opener) {
      continue
    }
    const contentStart = index + opener.length
    let cursor = contentStart
    while (cursor < text.length && cursor - contentStart <= TAG_MAX_LENGTH) {
      const char = text[cursor]
      if (CLOSERS.has(char) || char === '\n') {
        break
      }
      cursor += 1
    }
    const closed = cursor < text.length && CLOSERS.has(text[cursor])
    if (closed) {
      // 这是一对完整的括号，跳过它
      index = cursor
      continue
    }
    const strong = STRONG_OPENERS.has(opener)
    if (strong || /[｜|]/.test(text.slice(contentStart, cursor)) || /语气\s*[:：]/.test(text.slice(contentStart, cursor))) {
      found = index
    }
    index = cursor
  }
  return found
}

export const hasRoleMarkers = (text: string) => scanMarks(text).length > 0

export const isNarratorRole = (role: Pick<VoiceRole, 'name'>) => role.name === NARRATOR
export const NARRATOR_NAME = NARRATOR
