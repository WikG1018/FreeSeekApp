import type { FileAttachment, Message, Session } from './types.js'

export const messageFiles = (message: Message): FileAttachment[] =>
  message.role === 'user' ? message.files : (message.task?.artifacts ?? [])

/** 本会话和继承快照共用附件生命周期与重传规则。 */
export const allSessionMessages = (session: Session): Message[] => [
  ...(session.inherited?.messages ?? []),
  ...session.messages,
]

export const mapSessionMessages = (
  session: Session,
  map: (message: Message) => Message
): Session => ({
  ...session,
  messages: session.messages.map(map),
  ...(session.inherited
    ? { inherited: { ...session.inherited, messages: session.inherited.messages.map(map) } }
    : {}),
})
