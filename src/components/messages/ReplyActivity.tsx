import { useEffect, useMemo, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { replyActivityPhase } from '../../services/chat/activity.js'
import type { AssistantMessage } from '../../services/chat/types.js'
import type { ReplyView } from '../../services/chat/view.js'
import styles from './ReplyArea.module.css'

const QUIET_MS = 15_000

export const useReplyQuiet = (message: AssistantMessage, phase: TranslationKey, active = true) => {
  const [quiet, setQuiet] = useState<{ snapshot: object; seconds: number }>()
  const run = message.task?.run
  const toolInputAt = message.toolInputAt
  const activityAt = message.nativeActivity?.updatedAt
  const snapshot = useMemo(
    () => ({
      blocks: message.blocks,
      steps: message.task?.steps,
      phase,
      run,
      toolInputAt,
      activityAt,
    }),
    [message.blocks, message.task?.steps, phase, run, toolInputAt, activityAt]
  )
  useEffect(() => {
    if (!active) {
      return
    }
    const start = performance.now()
    let clock: number | undefined
    const update = () =>
      setQuiet({ snapshot, seconds: Math.round((performance.now() - start) / 1000) })
    const timer = window.setTimeout(() => {
      update()
      clock = window.setInterval(update, 1000)
    }, QUIET_MS)
    return () => {
      window.clearTimeout(timer)
      window.clearInterval(clock)
    }
  }, [active, snapshot])
  return active && quiet?.snapshot === snapshot ? quiet.seconds : 0
}

export const ReplyActivity = ({
  message,
  view,
  transcriptTail = false,
}: {
  message: AssistantMessage
  view: ReplyView
  transcriptTail?: boolean
}) => {
  const t = useTranslate()
  const phase = replyActivityPhase(message, view)
  const quiet = useReplyQuiet(message, phase)
  const alreadyShown =
    transcriptTail &&
    ((phase === 'agentThinkingActive' && !message.nativeActivity) ||
      message.task?.steps.some(({ status }) => status === 'working'))
  if (alreadyShown && !quiet) {
    return null
  }
  return (
    <span className={styles.activity} data-testid="reply-activity" data-phase={phase}>
      {!alreadyShown && phase !== 'replyActivityAnswer' && (
        <span className={styles.activityDots} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      )}
      <span role="status">
        {!alreadyShown && <span>{t(phase)}</span>}
        {quiet > 0 && (
          <small className={styles.activityWait}>
            {t('replyActivityQuiet', { seconds: quiet })}
          </small>
        )}
      </span>
    </span>
  )
}
