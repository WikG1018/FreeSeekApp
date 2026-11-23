import { registerPlugin } from '@capacitor/core'
import { blobBase64 } from '../utils/blobBase64.js'
import { beginDiagnosticOperation, diagnosticError } from './diagnostics/log.js'

const Native = registerPlugin<{
  create(options: {
    fileName: string
    size: number
    artifact: boolean
    open: boolean
  }): Promise<{ id: string }>
  write(options: { id: string; data: string }): Promise<void>
  finish(options: { id: string }): Promise<{ launched: boolean }>
  cancel(options: { id: string }): Promise<void>
}>('DiagnosticShare')

export const shareAndroidFile = async (
  name: string,
  blob: Blob,
  artifact: boolean,
  open = false
) => {
  const finish = beginDiagnosticOperation(artifact ? 'chat' : 'diagnostics', 'share', {
    bytes: blob.size,
    native: true,
  })
  let stage = 'prepare'
  let id: string | undefined
  let writtenBytes = 0
  try {
    id = (await Native.create({ fileName: name, size: blob.size, artifact, open })).id
    stage = 'write'
    for (let start = 0; start < blob.size; start += 256 * 1024) {
      const part = blob.slice(start, start + 256 * 1024)
      await Native.write({ id, data: await blobBase64(part) })
      writtenBytes += part.size
    }
    stage = 'chooser'
    const { launched } = await Native.finish({ id })
    finish(launched ? 'completed' : 'cancelled', { stage, writtenBytes })
    return launched
  } catch (error) {
    if (id) {
      await Native.cancel({ id }).catch(() => {})
    }
    finish('failed', { stage, writtenBytes, ...diagnosticError(error) })
    throw error
  }
}
