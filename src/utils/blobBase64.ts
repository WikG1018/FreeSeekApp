export const blobBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.onabort = () => reject(new DOMException('Read cancelled', 'AbortError'))
    reader.readAsDataURL(blob)
  })
