import { Capacitor, registerPlugin } from '@capacitor/core'

const NativePhoto = registerPlugin<{
  take: () => Promise<{ cancelled?: true; id?: string; path?: string; size?: number }>
  release: (input: { id: string }) => Promise<void>
}>('PhotoCapture')

export const isAndroidCamera = () => Capacitor.getPlatform() === 'android'

export const takeAndroidPhoto = async (): Promise<File | null> => {
  const response = await NativePhoto.take()
  if (response.cancelled) {
    return null
  }
  const { id, path, size } = response
  try {
    if (!id || !path || !size) {
      throw new Error('Camera did not return a photo')
    }
    const local = await fetch(Capacitor.convertFileSrc(path))
    if (!local.ok) {
      throw new Error('Cannot read camera output')
    }
    const blob = await local.blob()
    if (blob.size !== size) {
      throw new Error('Incomplete camera output')
    }
    return new File([blob], '照片-' + Date.now() + '.jpg', { type: 'image/jpeg' })
  } finally {
    if (id) {
      await NativePhoto.release({ id }).catch(() => {})
    }
  }
}
