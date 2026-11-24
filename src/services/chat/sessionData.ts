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

export const mapSessionFileIds = (session: Session, mapId: (id: string) => string): Session => {
  let changed = false
  const mapFiles = <T extends FileAttachment>(files: T[]) =>
    files.map((file) => {
      const id = mapId(file.id)
      if (id === file.id) {
        return file
      }
      changed = true
      return { ...file, id }
    })
  const mapped = mapSessionMessages(session, (message) => {
    if (message.role === 'user' && message.files.length) {
      return { ...message, files: mapFiles(message.files) }
    }
    if (message.role === 'assistant' && message.task?.artifacts.length) {
      return { ...message, task: { ...message.task, artifacts: mapFiles(message.task.artifacts) } }
    }
    return message
  })
  return changed ? mapped : session
}
