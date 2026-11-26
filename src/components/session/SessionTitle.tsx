import { useTranslate } from '../../i18n/index.js'
import { useLongPress } from '../base/useLongPress.js'

export const SessionTitle = ({
  title,
  className,
  textClassName,
  onTop,
  onAssistant,
}: {
  title: string
  className: string
  textClassName?: string
  onTop: () => void
  onAssistant: () => void
}) => {
  const t = useTranslate()
  const press = useLongPress(onAssistant)
  return (
    <button
      type="button"
      className={className}
      aria-label={t('chatTitleGoTop', { title })}
      aria-keyshortcuts="Shift+F10"
      aria-description={t('chatTitleAssistantHint')}
      title={t('chatTitleAssistantHint')}
      onPointerDown={press.start}
      onPointerMove={press.move}
      onPointerUp={press.cancel}
      onPointerCancel={press.cancel}
      onPointerLeave={press.cancel}
      onContextMenu={(event) => {
        event.preventDefault()
        press.open()
      }}
      onKeyDown={(event) => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault()
          onAssistant()
        }
      }}
      onClick={(event) => {
        if (!press.consume() || event.detail === 0) {
          onTop()
        }
      }}
    >
      {textClassName ? <span className={textClassName}>{title}</span> : title}
    </button>
  )
}
