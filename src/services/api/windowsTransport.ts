export const isWindowsDesktop = () =>
  window.location.protocol === 'freeseek:' && window.location.host === 'app'

export const apiRequestRoute = (url: string, headers?: HeadersInit) => {
  if (!isWindowsDesktop()) {
    return { url, headers }
  }
  const forwarded = new Headers(headers)
  forwarded.set('x-freeseek-network', '1')
  return { url: `freeseek://app/_api?${new URLSearchParams({ url })}`, headers: forwarded }
}

export const fetchApiRequest = (url: string, init: RequestInit) => {
  const route = apiRequestRoute(url, init.headers)
  return fetch(route.url, { ...init, headers: route.headers })
}
