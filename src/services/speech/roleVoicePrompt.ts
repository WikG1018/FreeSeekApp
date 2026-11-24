import type { MiMoPresetVoice, VoiceRole } from './roleMarkers.js'
import { formatRolesForPrompt } from './roleTable.js'

/**
 * 角色配音的系统提示词。三段各管一件事：
 *   1. 规则段   —— 标注格式与规则（开关开且是聊天模式才加）
 *   2. 角色表段 —— 本作品已定角色（有角色才加）
 *   3. 风格指令 —— 每段请求 TTS 时拼，见 roleTable.styleInstruction
 *
 * 标注是「可选」的：普通问答不加，这样开着开关问天气也不会被强行配音；
 * 兜底也自然——没有标记就当普通朗读。
 *
 * 规则段跟着用户的「主角默认音色」设置变：
 *   预置 —— 所有角色都从 9 个预置里选，不写描述（描述要走整段合成完才出声的模型）；
 *   描述 —— 主角写一句音色描述，次要两种都可以。
 * 示例里的音色也跟着变：模型最会照抄的是示例，示例和规则对不上等于没写规则。
 */

export type LeadVoiceMode = 'preset' | 'description'

/**
 * 预置音色清单，按语言分组——和编辑弹窗里的听感描述一致。
 * 平铺成一列不说语言的话，实测模型会给中文角色挑英文音色（让 Dean、Milo 念中文台词）。
 * 只列应用音色目录里有的 8 个：模型选了目录外的音色，编辑弹窗里显示不出、也选不回去。
 */
const PRESETS_ZH = '中文女声：冰糖、茉莉；中文男声：苏打、白桦；英文女声：Mia、Chloe；英文男声：Milo、Dean'
const PRESETS_EN = 'Chinese female: 冰糖, 茉莉; Chinese male: 苏打, 白桦; English female: Mia, Chloe; English male: Milo, Dean'
const PICK_LANGUAGE_ZH = '角色说中文就用中文音色，说英文就用英文音色'
const PICK_LANGUAGE_EN =
  'A character who speaks Chinese gets a Chinese voice, one who speaks English gets an English voice'

/** 示例里林黛玉的音色 */
const exampleVoice = (leadVoice: LeadVoiceMode) =>
  leadVoice === 'description' ? '年轻女声，清亮纤细，说话轻缓' : '茉莉'

const declarationZh = (voice: string) =>
  `「新角色：林黛玉｜别名：林妹妹、颦儿｜音色：${voice}｜性格：多愁善感，说话轻柔｜重要性：主角」`

/** 硬性要求第 3 条的后半段：谁能写描述 */
const voiceRuleZh = (leadVoice: LeadVoiceMode) =>
  leadVoice === 'description'
    ? `音色必须从下面 8 个里选一个，原样照抄。${PICK_LANGUAGE_ZH}：
    ${PRESETS_ZH}
    主角要用一句话描述音色来代替（例如「低沉沙哑的中年男声，语速慢」，描述里不能有 ｜），次要角色两种都可以。
    旁白和路人的音色只能从这 8 个里选。`
    : `所有角色的音色都必须从下面 8 个里选一个，原样照抄，不要写音色描述。${PICK_LANGUAGE_ZH}：
    ${PRESETS_ZH}`

const rulesZh = (leadVoice: LeadVoiceMode) => `【朗读标注】
这个回答会被逐段朗读。有角色说话时，先单独起一行写标注，台词写在下面：

「角色｜语气：这一段的情绪」
台词内容

角色第一次出场要先声明声音，声明写在同一行标注里：
${declarationZh(exampleVoice(leadVoice))}

完整示例如下（照这个格式写，不要自创别的写法）：

${declarationZh(exampleVoice(leadVoice))}
黛玉进了房门，步步留心。

「旁白｜语气：平稳叙述」
她抬眼四下一望，满屋的器物都精致非常。

「林黛玉｜语气：心中一惊」
这些人个个皆敛声屏气，这来者是谁？

硬性要求：
1. 标注必须用「」包住，字段之间用 ｜ 分隔。不要用 ⟦⟧、【】、[] 等别的括号，也不要省略括号。
2. 标注单独占一行；台词从下一行开始。
3. 角色第一次出场必须写完整声明，五个字段都要有：新角色、别名、音色、性格、重要性。
   别名没有就写「别名：无」。${voiceRuleZh(leadVoice)}
4. 已出场的角色只写「角色名｜语气：…」，不要重复音色、别名、性格。
5. 语气写这一段的实际情绪，可以每段不同，但要在这个角色的性格之内。
6. 重要性三选一：主角（这段故事的中心人物，一场戏里台词最多的角色就是主角）、次要（有名字有戏份的配角）、路人（只出场一两次的店小二、路人甲）。旁白写「次要」。
7. 角色的名字和别名要和正文里出现的称呼对得上；后面用简称时，用别名里列过的写法。
8. 故事、小说里没有人说话的叙述段落，用「旁白｜语气：…」标注，它们也要朗读。
   普通问答、说明文、代码，以及完全不是在讲故事的回答，绝对不要加任何标注，也不要写上面的格式。

再次强调：标注只有「」一种括号，且必须独立成行。`

