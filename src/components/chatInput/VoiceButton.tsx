import { useTranslate } from '../../i18n/index.js'
import { IconMicOutline16, IconStopFill16 } from '../base/icons.js'
import { Tooltip } from '../base/Tooltip.js'
import type { VoiceInputStatus } from './useVoiceInput.js'
import styles from './VoiceButton.module.css'

export const VoiceButton = ({
  status,
  disabled = false,
  onClick,
}: {
  status: VoiceInputStatus
  disabled?: boolean
  onClick: () => void
}) => {
  const t = useTranslate()
  const recording = status === 'recording'
  const busy = status === 'starting' || status === 'transcribing'
  const label = t(
    disabled
      ? 'voiceInputRequiresHttps'
      : recording
        ? 'voiceInputStop'
        : busy
          ? status === 'starting'
            ? 'cancel'
            : 'voiceInputCancel'
          : 'voiceInput'
  )

  return (
    <Tooltip content={label}>
      <button
        type="button"
        className={styles.button}
        aria-label={label}
        aria-disabled={disabled}
        onClick={disabled ? undefined : onClick}
      >
        {recording ? (
          <span className={styles.stop}>
            <IconStopFill16 />
          </span>
        ) : busy ? (
          <span className={styles.loading} aria-hidden />
        ) : (
          <IconMicOutline16 />
        )}
      </button>
    </Tooltip>
  )
}
