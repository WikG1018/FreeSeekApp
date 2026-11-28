/**
 * 角色配音的标记协议与解析器。纯函数，不依赖 React 或浏览器 API。
 *
 * 聊天模型在回答里用 ⟦ ⟧ 标注「谁在说话、这段什么语气」，前台渲染前剥掉，朗读时按段取音色。
 *
 *   首次出场（完整声明）：
 *     ⟦新角色：林黛玉｜别名：林妹妹、颦儿｜声线：女声｜音色：茉莉｜性格：多愁善感｜重要性：主角⟧
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

export const MIMO_PRESET_VOICES: ReadonlyArray<{ id: MiMoPresetVoice; label: string; enLabel: string }> = [
  { id: '冰糖', label: '活泼少女 · 中文女声', enLabel: 'Bright · Chinese female' },
  { id: '茉莉', label: '知性女声 · 中文女声', enLabel: 'Composed · Chinese female' },
  { id: '苏打', label: '阳光少年 · 中文男声', enLabel: 'Youthful · Chinese male' },
  { id: '白桦', label: '成熟沉稳 · 中文男声', enLabel: 'Steady · Chinese male' },
  { id: 'Mia', label: '英文女声', enLabel: 'English female' },
  { id: 'Chloe', label: '英文女声', enLabel: 'English female' },
  { id: 'Milo', label: '英文男声', enLabel: 'English male' },
  { id: 'Dean', label: '英文男声', enLabel: 'English male' },
]

/**
 * 默认音色。旁白和路人默认不能相同：多轮实测里小丫鬟的台词和旁白都是白桦，
 * 听起来就是旁白自己在演。设置、解析兜底、路人升级时补音色，都用这两个值。
 */
export const DEFAULT_NARRATOR_VOICE: MiMoPresetVoice = '白桦'
export const DEFAULT_EXTRA_VOICE: MiMoPresetVoice = '苏打'
export const MAX_ROLE_NAME = 80
export const MAX_ROLE_TEXT = 400
export const MAX_ROLE_ALIASES = 50
export const MAX_ROLES = 500

export type RoleImportance = 'lead' | 'supporting' | 'extra'
export type VoiceGender = 'female' | 'male'
export const MAX_ROLE_SAMPLE_BYTES = 512 * 1024
export type RoleVoiceSample = { id: string; size: number }

/** 存在会话上的角色；接续新对话时随 InheritedContext 一起走 */
export type VoiceRole = {
  id: string
  name: string
  aliases: string[]
  /** 角色设定中的声线，旧记录和未交代的角色可缺省。 */
  voiceGender?: VoiceGender
  /** 音色二选一：预置 ID（出声快）或描述（更贴合，但每段要等整段合成完） */
  preset?: MiMoPresetVoice
  description?: string
  voiceSample?: RoleVoiceSample
  /** 性格底色：约束语气的范围，用户可编辑 */
  nature: string
  importance: RoleImportance
  /** user 设定过的角色，模型可补充别名，音色、性格和重要性由用户决定 */
  source: 'model' | 'user'
  /** Introduced by this reply version. In earlier archives, createdAt identifies the first reply. */
  introducedBy?: string
  createdAt: number
}

