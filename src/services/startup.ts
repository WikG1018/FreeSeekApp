import { Capacitor, registerPlugin } from '@capacitor/core'
import { diagnosticError, logEvent } from './diagnostics/log.js'

export const startupMarkUrl = './startup-mark.png'
export const startupEndedEvent = 'freeseek:startup-ended'
const nativeSplashEndedEvent = 'freeseek:native-splash-ended'
const HOME_HANDOFF_MS = 280
const PAGE_HANDOFF_MS = 145
const soften = (value: number) => value * value * (3 - 2 * value)

type Bounds = { width: number; left: number; top: number }
const StartupHandoff = registerPlugin<{
  prepare(options: {
    source: Bounds
    target: Bounds | null
    viewportWidth: number
    dark: boolean
  }): Promise<{ enabled: boolean }>
  start(): Promise<void>
  dismiss(): Promise<void>
}>('StartupHandoff')

const bounds = ({ width, left, top }: DOMRect): Bounds => ({ width, left, top })

export const isStartupVisible = () => document.documentElement.hasAttribute('data-fs-starting')
export const markStartupMounted = () => {
  logEvent('app', 'startup.mounted', { uptimeMs: Math.round(performance.now()) })
  window.__FreeSeekStartup?.mounted()
}

export const markStartupReady = () =>
  window.__FreeSeekStartup?.ready((reveal) => {
    const panel = document.getElementById('fs-startup')
    const mark = document.getElementById('fs-startup-mark') as HTMLImageElement | null
    const android = Capacitor.getPlatform() === 'android'
    const noMotion = () =>
      document.visibilityState !== 'visible' ||
      matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!panel || !mark || noMotion()) {
      logEvent('app', 'startup.revealed', {
        handoff: 'none',
        uptimeMs: Math.round(performance.now()),
      })
      reveal()
      return
    }

    let timeout: ReturnType<typeof setTimeout>
    let frame = 0
    let finished = false
    let native = false
    let relayout = false
    let greeting: HTMLElement | null = null
    const interrupt = ['pointerdown', 'keydown'] as const
    const finish = () => {
      if (finished) {
        return
      }
      finished = true
      clearTimeout(timeout)
      cancelAnimationFrame(frame)
      window.removeEventListener(nativeSplashEndedEvent, schedule)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onHidden)
      for (const event of interrupt) {
        window.removeEventListener(event, finish, true)
      }
      panel.style.removeProperty('visibility')
      mark.style.removeProperty('transform')
      greeting?.style.removeProperty('opacity')
      reveal()
      logEvent('app', 'startup.revealed', {
        handoff: native ? 'native' : 'web',
        destination: panel.dataset.handoff,
        uptimeMs: Math.round(performance.now()),
      })
      if (native) {
        void StartupHandoff.dismiss().catch(() => {})
      }
    }
    const onResize = () => {
      relayout = true
    }
    const onHidden = () => {
      if (document.visibilityState !== 'visible') {
        finish()
      }
    }
    const begin = () => {
      if (noMotion() || mark.style.display === 'none') {
        finish()
        return
      }
      const target = document.querySelector('[data-startup-target]')
      const source = mark.getBoundingClientRect()
      // Measure both endpoints in viewport pixels after the App commits its layout.
      const measure = () => {
        const end = target?.getBoundingClientRect()
        const area = panel.getBoundingClientRect()
        return mark.naturalWidth && end?.width && source.width
          ? {
              x: end.left + end.width / 2 - (area.left + area.width / 2),
              y: end.top + end.height / 2 - (area.top + area.height / 2),
              scale: end.width / source.width - 1,
            }
          : null
      }
      let travel = measure()
      if (travel) {
        document.documentElement.setAttribute('data-fs-startup-home', '')
        greeting = document.querySelector<HTMLElement>('[data-startup-greeting]')
        if (greeting) {
          greeting.style.opacity = '0'
        }
      }
      const duration = travel ? HOME_HANDOFF_MS : PAGE_HANDOFF_MS
      panel.setAttribute('data-handoff', travel ? 'home' : 'page')
      const animateOnPage = () => {
        clearTimeout(timeout)
        let start: number | undefined
        const draw = (now: number) => {
          start ??= now
          const progress = Math.min(1, (now - start) / duration)
          const pose = soften(progress)
          panel.style.setProperty('--startup-opacity', String(1 - pose))
          if (travel) {
            if (relayout || progress === 1) {
              travel = measure() ?? travel
              relayout = false
            }
            mark.style.transform =
              'translate(' +
              travel.x * pose +
              'px,' +
              travel.y * pose +
              'px) scale(' +
              (1 + travel.scale * pose) +
              ')'
            if (greeting) {
              greeting.style.opacity = String(soften(Math.max(0, (progress - 0.75) / 0.25)))
            }
          }
          frame = requestAnimationFrame(progress === 1 ? finish : draw)
        }
        frame = requestAnimationFrame(draw)
        timeout = setTimeout(finish, duration + 220)
      }
      if (!android || !mark.naturalWidth || !source.width) {
        animateOnPage()
        return
      }

      native = true
      timeout = setTimeout(finish, 1100)
      void StartupHandoff.prepare({
        source: bounds(source),
        target: travel && target ? bounds(target.getBoundingClientRect()) : null,
        viewportWidth: window.innerWidth,
        dark: document.body.hasAttribute('data-ds-dark-theme'),
      })
        .then(async ({ enabled }) => {
          if (finished) {
            return
          }
          if (!enabled) {
            finish()
            return
          }
          panel.style.visibility = 'hidden'
          clearTimeout(timeout)
          timeout = setTimeout(finish, 1500)
          await StartupHandoff.start()
          if (finished) {
            return
          }
          greeting?.animate?.([{ opacity: 0 }, { opacity: 1 }], {
            duration: 120,
            easing: 'ease-out',
          })
          finish()
        })
        .catch((error) => {
          if (finished) {
            return
          }
          logEvent('app', 'startup.native-handoff-failed', diagnosticError(error), 'warn')
          panel.style.removeProperty('visibility')
          void StartupHandoff.dismiss().catch(() => {})
          native = false
          animateOnPage()
        })
    }
    const schedule = () => {
      clearTimeout(timeout)
      window.removeEventListener(nativeSplashEndedEvent, schedule)
      frame = requestAnimationFrame(begin)
    }

    for (const event of interrupt) {
      window.addEventListener(event, finish, { capture: true, once: true })
    }
    window.addEventListener('resize', onResize)
    document.addEventListener('visibilitychange', onHidden)
    if (android && !window.__FreeSeekNativeSplashDone) {
      window.addEventListener(nativeSplashEndedEvent, schedule, { once: true })
      timeout = setTimeout(schedule, 420)
    } else {
      schedule()
    }
  })

export const reportRenderFailure = (error: unknown) =>
  window.__FreeSeekStartup?.fail('render', error)