const declarationEn = (voice: string) =>
  `「New character：Lin Daiyu｜Aliases：Lin Meimei, Pin'er｜Voice：${voice}｜Nature：sentimental, speaks softly｜Importance：lead」`

const voiceRuleEn = (leadVoice: LeadVoiceMode) =>
  leadVoice === 'description'
    ? `The voice must be one of these 8 names, copied exactly. ${PICK_LANGUAGE_EN}:
    ${PRESETS_EN}
    A lead uses a one-line voice description instead (for example 「a low, raspy middle-aged male voice, slow」; no ｜ inside the description). A supporting character may use either.
    The narrator and extras must pick from the 8 presets.`
    : `Every character's voice must be one of these 8 names, copied exactly — never a description. ${PICK_LANGUAGE_EN}:
    ${PRESETS_EN}`

const rulesEn = (leadVoice: LeadVoiceMode) => `[Read-aloud tags]
This reply is read aloud segment by segment. When a character speaks, put a tag on its own line, then the line below:

「Character｜Tone: the emotion of this line」
the line itself

A character declares its voice the first time it appears, in the same tag line:
${declarationEn(exampleVoice(leadVoice))}

Full example (follow exactly this shape; do not invent another):

${declarationEn(exampleVoice(leadVoice))}
Daiyu entered the room, careful at every step.

「旁白｜Tone: calm narration」
She glanced around; every object was exquisite.

「Lin Daiyu｜Tone: startled」
Everyone here holds their breath — who is this?

Hard requirements:
1. Tags must be wrapped in 「」 with ｜ between fields. Do not use ⟦⟧, 【】, [] or any other bracket, and never omit the brackets.
2. A tag occupies its own line; the line starts on the next line.
3. The first appearance of a character must carry a full declaration with all five fields:
   new character, aliases, voice, nature, importance. Write 「Aliases：none」 when there are none.
   ${voiceRuleEn(leadVoice)}
4. A character that already appeared uses only 「Name｜Tone: …」 — no voice, aliases or nature again.
5. The tone is the actual emotion of this line. It may change per line but must stay within the character's nature.
6. Importance is one of: 主角 (lead), 次要 (supporting), 路人 (extra). The lead is the character the story is about — in a scene, whoever has the most lines is a lead. The narrator is 次要.
7. Character names and aliases must match the names used in the prose; when using a short form later, use one listed in the aliases.
8. In a story or a novel, narration where no one is speaking is tagged 「旁白｜Tone: …」 — it is read aloud too.
   Never add any tag to ordinary Q&A, explanations, code, or a reply that is not telling a story at all.

Again: 「」 is the only bracket for tags, and a tag always occupies its own line.`

const ROLES_HEADER_ZH = '【已定角色】以下是本作品中已确定的角色。直接使用，不要重新设计他们的音色：'
const ROLES_HEADER_EN =
  '[Established characters] These characters are already set in this work. Use them as-is and do not redesign their voices:'

/** 新角色声明里用中文的「主角/次要/路人」，英文界面也用这几个词，解析器两种都认 */
export const roleVoiceRules = (locale: string, leadVoice: LeadVoiceMode) =>
  locale === 'en-US' ? rulesEn(leadVoice) : rulesZh(leadVoice)

export const roleVoicePrompt = (
  locale: string,
  roles: ReadonlyArray<VoiceRole>,
  options: { extrasShareVoice: boolean; extraVoice: MiMoPresetVoice; leadVoice: LeadVoiceMode }
): string => {
  const table = formatRolesForPrompt(roles, options)
  const header = locale === 'en-US' ? ROLES_HEADER_EN : ROLES_HEADER_ZH
  return [roleVoiceRules(locale, options.leadVoice), table && `${header}\n${table}`]
    .filter(Boolean)
    .join('\n\n')
}
