import { Capacitor } from '@capacitor/core'
import { shareAndroidFile } from '../androidShare.js'
import { saveBackup } from '../saveBackup.js'
import type { Message } from '../chat/types.js'
import type { TaskArtifact } from './tools.js'

declare global {
  interface Window {
    freeseekCopyTaskOutput?: (options: { name: string; bytes: Uint8Array }) => Promise<void>
    freeseekOpenTaskOutput?: (options: { name: string; bytes: Uint8Array }) => Promise<void>
  }
}

export type SessionArtifact = TaskArtifact & { createdAt: number; round?: number }

export const conversationRounds = (messages: readonly Message[]): ReadonlyMap<string, number> => {
  const pending = new Map(
    messages.map((message, index) => [
      message.id,
      {
        message,
        parentId: message.parentId === undefined ? messages[index - 1]?.id : message.parentId,
      },
    ])
  )
  const rounds = new Map<string, number>()
  for (const message of messages) {
    const ancestors: Message[] = []
    let id: string | null | undefined = message.id
    while (id) {
      const node = pending.get(id)
      if (!node) {
        break
      }
      ancestors.push(node.message)
      pending.delete(id)
      id = node.parentId
    }
    // Imported messages can be out of chronological order. Resolve parents before children.
    let round = id ? (rounds.get(id) ?? 0) : 0
    for (const ancestor of ancestors.reverse()) {
      round += ancestor.role === 'user' ? 1 : 0
      rounds.set(ancestor.id, round)
    }
  }
  return rounds
}

export const sessionArtifacts = (
  messages: readonly Message[],
  rounds = conversationRounds(messages)
): SessionArtifact[] => {
  const files = new Map<string, SessionArtifact>()
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const file of message.task?.artifacts ?? []) {
        files.set(file.id, {
          ...file,
          createdAt: file.createdAt ?? message.createdAt,
          round: rounds.get(message.id) || undefined,
        })
      }
    }
  }
  // Later-generated files with the same millisecond are shown before earlier ones.
  return [...files.values()].reverse().sort((a, b) => b.createdAt - a.createdAt)
}

export const shareTaskOutput = async (name: string, blob: Blob) => {
  if (Capacitor.getPlatform() === 'android') {
    return (await shareAndroidFile(name, blob, true)) ? 'opened' : 'cancelled'
  }
  if (window.freeseekCopyTaskOutput) {
    await window.freeseekCopyTaskOutput({ name, bytes: new Uint8Array(await blob.arrayBuffer()) })
    return 'copied'
  }
  const file = new File([blob], name, { type: blob.type })
  if (!navigator.share || !navigator.canShare?.({ files: [file] })) {
    return 'unavailable'
  }
  try {
    await navigator.share({ files: [file] })
    return 'opened'
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return 'cancelled'
    }
    throw error
  }
}

export const openTaskOriginal = async (name: string, blob: Blob) => {
  if (Capacitor.getPlatform() === 'android') {
    return shareAndroidFile(name, blob, true, true)
  }
  if (window.freeseekOpenTaskOutput) {
    await window.freeseekOpenTaskOutput({ name, bytes: new Uint8Array(await blob.arrayBuffer()) })
    return true
  }
  return saveBackup(name, blob, 'chat')
}
