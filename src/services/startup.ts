export const markStartupReady = () => window.__FreeSeekStartup?.ready()
export const reportRenderFailure = (error: unknown) =>
  window.__FreeSeekStartup?.fail('render', error)
