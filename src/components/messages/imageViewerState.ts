import { create } from 'zustand'
import { logEvent } from '../../services/diagnostics/log.js'

export type PreviewImage = {
  src: string
  name: string
  width: number
  height: number
  thumbnail: HTMLButtonElement
}

export const useImageViewer = create<{ image: PreviewImage | null; ownsUrl: boolean }>(() => ({
  image: null,
  ownsUrl: false,
}))

export const showImageViewer = (src: string, name: string, thumbnail: HTMLButtonElement) => {
  const img = thumbnail.querySelector('img')
  if (!img?.naturalWidth || useImageViewer.getState().image) {
    return
  }
  useImageViewer.setState({
    image: { src, name, thumbnail, width: img.naturalWidth, height: img.naturalHeight },
  })
  logEvent('ui', 'image-viewer.opened', { width: img.naturalWidth, height: img.naturalHeight })
}

// Reuse the decoded thumbnail source. If the message scrolls out of the rendered history,
// the viewer retains the same URL until its exit animation ends.
export const releaseMessageFileUrl = (src: string) => {
  if (useImageViewer.getState().image?.src === src) {
    useImageViewer.setState({ ownsUrl: true })
  } else {
    URL.revokeObjectURL(src)
  }
}

export const closeImageViewer = () => {
  const { image, ownsUrl } = useImageViewer.getState()
  if (image && ownsUrl) {
    URL.revokeObjectURL(image.src)
  }
  if (image) {
    logEvent('ui', 'image-viewer.closed')
  }
  useImageViewer.setState({ image: null, ownsUrl: false })
}
