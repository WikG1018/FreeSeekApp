/** 旧 WebView 的 MediaQueryList 只有 addListener/removeListener。 */
export const listenMediaQuery = (query: MediaQueryList, listener: () => void) => {
  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', listener)
    return () => query.removeEventListener('change', listener)
  }
  query.addListener(listener)
  return () => query.removeListener(listener)
}
