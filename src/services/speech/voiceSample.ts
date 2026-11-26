import { ApiError } from '../api/client.js'
import { synthesizeMiMo, TTS_SAMPLE_RATE, type MiMoSpeechProfile } from '../api/speech.js'
import { loadFile } from '../chat/db.js'
import { MAX_ROLE_SAMPLE_BYTES, type RoleVoiceSample } from './roleMarkers.js'

const WAV_HEADER = 44

/** Store a short synthetic reference as 24 kHz mono WAV, which the clone endpoint accepts. */
export const generateRoleVoiceSample = async (
  profile: MiMoSpeechProfile,
  text: string,
  description: string,
  style: string,
  signal: AbortSignal
) => {
  const stream = await synthesizeMiMo({ profile, text, description, style, signal })
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const result = await reader.read()
      if (result.done) {
        break
      }
      length += result.value.length
      if (length + WAV_HEADER > MAX_ROLE_SAMPLE_BYTES) {
        throw new ApiError('protocol', { key: 'roleVoiceSampleTooLong' })
      }
      chunks.push(result.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  signal.throwIfAborted()
  if (!length || length % 2) {
    throw new ApiError('protocol', { key: 'ttsInvalidAudio' })
  }
  const bytes = new Uint8Array(WAV_HEADER + length)
  const view = new DataView(bytes.buffer)
  const ascii = new TextEncoder()
  bytes.set(ascii.encode('RIFF'), 0)
  view.setUint32(4, length + 36, true)
  bytes.set(ascii.encode('WAVEfmt '), 8)
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, TTS_SAMPLE_RATE, true)
  view.setUint32(28, TTS_SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  bytes.set(ascii.encode('data'), 36)
  view.setUint32(40, length, true)
  let offset = WAV_HEADER
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return new Blob([bytes], { type: 'audio/wav' })
}

const readWave = async (sample: Blob) => {
  if (sample.size <= WAV_HEADER || sample.size > MAX_ROLE_SAMPLE_BYTES) {
    throw new ApiError('protocol', { key: 'ttsInvalidAudio' })
  }
  const bytes = await sample.arrayBuffer()
  const view = new DataView(bytes)
  if (
    bytes.byteLength <= WAV_HEADER || bytes.byteLength > MAX_ROLE_SAMPLE_BYTES ||
    view.getUint32(0) !== 0x52494646 || view.getUint32(8) !== 0x57415645 ||
    view.getUint32(36) !== 0x64617461 || view.getUint32(40, true) !== bytes.byteLength - WAV_HEADER ||
    view.getUint32(24, true) !== TTS_SAMPLE_RATE || view.getUint16(34, true) !== 16 ||
    view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 || bytes.byteLength % 2
  ) {
    throw new ApiError('protocol', { key: 'ttsInvalidAudio' })
  }
  return bytes
}

export const voiceSamplePcm = async (sample: Blob): Promise<ReadableStream<Uint8Array>> => {
  const bytes = await readWave(sample)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes, WAV_HEADER))
      controller.close()
    },
  })
}

export const loadRoleVoiceSample = async (ref: RoleVoiceSample) => {
  if (ref.size <= WAV_HEADER || ref.size > MAX_ROLE_SAMPLE_BYTES) {
    throw new ApiError('protocol', { key: 'roleVoiceSampleMissing' })
  }
  const sample = await loadFile(ref.id)
  if (!sample || sample.type !== 'audio/wav' || sample.size !== ref.size) {
    throw new ApiError('protocol', { key: 'roleVoiceSampleMissing' })
  }
  return sample
}

export const roleVoiceDataUrl = async (ref: RoleVoiceSample, signal: AbortSignal) => {
  const sample = await loadRoleVoiceSample(ref)
  const bytes = new Uint8Array(await readWave(sample))
  signal.throwIfAborted()
  const parts: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 8_192)))
  }
  return 'data:audio/wav;base64,' + btoa(parts.join(''))
}
