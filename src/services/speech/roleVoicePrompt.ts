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
 * 规则段跟着用户的「主配角音色」设置变：
 *   预置 —— 所有角色都从 8 个预置里选，不写描述（描述要走整段合成完才出声的模型）；
 *   描述 —— 主角和次要角色都写一句贴合人物的音色描述。
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

const exampleVoiceZh = (leadVoice: LeadVoiceMode) =>
  leadVoice === 'description' ? '年轻女声，清亮纤细，说话轻缓' : '茉莉'
const exampleVoiceEn = (leadVoice: LeadVoiceMode) =>
  leadVoice === 'description' ? 'A clear young female voice with a gentle pace' : 'Chloe'

const declarationZh = (voice: string) =>
  `「说话人：林黛玉｜别名：林妹妹、颦儿｜声线：女声｜音色：${voice}｜性格：多愁善感，说话轻柔｜重要性：主角」`

/** 硬性要求第 3 条的后半段：谁能写描述 */
const voiceRuleZh = (leadVoice: LeadVoiceMode) =>
  leadVoice === 'description'
    ? `主角和次要角色都用一句话描述音色，例如「沉稳的青年男声，声音明亮，咬字有力，语速略快」。结合人物设定给出有区分度的音质、语速和表达习惯，描述中不可使用 ｜。
    旁白、路人从下列预置中挑选，原样照抄。${PICK_LANGUAGE_ZH}：
    ${PRESETS_ZH}
    主角和次要角色已有自动分配的预置音色时，可在本轮首次出场补充描述，让角色音色更贴合设定。`
    : `所有角色的音色都必须从下面 8 个里选一个，原样照抄，不要写音色描述。${PICK_LANGUAGE_ZH}：
    ${PRESETS_ZH}`

const rulesZh = (leadVoice: LeadVoiceMode) => `【朗读标注】
这个回答会被逐段朗读。有角色说话时，先单独起一行写标注，台词写在下面：

「说话人：角色名｜语气：这一段的情绪」
台词内容

角色第一次出场要先声明声音，声明写在同一行标注里：
${declarationZh(exampleVoiceZh(leadVoice))}

完整示例如下（照这个格式写，不要自创别的写法）：

${declarationZh(exampleVoiceZh(leadVoice))}
我先进去看看。

「说话人：贾宝玉｜别名：宝玉｜声线：男声｜音色：${leadVoice === 'description' ? '明亮温润的青年男声，语速轻快，尾音柔和' : '苏打'}｜性格：热心直率｜重要性：主角」
我陪你一起进去。

「说话人：贾母｜别名：老祖宗｜声线：女声｜音色：${leadVoice === 'description' ? '慈和的老年女声，音质温厚，吐字从容' : '冰糖'}｜性格：慈爱果断｜重要性：次要」
快来，到我跟前坐。

「说话人：旁白｜语气：平稳叙述」
她抬眼四下一望，满屋的器物都精致非常。

「说话人：林黛玉｜语气：心中一惊」
这些人个个皆敛声屏气，这来者是谁？

硬性要求：
1. 标注必须用「」包住，字段之间用 ｜ 分隔。不要用 ⟦⟧、【】、[] 等别的括号，也不要省略括号。
2. 标注单独占一行，第一项必须是「说话人：名字」。台词从下一行开始，直到下一个标注都属于同一说话人，空行也不换人。
3. 角色首次出场的标注填写别名、声线、音色、性格和重要性。没有别名时写「别名：无」。
   根据用户的人设和故事设定填写「声线：女声」或「声线：男声」，预置音色和音色描述必须与声线一致。设定不明确时写「声线：未指定」，不能只凭名字推断。
   ${voiceRuleZh(leadVoice)}
4. 已出场的角色沿用既定声线和已设定的音色，普通台词写「说话人：角色名｜语气：…」。需要补充声线、描述音色、重要性或别名时，用已有角色的名字，在本轮第一次标注中写上对应字段。
5. 语气写这一段的实际情绪，可以每段不同，但要在这个角色的性格之内。
6. 重要性三选一：主角（推动故事主线的中心人物，可以同时有多个）、次要（有明确身份或戏份的配角）、路人（短暂露脸的角色）。以用户的人设和故事全局为准，旁白写「次要」。
7. 已有角色新增昵称或更正称呼时，在同一角色的标注里写「说话人：已有角色名｜别名：新的或更正后的称呼」。下文可以直接使用该别名。别名仅补充，遇到另一个角色已经使用的姓名或别名时，保持两人各自的称呼。
8. 故事、小说里没有人说话的叙述段落，用「说话人：旁白｜语气：…」标注，它们也要朗读。
   普通问答、说明文、代码，以及完全不是在讲故事的回答，绝对不要加任何标注，也不要写上面的格式。

再次强调：标注只有「」一种括号，且必须独立成行。`

