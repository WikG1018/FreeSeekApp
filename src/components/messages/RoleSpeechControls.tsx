import { useEffect, type RefObject } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  recoverRoleSpeech,
  stopReadAloud,
  toggleReadAloudPause,
  useReadAloud,
} from '../../services/speech/readAloud.js'
import { Button } from '../base/Button.js'
import {
  IconPauseOutline16,
  IconPlayMediaOutline16,
  IconResumeOutline16,
  IconStopOutline16,
  IconWarningOutline16,
} from '../base/icons.js'
import styles from './RoleSpeechControls.module.css'

export const RoleSpeechControls = ({
  messageId,
  streaming,
  onStart,
}: {
  messageId: string
  streaming: boolean
  onStart: () => void
}) => {
  const t = useTranslate()
  const playback = useReadAloud((state) =>
    state.messageId === messageId && state.roleReply ? state : null
  )
  const active = playback !== null
  const paused = playback?.status === 'paused'
  const failed = Boolean(playback?.failure)
  const label = failed
    ? t('roleVoicePlaybackFailed')
    : active
      ? t(paused ? 'ttsResume' : 'ttsPause')
      : t(streaming ? 'roleVoiceLive' : 'ttsPlay')
  const PlaybackIcon = failed
    ? IconWarningOutline16
    : paused
      ? IconResumeOutline16
      : active
        ? IconPauseOutline16
        : IconPlayMediaOutline16
  const caption = failed
    ? t('taskFailed')
    : paused
      ? t('roleVoiceControlPaused')
      : playback?.retrying
        ? t('roleVoiceControlRetrying')
        : (playback?.speakingRole ??
          t(playback?.waitingForText ? 'roleVoiceControlWaiting' : 'roleVoiceControlPreparing'))
  const fullCaption = failed
    ? label
    : playback?.speakingRole && !paused
      ? t(playback.retrying ? 'roleVoiceRetryingRole' : 'roleVoiceNowReading', {
          name: playback.speakingRole,
        })
      : caption
  return (
    <div
      className={styles.controls}
      data-active={active || undefined}
      data-testid="role-speech-controls"
      onMouseDown={(event) => {
        // 旧 WebView 会把手指点击产生的鼠标事件也当作焦点入口。
        if (event.button === 0) {
          event.preventDefault()
        }
      }}
    >
      <button
        type="button"
        className={styles.play}
        aria-label={label}
        aria-description={active ? fullCaption : undefined}
        title={active ? fullCaption : label}
        disabled={failed}
        onClick={() => (active ? toggleReadAloudPause(messageId) : onStart())}
      >
        <PlaybackIcon />
        <span className={styles.caption}>
          {active ? caption : streaming ? t('roleVoiceLiveShort') : label}
        </span>
      </button>
      {active && (
        <button
          type="button"
          className={styles.stop}
          aria-label={t('ttsStop')}
          title={t('ttsStop')}
          onClick={stopReadAloud}
        >
          <IconStopOutline16 />
        </button>
      )}
    </div>
  )
}

function highlightLine(body: Element, text: string): Range | undefined {
  const nodes: Array<{ node: Text; start: number }> = []
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
  let full = ''
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.textContent ?? ''
    if (value) {
      nodes.push({ node: node as Text, start: full.length })
      full += value
    }
  }
  const first = full.indexOf(text)
  if (first < 0 || full.indexOf(text, first + 1) >= 0) {
    return
  }
  const end = first + text.length
  const from = nodes.findLast(({ start }) => start <= first)
  const to = nodes.findLast(({ start }) => start < end)
  if (from && to) {
    const range = new Range()
    range.setStart(from.node, first - from.start)
    range.setEnd(to.node, end - to.start)
    return range
  }
  return undefined
}

/** CSS highlights preserve Markdown structure and the browser's native text selection. */
const useSpeakingHighlight = (root: RefObject<HTMLDivElement>, text: string | null) => {
  useEffect(() => {
    const host = root.current
    const highlights = globalThis.CSS?.highlights
    if (!host || !text || !highlights || typeof Highlight !== 'function') {
      return
    }
    const refresh = () => {
      const body = host.querySelector('.ds-assistant-message-main-content')
      const range = body && highlightLine(body, text)
      if (range) {
        highlights.set('freeseek-speaking', new Highlight(range))
      } else {
        highlights.delete('freeseek-speaking')
      }
    }
    refresh()
    const observer = new MutationObserver(refresh)
    observer.observe(host, { childList: true, characterData: true, subtree: true })
    return () => {
      observer.disconnect()
      highlights.delete('freeseek-speaking')
    }
  }, [root, text])
}

export const RoleSpeechDetails = ({
  messageId,
  root,
}: {
  messageId: string
  root: RefObject<HTMLDivElement>
}) => {
  const t = useTranslate()
  const { speakingRole, speakingText, failure, retrying } = useReadAloud()
  useSpeakingHighlight(root, failure || retrying ? null : speakingText)
  if (!failure) {
    return null
  }
  return (
    <div className={styles.recovery}>
      <div className={styles.error} role="alert">
        {speakingRole && <strong>{speakingRole}</strong>}
        {t(failure.key, failure.params)}
      </div>
      {speakingText && <q className={styles.quote}>{speakingText}</q>}
      <div className={styles.buttons}>
        <Button size="s" variant="outlined" onClick={() => recoverRoleSpeech(messageId, 'retry')}>
          {t('roleVoiceRetryLine')}
        </Button>
        <Button size="s" variant="outlined" onClick={() => recoverRoleSpeech(messageId, 'skip')}>
          {t('roleVoiceSkipLine')}
        </Button>
      </div>
    </div>
  )
}
