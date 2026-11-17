import { logEvent } from './diagnostics/log.js'
/**
 * 图片格式规范化。
 *
 * 接口只接受 PNG / JPEG / GIF / WEBP 这几种图片本体；但相册里的图可能是
 * BMP、TIFF、SVG、AVIF、HEIC，甚至扩展名写错的文件。这类文件上传接口会收下，
 * 到了发消息时才报 `uploaded an unsupported image`，而且该会话之后每次都会失败。
 *
 * 所以上传前统一处理：
 * - 按文件头识别真实格式（不信扩展名和 file.type）
 * - 支持的格式原样放行，顺手把 MIME 纠正过来
 * - 不支持的用 canvas 解码后重新编码成 PNG
 * - 解码不了（损坏、HEIC 等）直接抛错，界面上给出可读原因
 */

/** 接口支持的图片 MIME */
const SUPPORTED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** 图片内容无法转换时抛出，界面按 uploadImageUnsupported 展示 */
export class UnsupportedImageError extends Error {
  constructor() {
    super('Unsupported image')
    this.name = 'UnsupportedImageError'
  }
}

const startsWith = (bytes: Uint8Array, prefix: number[]) =>
  prefix.every((byte, index) => bytes[index] === byte)

/** 按文件头判断图片格式；不认识返回 null */
export const sniffImageMime = (bytes: Uint8Array): string | null => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png'
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg'
  }
  const ascii = new TextDecoder('ascii').decode(bytes.subarray(0, 12))
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) {
    return 'image/gif'
  }
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') {
    return 'image/webp'
  }
  if (startsWith(bytes, [0x42, 0x4d])) {
    return 'image/bmp'
  }
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0]) || startsWith(bytes, [0x4d, 0x4d, 0, 0x2a])) {
    return 'image/tiff'
  }
  if (ascii.slice(4, 8) === 'ftyp') {
    const brand = ascii.slice(8, 12)
    if (brand === 'avif' || brand === 'avis') {
      return 'image/avif'
    }
    if (['heic', 'heix', 'hevc', 'mif1'].includes(brand)) {
      return 'image/heic'
    }
  }
  // SVG 是文本，取开头忽略 BOM 与空白
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 64)).trimStart()
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
    return 'image/svg+xml'
  }
  return null
}

const replaceExt = (name: string, ext: string) => {
  const dot = name.lastIndexOf('.')
  return `${dot > 0 ? name.slice(0, dot) : name}.${ext}`
}

/** 用 <img> 解码：SVG 这类 createImageBitmap 不支持的格式靠它兜底 */
const decodeWithImg = (blob: Blob): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('decode failed'))
    }
    image.src = url
  })

const drawToPng = (
  source: CanvasImageSource,
  width: number,
  height: number
): Promise<Blob | null> => {
  // 接口对超大图会拒收，最长边限制在 4096
  const scale = Math.min(1, 4096 / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const context = canvas.getContext('2d')
  if (!context) {
    return Promise.resolve(null)
  }
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve) => {
    canvas.toBlob((png) => resolve(png), 'image/png')
  })
}

/** 图片尺寸从轻量文件头读取，JPEG 等在解码时直接缩小，避免同时展开多张巨图。 */
const readDimensions = (bytes: Uint8Array): { width: number; height: number } | null => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const type = sniffImageMime(bytes)
  if (type === 'image/png' && bytes.length >= 24) {
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (type === 'image/gif' && bytes.length >= 10) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
  }
  if (type === 'image/bmp' && bytes.length >= 26) {
    return view.getUint32(14, true) === 12
      ? { width: view.getUint16(18, true), height: view.getUint16(20, true) }
      : { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) }
  }
  const ascii = new TextDecoder('ascii').decode(bytes.subarray(12, 16))
  if (type === 'image/webp' && bytes.length >= 30) {
    if (ascii === 'VP8X') {
      const n = (i: number) => bytes[i] + (bytes[i + 1] << 8) + (bytes[i + 2] << 16) + 1
      return { width: n(24), height: n(27) }
    }
    if (ascii === 'VP8L') {
      const bits = view.getUint32(21, true)
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
    }
    if (ascii === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
    }
  }
  if (type === 'image/jpeg') {
    let offset = 2
    while (offset + 8 < bytes.length) {
      if (bytes[offset++] !== 0xff) {
        continue
      }
      while (bytes[offset] === 0xff) {
        offset++
      }
      const marker = bytes[offset++]
      if (offset + 7 >= bytes.length) {
        break
      }
      if (marker === 0xda || marker === 0xd9) {
        break
      }
      const size = view.getUint16(offset)
      if (size < 2 || offset + size > bytes.length) {
        break
      }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) }
      }
      offset += size
    }
  }
  return null
}
export class ImageDimensionsError extends UnsupportedImageError {
  constructor() {
    super()
    this.name = 'ImageDimensionsError'
  }
}
const normalize = async (file: File, signal?: AbortSignal): Promise<File> => {
  signal?.throwIfAborted()
  const bytes = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer())
  const actual = sniffImageMime(bytes),
    dimensions = readDimensions(bytes)
  if (dimensions && dimensions.width * dimensions.height > 100_000_000 && actual !== 'image/jpeg') {
    throw new ImageDimensionsError()
  }
  const scale = dimensions ? Math.min(1, 4096 / Math.max(dimensions.width, dimensions.height)) : 1
  let source: ImageBitmap | HTMLImageElement, width: number, height: number
  try {
    source = await createImageBitmap(
      file,
      dimensions && scale < 1
        ? {
            resizeWidth: Math.max(1, Math.round(dimensions.width * scale)),
            resizeHeight: Math.max(1, Math.round(dimensions.height * scale)),
            resizeQuality: 'high',
          }
        : {}
    )
    width = source.width
    height = source.height
  } catch {
    try {
      source = await decodeWithImg(file)
      width = source.naturalWidth || 1024
      height = source.naturalHeight || 1024
    } catch {
      throw new UnsupportedImageError()
    }
  }
  try {
    signal?.throwIfAborted()
    if (actual && SUPPORTED.has(actual) && scale === 1 && Math.max(width, height) <= 4096) {
      return file.type === actual ? file : new File([file], file.name, { type: actual })
    }
    const png = await drawToPng(source, width, height)
    if (!png) {
      throw new UnsupportedImageError()
    }
    signal?.throwIfAborted()
    logEvent('upload', 'image.normalized', {
      inputBytes: file.size,
      outputBytes: png.size,
      originalWidth: dimensions?.width,
      originalHeight: dimensions?.height,
      resized: scale < 1,
    })
    return new File([png], replaceExt(file.name, 'png'), { type: 'image/png' })
  } finally {
    if ('close' in source) {
      source.close()
    }
  }
}

let imageQueue = Promise.resolve()
/** 解码串行、网络上传仍可并行；失败和取消不会堵住后续图片。 */
export const normalizeImageFile = (file: File, signal?: AbortSignal): Promise<File> => {
  const task = imageQueue.then(() => normalize(file, signal))
  imageQueue = task.then(
    () => {},
    () => {}
  )
  return task
}
