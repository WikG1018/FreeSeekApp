import clsx from 'clsx'
import type { CSSProperties } from 'react'
import logo from '../../assets/logo.png'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import {
  closeScreenTimeMilestone,
  replayScreenTimeMilestone,
  useScreenTimeMilestones,
  type MilestoneHours,
} from '../../services/screenTimeMilestones.js'
import { IconRefreshOutline16 } from '../base/icons.js'
import { Modal, closeTopModal } from '../base/Modal.js'
import { SupportMark, useDocumentVisible } from '../donate/SupportMark.js'
import whaleLogo from '../session/WhaleLogo.module.css'
import { Row, Section } from '../settings/SettingsRows.js'
import styles from './UsageMilestone.module.css'

type Tone = 'shallows' | 'tide' | 'stars'
const scenes = {
  100: {
    tone: 'shallows',
    name: 'milestoneShallows',
    title: 'milestone100Title',
    body: 'milestone100Body',
  },
  500: {
    tone: 'tide',
    name: 'milestoneTide',
    title: 'milestone500Title',
    body: 'milestone500Body',
  },
  1000: {
    tone: 'stars',
    name: 'milestoneStars',
    title: 'milestone1000Title',
    body: 'milestone1000Body',
  },
} as const satisfies Record<
  MilestoneHours,
  { tone: Tone; name: TranslationKey; title: TranslationKey; body: TranslationKey }
>

const bubbles = [
  [55, 7, -0.4],
  [62, 5, -1.1],
  [59, 10, -1.8],
  [66, 6, -2.2],
  [65, 8, -2.7],
  [71, 5, -3.2],
] as const
const constellation = [
  [12, 93],
  [52, 48],
  [86, 64],
  [163, 36],
  [201, 60],
  [240, 21],
] as const
const starPositions = Array.from({ length: 25 }, (_, index) => [
  5 + ((index * 79 + 17) % 251),
  3 + ((index * 57 + 23) % 124),
  1.4 + (index % 5) * 0.47,
])

const MilestoneArt = ({ tone, paused }: { tone: Tone; paused: boolean }) => (
  <div
    className={styles.art}
    aria-hidden="true"
    data-milestone-art=""
    data-paused={paused || undefined}
  >
    {tone === 'shallows' && (
      <div className={styles.water}>
        <div className={styles.ripples}>
          <span />
          <span />
          <span />
        </div>
        {bubbles.map(([x, size, delay]) => (
          <span
            key={x}
            className={styles.bubble}
            style={{ left: x + '%', width: size, height: size, animationDelay: delay + 's' }}
          />
        ))}
      </div>
    )}
    {tone === 'tide' && (
      <div className={styles.current}>
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <span key={index} style={{ top: index * 5, animationDelay: index * -0.28 + 's' }} />
        ))}
      </div>
    )}
    {tone === 'stars' && (
      <div className={styles.sky}>
        {constellation.slice(1).map(([x, y], index) => {
          const [startX, startY] = constellation[index]
          const dx = x - startX
          const dy = y - startY
          return (
            <span
              key={x}
              className={styles.link}
              style={{
                left: startX,
                top: startY,
                width: Math.hypot(dx, dy),
                transform: 'rotate(' + Math.atan2(dy, dx) + 'rad)',
              }}
            />
          )
        })}
        {[...starPositions, ...constellation.map(([x, y]) => [x, y, 4])].map(
          ([x, y, size], index) => (
            <span
              key={index}
              className={styles.spark}
              style={{
                left: x,
                top: y,
                width: size,
                height: size,
                animationDelay: (index % 9) * -0.54 + 's',
              }}
            />
          )
        )}
      </div>
    )}
    <div
      className={styles.pod}
      style={{ '--milestone-mark': 'url("' + logo + '")' } as CSSProperties}
    >
      <img className={styles.fallback} src={logo} alt="" draggable={false} />
      <span className={styles.lead} data-milestone-swim="">
        <span className={clsx(styles.shape, whaleLogo.large)} />
      </span>
      <span className={styles.follow} data-milestone-swim="">
        <span className={clsx(styles.shape, whaleLogo.small)} />
      </span>
    </div>
  </div>
)

export const UsageMilestoneDialog = ({
  hours,
  covered,
  onDonate,
}: {
  hours: MilestoneHours
  covered: boolean
  onDonate: () => void
}) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const visible = useDocumentVisible()
  const scene = scenes[hours]
  const value = hours.toLocaleString(locale)
  return (
    <Modal
      title={<span className={styles.brand}>FreeSeek</span>}
      ariaLabel={t('milestoneReached', { hours: value })}
      className={clsx(styles.screen, styles[scene.tone])}
      mainClassName={styles.body}
      closable
      onClose={closeScreenTimeMilestone}
    >
      <MilestoneArt tone={scene.tone} paused={covered || !visible} />
      <div className={styles.copy}>
        <h2 data-modal-initial-focus tabIndex={-1} className={styles.title}>
          <span className={styles.prefix}>{t('milestonePrefix')}</span>
          <span className={styles.duration}>
            <span className={styles.number}>{value}</span> <span>{t('milestoneHourUnit')}</span>
          </span>
        </h2>
        <p className={styles.thanks}>{t(scene.title)}</p>
        <p className={styles.message}>{t(scene.body)}</p>
      </div>
      <div className={styles.actions}>
        <button type="button" className={styles.proceed} onClick={closeTopModal}>
          {t('milestoneContinue')}
        </button>
        <button type="button" className={styles.support} onClick={onDonate}>
          <SupportMark animated={false} />
          {t('donateTitle')}
        </button>
      </div>
    </Modal>
  )
}

export const EasterEggsPage = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const triggered = useScreenTimeMilestones((state) => state.triggered)
  return triggered.length ? (
    <Section>
      {triggered.map((hours) => (
        <Row
          key={hours}
          icon={<IconRefreshOutline16 />}
          label={t('milestoneDuration', { hours: hours.toLocaleString(locale) })}
          description={t(scenes[hours].name)}
          onClick={() => replayScreenTimeMilestone(hours)}
        />
      ))}
    </Section>
  ) : null
}
