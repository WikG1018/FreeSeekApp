import type { FileAttachment, Message, Session } from './types.js'
import type { VoiceRole } from '../speech/roleMarkers.js'

export const messageFiles = (message: Message): FileAttachment[] =>
  message.role === 'user' ? message.files : (message.task?.artifacts ?? [])

/** 本会话和继承快照共用附件生命周期与重传规则。 */
export const allSessionMessages = (session: Session): Message[] => [
  ...(session.inherited?.messages ?? []),
  ...session.messages,
]

export const sessionOriginalIds = (session: Session): string[] => [
  ...new Set([
    ...allSessionMessages(session).flatMap((message) => messageFiles(message).map(({ id }) => id)),
    ...(session.voiceRoles ?? []).flatMap((role) => role.voiceSample ? [role.voiceSample.id] : []),
    ...(session.inherited?.voiceRoles ?? []).flatMap((role) => role.voiceSample ? [role.voiceSample.id] : []),
  ]),
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
  const mapRoles = (roles?: VoiceRole[]) => roles?.map((role) => {
    if (!role.voiceSample) {
      return role
    }
    const id = mapId(role.voiceSample.id)
    if (id === role.voiceSample.id) {
      return role
    }
    changed = true
    return { ...role, voiceSample: { ...role.voiceSample, id } }
  })
  const voiceRoles = mapRoles(mapped.voiceRoles)
  const inheritedRoles = mapRoles(mapped.inherited?.voiceRoles)
  return changed ? {
    ...mapped,
    ...(voiceRoles && { voiceRoles }),
    ...(mapped.inherited && inheritedRoles && {
      inherited: { ...mapped.inherited, voiceRoles: inheritedRoles },
    }),
  } : session
}