export type VoiceSegment = {
  roleId: string | null
  /** 本段语气，模型临场写 */
  tone: string
  text: string
  span?: { start: number; closed: boolean }
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
/** Normalize both prompt languages to the same field names. */
const FIELD_KEYS = new Map<string, string>(
  [
    ['新角色', 'new character', 'new role'],
    ['说话人', 'speaker'],
    ['角色', 'character', 'role'],
    ['角色名', 'character name', 'role name'],
    ['别名', 'aliases', 'alias'],
    ['声线', '性别', 'voice gender', 'gender'],
    ['音色', 'voice'],
    ['性格', 'nature', 'personality'],
    ['重要性', 'importance'],
    ['语气', 'tone'],
    ['_bare'],
  ].flatMap(([field, ...labels]) => [field, ...labels].map((label) => [label, field] as const))
)
const speakerLabel = /^(?:说话人|speaker)\s*[:：]/i
/**
 * 判断一行是不是标注行。
 *
 * 实测跟着括号样式追是死路：模型会用 ⟧ 收尾、会换成「」【】、干脆不写括号。
 * 所以按结构认：带 ｜ 分隔、含 语气/音色/性格 这类字段、且不是一整段正文。
 * 普通对话「不敢。」没有 ｜，正文里带 ｜ 的散文几乎不存在，误判风险很低。
 */
const looksLikeTagLine = (line: string) => {
  const text = line.trim()
  if (!text || text.length > 160) {
    return false
  }
  // 去掉外面可能套着的括号再判断
  const inner = text.replace(/^[「『【〔⟦［[(]+/, '').replace(/[」』】〕⟧］\])]+$/, '')
  if (!/[｜|]/.test(inner)) {
    return false
  }
  return inner.split(/[｜|]/).some((part) => {
    const separator = part.search(/[:：]/)
    return separator > 0 && FIELD_KEYS.has(part.slice(0, separator).trim().toLowerCase())
  })
}
const NARRATOR = '旁白'
export const roleNameKey = (name: string) => {
  const key = name.normalize('NFKC').trim().toLowerCase()
  return key === 'narrator' ? NARRATOR : key
}
const roleKey = roleNameKey
const RANK: Record<RoleImportance, number> = { extra: 0, supporting: 1, lead: 2 }

const IMPORTANCE_WORDS: Record<string, RoleImportance> = {
  主角: 'lead',
  共同主角: 'lead',
  男主: 'lead',
  女主: 'lead',
  主要: 'lead',
  次要: 'supporting',
  配角: 'supporting',
  路人: 'extra',
  龙套: 'extra',
  lead: 'lead',
  'co-lead': 'lead',
  protagonist: 'lead',
  supporting: 'supporting',
  extra: 'extra',
}

const isPresetVoice = (value: string): value is MiMoPresetVoice =>
  (MIMO_PRESET_VOICES as ReadonlyArray<{ id: string }>).some((voice) => voice.id === value) ||
  value === 'mimo_default'

const clean = (value: string | undefined) => value?.trim() ?? ''

const voiceGenderField = (value: string | undefined): VoiceGender | undefined => {
  const field = clean(value).toLowerCase()
  if (/^(女|女声|女性|female)$/.test(field)) {
    return 'female'
  }
  if (/^(男|男声|男性|male)$/.test(field)) {
    return 'male'
  }
  return undefined
}

export const voiceGenderFromDescription = (value: string): VoiceGender | undefined => {
  const female = /女声|女性|少女|\b(?:female|woman|girl)\b/i.test(value)
  const male = /男声|男性|少年|\b(?:male|man|boy)\b/i.test(value)
  return female === male ? undefined : female ? 'female' : 'male'
}

const presetPairs = [
  ['冰糖', '苏打'],
  ['茉莉', '白桦'],
  ['Mia', 'Milo'],
  ['Chloe', 'Dean'],
] as const satisfies ReadonlyArray<readonly [MiMoPresetVoice, MiMoPresetVoice]>

export const presetVoiceGender = (voice: MiMoPresetVoice | undefined): VoiceGender | undefined => {
  if (voice === 'mimo_default' || presetPairs.some(([female]) => female === voice)) {
    return 'female'
  }
  return presetPairs.some(([, male]) => male === voice) ? 'male' : undefined
}

export const presetForGender = (voice: MiMoPresetVoice, gender?: VoiceGender): MiMoPresetVoice => {
  if (!gender || presetVoiceGender(voice) === gender) {
    return voice
  }
  const pair = presetPairs.find(([female, male]) => female === voice || male === voice)
  return pair?.[gender === 'female' ? 0 : 1] ?? DEFAULT_EXTRA_VOICE
}

export const voiceGenderLabel = (gender: VoiceGender) => gender === 'female' ? '女声' : '男声'

const declaredRoleVoice = (
  voice: string,
  fallback: MiMoPresetVoice,
  mayDescribe: boolean,
  gender?: VoiceGender
): Pick<VoiceRole, 'preset' | 'description'> => {
  if (isPresetVoice(voice)) {
    return { preset: presetForGender(voice, gender), description: undefined }
  }
  const describedGender = voiceGenderFromDescription(voice)
  if (voice && mayDescribe && (!gender || !describedGender || gender === describedGender)) {
    return { preset: undefined, description: voice }
  }
  return { preset: presetForGender(fallback, gender ?? describedGender), description: undefined }
}

/** 提示词让模型在没有别名时写「别名：无」「Aliases：none」，这些占位词不是真别名 */
const NO_ALIAS = /^(无|没有|暂无|无别名|none|n\/a|na|-|—|–)$/i

/** 把「别名：林妹妹、颦儿」拆成数组；去空、去重、去掉和主名相同的、去掉占位词 */
const splitAliases = (raw: string, name: string) => {
  if (NO_ALIAS.test(raw.trim())) {
    return []
  }
  const seen = new Set([roleKey(name)])
  const out: string[] = []
  for (const alias of raw.split(/[、,，;；/\r\n]+/)) {
    const item = clean(alias)
    const key = roleKey(item)
    if (key && item.length <= MAX_ROLE_NAME && !item.includes('\0') && !seen.has(key) && !NO_ALIAS.test(item)) {
      seen.add(key)
      out.push(item)
      if (out.length === MAX_ROLE_ALIASES) {
        break
      }
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
    const field = FIELD_KEYS.get(key.toLowerCase())
    if (field) {
      fields.set(field, value)
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
type TagMark = { start: number; end: number; inner: string; incomplete?: true }

const maskInlineCode = (line: string, maskOpenCode: boolean) => {
  const runs = [...line.matchAll(/\x60+/g)]
  if (!runs.length || (runs.length === 1 && !maskOpenCode)) {
    return line
  }
  const nextRun = new Map<number, number>()
  const partners = runs.map(() => -1)
  for (let i = runs.length - 1; i >= 0; i--) {
    const length = runs[i][0].length
    partners[i] = nextRun.get(length) ?? -1
    nextRun.set(length, i)
  }
  let masked = ''
  let cursor = 0
  for (let i = 0; i < runs.length; i++) {
    const start = runs[i].index ?? 0
    let backslashes = 0
    while (line[start - backslashes - 1] === '\\') {
      backslashes++
    }
    const partner = partners[i]
    if (maskOpenCode && partner < 0 && backslashes % 2 === 0) {
      return masked + line.slice(cursor, start) + ' '.repeat(line.length - start)
    }
    if (partner < 0 || backslashes % 2) {
      continue
    }
    const end = (runs[partner].index ?? 0) + runs[partner][0].length
    masked += line.slice(cursor, start) + ' '.repeat(end - start)
    cursor = end
    i = partner
  }
  return masked + line.slice(cursor)
}

/** Ignore code while scanning markers, keeping the original character offsets. */
const maskMarkdownCode = (text: string, maskOpenCode = false) => {
  if (!text.includes('\x60') && !text.includes('~~~')) {
    return text
  }
  let fence = ''
  return text
    .split('\n')
    .map((line) => {
      const marker = /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(line)
      if (fence) {
        if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
          fence = ''
        }
        return ' '.repeat(line.length)
      }
      if (marker && (marker[1][0] === '~' || !marker[2].includes('\x60'))) {
        fence = marker[1]
        return ' '.repeat(line.length)
      }
      return maskInlineCode(line, maskOpenCode)
    })
    .join('\n')
}

/**
 * 扫出所有标注。两条路并用：
 *
 * 1. 括号包裹的（⟦…⟧、⟦…〕、「…」、【…】）：不依赖括号配对，遇到任意收尾字符即结束；
 * 2. 裸行（模型经常干脆不写括号）：整行结构像标注就认。
 *
 * 只靠括号会被模型的各种变体打穿，只靠行结构又会漏掉「⟦旁白⟧台词」这种把台词接在同行的写法，
 * 所以两条都要。
 */
const scanMarks = (value: string, maskOpenCode = false): TagMark[] => {
  const text = maskMarkdownCode(value, maskOpenCode)
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
      if (CLOSERS.has(char) || char === '\n' || char === '\r') {
        break
      }
      cursor += 1
    }
    const closed = cursor < text.length && CLOSERS.has(text[cursor])
    const inner = text.slice(contentStart, cursor)
    const strong = STRONG_OPENERS.has(opener)
    const speaker = speakerLabel.test(inner)
    const hasFields = looksLikeTagLine(inner)
    if (!closed) {
      if (strong || speaker || hasFields || /^(?:语气|tone)\s*[:：]/i.test(inner)) {
        // A broken marker covers only its own line. Keep later prose and speakers.
        const lineStart = text.lastIndexOf('\n', index - 1) + 1
        const lineEnded = cursor === text.length || text[cursor] === '\n' || text[cursor] === '\r'
        const bare = hasFields && lineEnded && !text.slice(lineStart, index).trim()
        marks.push({ start: index, end: cursor, inner, ...(bare ? {} : { incomplete: true }) })
        index = cursor
        continue
      }
      index = contentStart
      continue
    }
    if (!inner.trim()) {
      // 空的生僻括号是模型留下的残渣，照样要剥掉；解析阶段会因为没名字而跳过
      if (strong) {
        marks.push({ start: index, end: cursor + 1, inner })
      }
      index = contentStart
      continue
    }
    const speakerAtLineStart = speaker &&
      !text.slice(text.lastIndexOf('\n', index - 1) + 1, index).trim()
    if (!strong && !speakerAtLineStart && !hasFields) {
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
  const extra: TagMark[] = []
  let offset = 0
  let markIndex = 0
  for (const rawLine of text.split('\n')) {
    const start = offset
    const end = offset + rawLine.length
    offset = end + 1
    // 已有同行括号标注时保留紧跟的台词。
    while (markIndex < marks.length && marks[markIndex].end <= start) {
      markIndex++
    }
    if (!rawLine.trim() || (marks[markIndex]?.start ?? Infinity) < end || !looksLikeTagLine(rawLine)) {
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
    index.set(roleKey(role.name), role)
    for (const alias of role.aliases) {
      if (!index.has(roleKey(alias))) {
        index.set(roleKey(alias), role)
      }
    }
  }
  const names = roles.map((role) => ({ role, name: roleKey(role.name) }))
  return (name) => {
    const key = roleKey(name)
    const exact = index.get(key)
    if (exact) {
      return exact
    }
    // 模型常写简称（黛玉 ↔ 林黛玉、宝玉 ↔ 贾宝玉）。只在唯一命中时归并，
    // 宁可多建一个角色，也不要把两个人错并成一个人。
    if (!/^[\u3400-\u9fff]{2,}$/.test(key)) {
      return undefined
    }
    const candidates = names.filter(
      ({ name: full }) =>
        full !== key &&
        /^[\u3400-\u9fff]+$/.test(full) &&
        (full.endsWith(key) || full.startsWith(key) || key.endsWith(full) || key.startsWith(full))
    )
    const unique = new Set(candidates.map(({ role }) => role.id))
    return unique.size === 1 ? candidates[0].role : undefined
  }
}

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
    /** false = 用户把「主配角音色」设成了预置：模型写的音色描述不采纳，按没写处理，落回预置 */
    allowDescription?: boolean
    includeNarration?: boolean
    speechOnly?: boolean
    narrateUnmarked?: boolean
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
  const revisedRoles = new Map<string, VoiceRole>()
  const resolve = (name: string) => {
    const found = newLookup.get(roleKey(name)) ?? lookup(name)
    return found && (revisedRoles.get(found.id) ?? found)
  }
  const revise = (role: VoiceRole, patch: Partial<VoiceRole>) => {
    const revised = { ...role, ...patch }
    revisedRoles.set(role.id, revised)
    updates.push({ roleId: role.id, patch })
    return revised
  }

  const marks = scanMarks(text, options.speechOnly)
  const speechText = options.speechOnly ? maskMarkdownCode(text, true) : text
  const addSpeech = (roleId: string | null, tone: string, from: number, to: number) => {
    const raw = speechText.slice(from, to)
    const spoken = raw.trim()
    if (spoken) {
      segments.push({
        roleId, tone, text: spoken,
        ...(options.speechOnly && {
          span: { start: from + raw.length - raw.trimStart().length, closed: to < text.length },
        }),
      })
    }
  }
  const addNarration = (from: number, to: number) => {
    if (options.includeNarration && (marks.length || options.narrateUnmarked)) {
      addSpeech(null, '', from, to)
    }
  }
  let plain = ''
  let cursor = 0
  for (const [index, mark] of marks.entries()) {
    // 标记之前的文本照常显示
    const leading = text.slice(cursor, mark.start)
    plain += leading
    addNarration(cursor, mark.start)
    const nextStart = marks[index + 1]?.start ?? text.length
    // 标记之后到下一个标记之前的全部文本都要渲染……
    const rest = text.slice(mark.end, nextStart)
    plain += rest
    cursor = nextStart
    if (mark.incomplete) {
      addNarration(mark.end, nextStart)
      continue
    }
    const { fields, looseName, looseValue } = parseFields(mark.inner)
    const explicit = fields.has('说话人')
    // Only the legacy format uses the first blank line as an implicit narrator transition.
    const trimmed = rest.trimStart()
    const nextParagraph = explicit ? -1 : trimmed.search(/\r?\n[\t ]*\r?\n/)
    const speechEnd = nextParagraph < 0 ? nextStart : mark.end + rest.length - trimmed.length + nextParagraph
    const hasDeclaration = fields.has('新角色') ||
      (explicit && (fields.has('音色') || fields.has('别名') || fields.has('重要性')))
    const name = clean(
      fields.get('说话人') ?? fields.get('新角色') ?? fields.get('角色') ?? fields.get('角色名') ?? fields.get('_bare') ?? looseName
    )
    if (!name || name.length > MAX_ROLE_NAME || name.includes('\0')) {
      addNarration(mark.end, nextStart)
      continue
    }
    const tone = clean(fields.get('语气'))
    const isNarrator = roleKey(name) === NARRATOR
    const declaredGender = isNarrator ? undefined : voiceGenderField(fields.get('声线'))
    let role = resolve(name)
    const gender = role?.voiceGender ?? declaredGender
    if (role?.source === 'model' && !role.voiceGender && declaredGender) {
      // 旧会话可用剧情补记声线，且只校正自动分配的音色。
      const fallback = role.importance === 'extra' ? extraVoice : narratorVoice
      const patch = declaredRoleVoice(
        role.preset ?? role.description ?? '', fallback, Boolean(role.description), declaredGender
      )
      role = revise(role, { ...patch, voiceGender: declaredGender })
    }
    // 没写「新角色」声明、表里也没有：按规划补建，否则模型只写「⟦旁白⟧」时整个功能都失效
    const autoCreate = !role && !hasDeclaration
    if (hasDeclaration || autoCreate) {
      const declaredAliases = splitAliases(fields.get('别名') ?? '', name).filter((alias) => {
        const key = roleKey(alias)
        if (key === NARRATOR || newLookup.has(key)) {
          return false
        }
        const owner = lookup(alias)
        // 同一角色的简称可以从模糊匹配补成正式别名。其他角色占用的称呼保留归属。
        return !owner || (owner.id === role?.id && roleKey(owner.name) !== key &&
          !owner.aliases.some((established) => roleKey(established) === key))
      })
      const declaredNature = clean(fields.get('性格'))
      // 重要性可以写在「重要性：」里，也可以写在「角色名：次要」那一侧
      const importanceWord = (clean(fields.get('重要性')) || looseValue).toLowerCase()
      const importance = isNarrator
        ? 'supporting'
        : (Object.hasOwn(IMPORTANCE_WORDS, importanceWord)
            ? IMPORTANCE_WORDS[importanceWord]
            : (role?.importance ?? 'extra'))
      const taggedVoice = clean(fields.get('音色'))
      const declaredVoice = !isNarrator || isPresetVoice(taggedVoice) ? taggedVoice : ''
      if (role) {
        if (declaredAliases.length) {
          aliasAdditions.push({ roleId: role.id, aliases: declaredAliases })
          for (const alias of declaredAliases) {
            newLookup.set(roleKey(alias), role)
          }
        }
        if (role.source === 'model') {
          const level = RANK[importance] > RANK[role.importance] ? importance : role.importance
          const patch: Partial<VoiceRole> = {}
          if (!role.description && declaredVoice) {
            const mayDescribe = allowDescription && !isNarratorRole(role) && level !== 'extra'
            const fallback = level === 'extra' ? extraVoice : narratorVoice
            const voice = declaredRoleVoice(declaredVoice, fallback, mayDescribe, gender)
            if (voice.description || (!role.nature && (mayDescribe || isPresetVoice(declaredVoice)))) {
              Object.assign(patch, voice)
            }
          }
          if (!role.nature && declaredNature) {
            patch.nature = declaredNature
          }
          if (level !== role.importance) {
            promotions.push({ roleId: role.id, to: level })
            role = { ...role, importance: level }
            revisedRoles.set(role.id, role)
          }
          if (Object.keys(patch).length) {
            revise(role, patch)
          }
        }
      } else {
        if (autoCreate) {
          unknownNames.push(name)
        }
        // 旁白和路人只能用预置；主角/次要可以写描述——除非用户选择了预置模式
        const mayDescribe = allowDescription && !isNarrator && importance !== 'extra'
        const fallback = importance === 'extra' ? extraVoice : narratorVoice
        const created: VoiceRole = {
          id: `role-${now}-${newRoles.length}-${name}`,
          name,
          aliases: declaredAliases,
          ...(gender && { voiceGender: gender }),
          nature: declaredNature || (isNarrator ? (name === NARRATOR ? '冷静客观' : 'calm and objective') : ''),
          importance,
          source: 'model',
          createdAt: now,
          ...declaredRoleVoice(declaredVoice, fallback, mayDescribe, gender),
        }
        newRoles.push(created)
        newLookup.set(roleKey(name), created)
        for (const alias of declaredAliases) {
          newLookup.set(roleKey(alias), created)
        }
        role = created
      }
    } else if (!role) {
      continue
    }
    if (role) {
      addSpeech(role.id, tone, mark.end, speechEnd)
    }
    addNarration(speechEnd, nextStart)
  }
  plain += text.slice(cursor)
  addNarration(cursor, text.length)

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

/** 渲染用：隐藏标注，并保留后续段落。 */
export const stripRoleMarkers = (text: string) => {
  if (!/[｜|]/.test(text) && !OPENERS.some((opener) => text.includes(opener))) {
    return text
  }
  const marks = scanMarks(text)
  let out = ''
  let cursor = 0
  for (const mark of marks) {
    out += text.slice(cursor, mark.start)
    cursor = mark.end
  }
  return out + text.slice(cursor)
}

export const hasRoleMarkers = (text: string) => scanMarks(text).some(({ incomplete }) => !incomplete)

export const isNarratorRole = (role: Pick<VoiceRole, 'name'>) => roleKey(role.name) === NARRATOR
export const NARRATOR_NAME = NARRATOR
