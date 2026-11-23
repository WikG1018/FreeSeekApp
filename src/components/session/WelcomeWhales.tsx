import { useEffect, useRef } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { isStartupVisible, startupEndedEvent, startupMarkUrl } from '../../services/startup.js'
import { listenMediaQuery } from '../../utils/mediaQuery.js'
import whaleLogo from './WhaleLogo.module.css'
import styles from './Welcome.module.css'

const PERIOD = 5600
const TAU = 2 * Math.PI
const REPLY_MS = 1140
const GREETING_DELAY = 75
const GREETING_TRAVEL = 390
const GREETING_CYCLE = 620
const bubbleDelays = [80, 138, 220]

const beat = (age: number, duration: number, peak: number) => {
  if (age <= 0 || age >= duration) {
    return 0
  }
  const phase = age / duration
  const progress = phase < peak ? phase / peak : (1 - phase) / (1 - peak)
  return 0.5 - 0.5 * Math.cos(Math.PI * progress)
}

const energy = (time: number, taps: number[], delay: number, duration: number, peak: number) => {
  const value = taps.reduce((sum, tap) => sum + beat(time - tap - delay, duration, peak), 0)
  return value / (1 + 0.4 * value)
}

const greetingOffset = (time: number, taps: number[], delay: number) => {
  const wave = taps.reduce((sum, tap) => {
    const phase = (time - tap - delay) / GREETING_CYCLE
    if (phase <= 0 || phase >= 1) {
      return sum
    }
    const envelope = Math.sin(Math.PI * phase)
    return sum + Math.sin(TAU * phase) * envelope * envelope
  }, 0)
  return -8.8 * Math.tanh(wave * 1.3)
}

const transform = (el: HTMLElement, x: number, y: number, angle: number) => {
  el.style.transform = `translate3d(${x}px,${y}px,0) rotate(${angle}deg)`
}

