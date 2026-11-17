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

/** 用 canvas 把任意能解码的图片重编码成 PNG */
const toPng = async (blob: Blob): Promise<Blob | null> => {
  try {
    const bitmap = await createImageBitmap(blob)
    const png = await drawToPng(bitmap, bitmap.width, bitmap.height)
    bitmap.close()
    if (png) {
      return png
    }
  } catch {
    // 交给 <img> 再试一次（SVG、部分 TIFF）
  }
  try {
    const image = await decodeWithImg(blob)
    // SVG 可能没有固有尺寸，退回 1024
    return await drawToPng(image, image.naturalWidth || 1024, image.naturalHeight || 1024)
  } catch {
    return null
  }
}

/** 快速验证图片能否解码（不重编码）；损坏的 PNG/JPEG 服务端一样会拒收 */
const decodes = async (blob: Blob): Promise<boolean> => {
  try {
    const bitmap = await createImageBitmap(blob)
    bitmap.close()
    return true
  } catch {
    // createImageBitmap 不支持的格式（部分 SVG/TIFF）交给 <img> 再试
    try {
      await decodeWithImg(blob)
      return true
    } catch {
      return false
    }
  }
}

/**
 * 上传前把图片规范成接口支持的格式。
 * 返回新的 File（扩展名与 MIME 都和真实内容一致）；无法处理时抛 UnsupportedImageError。
 *
 * 注意「魔数对」不等于「内容有效」：导入的聊天记录里常有截断的 PNG/JPEG，
 * 魦数校验会放行、服务端发消息时才拒绝，所以支持的格式也要验证可解码，
 * 解不了就重编码；重编码也不行（彻底损坏）才抛错。
 */
export const normalizeImageFile = async (file: File): Promise<File> => {
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer())
  const actual = sniffImageMime(head)
  if (actual && SUPPORTED.has(actual)) {
    if (file.type !== actual) {
      const renamed = new File([file], file.name, { type: actual })
      if (await decodes(renamed)) {
        return renamed
      }
    } else if (await decodes(file)) {
      return file
    }
    // 魦数对但解不开：损坏图，尝试修复式重编码
    const repaired = await toPng(file)
    if (!repaired) {
      throw new UnsupportedImageError()
    }
    return new File([repaired], replaceExt(file.name, 'png'), { type: 'image/png' })
  }
  const png = await toPng(file)
  if (!png) {
    throw new UnsupportedImageError()
  }
  return new File([png], replaceExt(file.name, 'png'), { type: 'image/png' })
}