const declarationEn = (voice: string) =>
  `「Speaker：Lin Daiyu｜Aliases：Lin Meimei, Pin'er｜Voice gender：female｜Voice：${voice}｜Nature：sentimental, speaks softly｜Importance：lead」`

const voiceRuleEn = (leadVoice: LeadVoiceMode) =>
  leadVoice === 'description'
    ? `Leads and supporting characters each get a one-line voice description based on their profile. Describe distinct vocal texture, pace, and delivery. For example, 「a warm, clear young male voice with a quick pace」. Keep ｜ out of the description.
    Narrators and extras use one of these presets, copied exactly. ${PICK_LANGUAGE_EN}:
    ${PRESETS_EN}
    A lead or supporting character with an automatically assigned preset can get a description in their first tag in this reply.`
    : `Every character's voice must be one of these 8 names, copied exactly — never a description. ${PICK_LANGUAGE_EN}:
    ${PRESETS_EN}`

const rulesEn = (leadVoice: LeadVoiceMode) => `[Read-aloud tags]
This reply is read aloud segment by segment. When a character speaks, put a tag on its own line, then the line below:

「Speaker: character name｜Tone: the emotion of this line」
the line itself

A character declares its voice the first time it appears, in the same tag line:
${declarationEn(exampleVoiceEn(leadVoice))}

Full example (follow exactly this shape; do not invent another):

${declarationEn(exampleVoiceEn(leadVoice))}
I'll go in first and see.

「Speaker: Jia Baoyu｜Aliases: Baoyu｜Voice gender: male｜Voice: ${leadVoice === 'description' ? 'A bright, warm young male voice with a quick pace' : 'Milo'}｜Nature: frank and caring｜Importance: lead」
I'll go in with you.

「Speaker: Grandmother Jia｜Aliases: none｜Voice gender: female｜Voice: ${leadVoice === 'description' ? 'A warm older female voice, unhurried with clear diction' : 'Mia'}｜Nature: kind and decisive｜Importance: supporting」
Come, take a seat beside me.

「Speaker: Narrator｜Tone: calm narration」
She glanced around; every object was exquisite.

「Speaker: Lin Daiyu｜Tone: startled」
Everyone here holds their breath — who is this?

Hard requirements:
1. Tags must be wrapped in 「」 with ｜ between fields. Do not use ⟦⟧, 【】, [] or any other bracket, and never omit the brackets.
2. A tag occupies its own line and starts with Speaker: name. All text up to the next tag belongs to that speaker, including across blank lines.
3. Introduce each new character with name, aliases, voice gender, voice, nature and importance. Write 「Aliases：none」 when there are none.
   Use 「Voice gender：female」 or 「Voice gender：male」 if established by the user's character profile or story. Match the preset or voice description to it. If unclear, write 「Voice gender：unspecified」. Do not infer it from the name alone.
   ${voiceRuleEn(leadVoice)}
4. Keep each character’s established voice and use 「Speaker: Name｜Tone: …」. Use their existing name and add the relevant field to their first tag in this reply when supplying a voice gender, voice description, importance, or alias.
5. The tone is the actual emotion of this line. It may change per line but must stay within the character's nature.
6. Importance is one of: lead, supporting, extra. Mark as many leads as the story calls for. Leads drive the central plot, supporting characters have a defined part, and extras appear briefly. The narrator is supporting.
7. When a nickname appears or a spelling is corrected, use 「Speaker: Existing name｜Aliases: new or corrected name」. Later tags can use the new alias. Keep established names and use an alias only if it belongs to that character.
8. In a story or a novel, tag narration as 「Speaker: Narrator｜Tone: …」.
   Never add any tag to ordinary Q&A, explanations, code, or a reply that is not telling a story at all.

Again: 「」 is the only bracket for tags, and a tag always occupies its own line.`

const ROLES_HEADER_ZH = '【已定角色】沿用已有角色和音色，依上面的规则补充资料。标为「用户设定」的音色保持原样：'
const ROLES_HEADER_EN =
  '[Established characters] Keep the cast and established voices. Follow the rules above when adding details. Preserve user-chosen voices:'

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