export const WelcomeWhales = ({ active }: { active: boolean }) => {
  const t = useTranslate()
  const root = useRef<HTMLDivElement>(null)
  const respond = useRef<(() => void) | null>(null)
  const clock = useRef({ time: 0, taps: [] as number[] })
  const greeting = t('welcomeMessageChat250808')
  // Keep Latin words and closing punctuation together when the greeting wraps.
  const parts = greeting.match(/[A-Za-z0-9]+[,.!?]?|\S[，。！？、]?|\s+/gu) ?? []

  useEffect(() => {
    const brand = root.current
    if (!brand) {
      return
    }
    const [leader, follower] = brand.querySelectorAll<HTMLElement>('[data-whale-ride]')
    const [leadReply, followReply] = brand.querySelectorAll<HTMLElement>('[data-whale-reply]')
    const bubbles = brand.querySelectorAll<HTMLElement>('[data-whale-bubble]')
    const heading = brand.querySelector<HTMLElement>('[data-startup-greeting]')
    const greetingParts = brand.querySelectorAll<HTMLElement>('[data-greeting-part]')
    if (!leader || !follower || !leadReply || !followReply || !heading) {
      return
    }

    const reduced = matchMedia('(prefers-reduced-motion: reduce)')
    const canSplit =
      typeof CSS !== 'undefined' && CSS.supports('clip-path', 'polygon(0 0, 100% 0, 100% 100%)')
    const timeline = clock.current
    const step = GREETING_TRAVEL / Math.max(1, greetingParts.length - 1)
    let frame = 0,
      last: number | null = null,
      inView = true,
      hasReply = false

    const paint = () => {
      const { time, taps } = timeline
      const stillText = reduced.matches || isStartupVisible()
      const still = stillText || !canSplit
      if (still) {
        leader.style.transform = 'none'
        follower.style.transform = 'none'
      } else {
        const phase = (TAU * (time % PERIOD)) / PERIOD
        const tail = phase - (TAU * 850) / PERIOD
        const arrival = Math.min(1, time / 280)
        const swim = arrival * arrival * (3 - 2 * arrival)
        // Separate the loop and response transforms so a tap never restarts the path.
        transform(
          leader,
          swim * (-0.6 - 3.6 * Math.sin(phase)),
          swim * (-1.3 - 3.5 * Math.cos(phase)),
          swim * -3.2 * Math.sin(phase + 0.35)
        )
        transform(
          follower,
          swim * (1.5 - 2.8 * Math.sin(tail)),
          swim * (2.6 - 2.7 * Math.cos(tail)),
          swim * -3.5 * Math.sin(tail + 0.35)
        )
      }
      if (!taps.length && !hasReply) {
        return
      }
      hasReply = taps.length > 0
      const lead = energy(time, taps, 0, 960, 0.28)
      const follow = energy(time, taps, 130, 910, 0.3)
      if (still) {
        leadReply.style.transform = 'none'
        followReply.style.transform = 'none'
      } else {
        transform(leadReply, -2.1 * lead, -8.2 * lead, -11.4 * lead)
        transform(followReply, 1.8 * follow, -7 * follow, -9.6 * follow)
      }
      const since = time - (taps.at(-1) ?? -1_000_000)
      bubbles.forEach((bubble, index) => {
        const phase = Math.max(0, Math.min(1, (since - bubbleDelays[index]) / 780))
        bubble.style.opacity = still || phase === 1 ? '0' : String(Math.sin(Math.PI * phase) * 0.74)
        if (!still && phase > 0 && phase < 1) {
          bubble.style.transform = `translate3d(${(index + 1) * 3 * phase}px,${-21 * phase}px,0) scale(${0.62 + 0.4 * phase})`
        }
      })
      heading.toggleAttribute('data-greeting-feedback', reduced.matches && since < 860)
      greetingParts.forEach((part, index) => {
        const offset = stillText ? 0 : greetingOffset(time, taps, GREETING_DELAY + step * index)
        part.style.transform = offset === 0 ? 'none' : `translate3d(0,${offset}px,0)`
      })
    }
    const visible = () =>
      active && inView && !isStartupVisible() && document.visibilityState === 'visible'
    const shouldTick = () =>
      visible() && ((!reduced.matches && canSplit) || timeline.taps.length > 0)
    const tick = (now: number) => {
      frame = 0
      if (!shouldTick()) {
        last = null
        return
      }
      if (last !== null) {
        timeline.time += now - last
      }
      last = now
      if (timeline.taps.length) {
        timeline.taps = timeline.taps.filter((tap) => timeline.time - tap < REPLY_MS)
      }
      paint()
      if (shouldTick()) {
        frame = requestAnimationFrame(tick)
      } else {
        last = null
      }
    }
    const sync = () => {
      if (shouldTick()) {
        if (!frame) {
          frame = requestAnimationFrame(tick)
        }
      } else {
        cancelAnimationFrame(frame)
        frame = 0
        last = null
      }
      if (reduced.matches) {
        paint()
      }
    }
    respond.current = () => {
      if (visible()) {
        const sinceFrame = last === null ? 0 : Math.max(0, performance.now() - last)
        timeline.taps.push(timeline.time + sinceFrame)
        sync()
      }
    }
    const observer =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver(([entry]) => {
            inView = entry.isIntersecting
            sync()
          })
        : undefined
    observer?.observe(brand)
    const unlisten = listenMediaQuery(reduced, sync)
    document.addEventListener('visibilitychange', sync)
    window.addEventListener(startupEndedEvent, sync)
    paint()
    sync()
    return () => {
      cancelAnimationFrame(frame)
      respond.current = null
      observer?.disconnect()
      unlisten()
      document.removeEventListener('visibilitychange', sync)
      window.removeEventListener(startupEndedEvent, sync)
    }
  }, [active, greeting])

  return (
    <div className={styles.whales} ref={root}>
      <button
        type="button"
        className={styles.whaleButton}
        aria-label={t('welcomeGreetWhales')}
        data-testid="welcome-whale"
        data-startup-target={active ? '' : undefined}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => respond.current?.()}
      >
        <span className={styles.whaleArt} aria-hidden="true">
          <img
            className={`${styles.whaleFallback} fs-whale-image`}
            src={startupMarkUrl}
            alt=""
            draggable={false}
          />
          <span className={styles.whaleLeader} data-whale-ride="">
            <span data-whale-reply="">
              <img
                className={`${whaleLogo.large} fs-whale-image`}
                src={startupMarkUrl}
                alt=""
                draggable={false}
              />
            </span>
          </span>
          <span className={styles.whaleFollower} data-whale-ride="">
            <span data-whale-reply="">
              <img
                className={`${whaleLogo.small} fs-whale-image`}
                src={startupMarkUrl}
                alt=""
                draggable={false}
              />
            </span>
          </span>
          <span data-whale-bubble="" />
          <span data-whale-bubble="" />
          <span data-whale-bubble="" />
        </span>
      </button>
      <h1 className={styles.greeting} data-startup-greeting="" aria-label={greeting}>
        {parts.map((part, index) =>
          part.trim() ? (
            <span
              key={index}
              className={styles.greetingPart}
              data-greeting-part=""
              aria-hidden="true"
            >
              {part}
            </span>
          ) : (
            part
          )
        )}
      </h1>
    </div>
  )
}
