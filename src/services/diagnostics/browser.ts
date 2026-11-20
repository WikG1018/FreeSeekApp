/** Read WebView capabilities without asking for new permissions or device identifiers. */
export const browserEnvironment = () => {
  const heap = (
    performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }
  ).memory
  const { connection, deviceMemory } = navigator as Navigator & {
    connection?: { effectiveType?: string; rtt?: number; downlink?: number; saveData?: boolean }
    deviceMemory?: number
  }
  const viewport = window.visualViewport
  const root = document.documentElement
  const insets = getComputedStyle(root)
  return {
    userAgent: navigator.userAgent,
    language: navigator.language,
    languages: navigator.languages,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    online: navigator.onLine,
    secureContext: window.isSecureContext,
    visibility: document.visibilityState,
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
    devicePixelRatio,
    screen: { width: screen.width, height: screen.height, orientation: screen.orientation?.type },
    visualViewport: viewport
      ? {
          width: viewport.width,
          height: viewport.height,
          scale: viewport.scale,
          offsetTop: viewport.offsetTop,
        }
      : undefined,
    nativeInsets: Object.fromEntries(
      ['top', 'bottom', 'left', 'right'].map((edge) => [
        edge,
        Number.parseFloat(insets.getPropertyValue('--fs-native-' + edge)),
      ])
    ),
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemoryGB: deviceMemory,
    createImageBitmap: typeof createImageBitmap === 'function',
    mediaDevices: Boolean(navigator.mediaDevices),
    capabilities: {
      indexedDB: typeof indexedDB !== 'undefined',
      streamRead: typeof ReadableStream === 'function',
      streamWrite: typeof WritableStream === 'function',
      resizeObserver: typeof ResizeObserver === 'function',
      mediaRecorder: typeof MediaRecorder === 'function',
      share: typeof navigator.share === 'function',
      visualViewport: Boolean(viewport),
    },
    network: connection
      ? {
          effectiveType: connection.effectiveType,
          rttMs: connection.rtt,
          downlinkMbps: connection.downlink,
          dataSaver: connection.saveData,
        }
      : undefined,
    jsHeap: heap
      ? { usedJSHeapSize: heap.usedJSHeapSize, jsHeapSizeLimit: heap.jsHeapSizeLimit }
      : undefined,
  }
}
