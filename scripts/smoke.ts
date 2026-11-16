/**
 * 核心逻辑冒烟测试：对话接续的上下文注入。
 * 运行：npx -y tsx scripts/smoke.ts
 * reply.ts 是纯函数模块（仅 type imports），可在 Node 中直接执行。
 */
import assert from 'node:assert/strict'
import { getContextRounds, toRequestMessages } from '../src/services/chat/reply.ts'
import type { AssistantMessage, Message, UserMessage } from '../src/services/chat/types.ts'

const user = (id: string, content: string): UserMessage => ({
  id,
  role: 'user',
  content,
  files: [],
  createdAt: Date.now(),
})

const reply = (id: string, text: string): AssistantMessage => ({
  id,
  role: 'assistant',
  createdAt: Date.now(),
  model: null,
  prefix: true,
  status: 'done',
  stopReason: 'end_turn',
  blocks: [{ type: 'text', text }],
})

const userText = (p: (typeof params)[number]): string =>
  p.role === 'user' ? (p.content as string) : ''
const assistantText = (p: (typeof params)[number]): string =>
  p.role === 'assistant' && Array.isArray(p.content)
    ? ((p.content as { type: 'text'; text: string }[])[0]?.text ?? '')
    : ''

// --- 用例 1：继承轮次置于本会话历史之前，最后是本轮提问 ---
const inherited: Message[] = [user('iu1', '继承的问题一'), reply('ia1', '继承的回答一')]
const history: Message[] = [user('hu1', '本会话的问题一'), reply('ha1', '本会话的回答一')]
const question = user('qu1', '新问题')

const params = toRequestMessages(history, question, undefined, false, undefined, inherited)
assert.deepEqual(
  params.map((p) => p.role),
  ['user', 'assistant', 'user', 'assistant', 'user'],
  '角色顺序应为 继承轮次 → 本会话轮次 → 本轮提问'
)
assert.equal(userText(params[0]), '继承的问题一')
assert.equal(assistantText(params[1]), '继承的回答一')
assert.equal(userText(params[2]), '本会话的问题一')
assert.equal(assistantText(params[3]), '本会话的回答一')
assert.equal(userText(params[4]), '新问题')

// --- 用例 2：不传继承上下文时行为与原版一致 ---
const plain = toRequestMessages(history, question)
assert.equal(plain.length, 3, '无继承时只有本会话一轮 + 提问')

// --- 用例 3：不可用的回复（报错/无文本）不进入上下文 ---
const broken: Message[] = [
  user('bu1', '坏问题'),
  { ...reply('ba1', ''), status: 'error' },
  user('bu2', '好问题'),
  reply('ba2', '好回答'),
]
const rounds = getContextRounds(broken)
assert.equal(rounds.length, 1, '报错轮次被剔除')
assert.equal(rounds[0][0].content, '好问题')

// --- 用例 4：继承的坏轮次同样被剔除 ---
const mixedInherited: Message[] = [
  user('mu1', '坏继承问题'),
  { ...reply('ma1', ''), status: 'error' },
  user('mu2', '好继承问题'),
  reply('ma2', '好继承回答'),
]
const mixed = toRequestMessages([], question, undefined, false, undefined, mixedInherited)
assert.equal(mixed.length, 3, '剔除后只剩一对继承轮次 + 提问')
assert.equal(userText(mixed[0]), '好继承问题')
assert.equal(assistantText(mixed[1]), '好继承回答')

console.log('smoke: all 4 cases passed ✓')
