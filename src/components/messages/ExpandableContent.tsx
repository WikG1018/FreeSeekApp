import { useEffect, useState, type ReactNode } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { logEvent } from '../../services/diagnostics/log.js'
import styles from './ExpandableContent.module.css'

/** 仅折叠显示；复制、备份与发给模型的内容始终使用完整原文。 */
export const ExpandableContent = ({
  text,
  className,
  render,
  streaming = false,
}: {
  text: string
  className?: string
  render?: (text: string) => ReactNode
  streaming?: boolean
}) => {
  const t = useTranslate(),
    [expanded, setExpanded] = useState(streaming)
  useEffect(() => {
    if (streaming) {
      setExpanded(true)
    }
  }, [streaming])
  const long = text.length > 16000,
    collapsed = long && !expanded
  return (
    <div className={className}>
      {collapsed ? (
        <div className={styles.preview}>{text.slice(0, 6000)}…</div>
      ) : render ? (
        render(text)
      ) : (
        text
      )}
      {long ? (
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={expanded}
          onClick={() => {
            logEvent('ui', 'long-content.toggled', { expanded: !expanded, characters: text.length })
            setExpanded((value) => !value)
          }}
        >
          {expanded
            ? t('collapseFullContent')
            : t('expandFullContent', { count: text.length.toLocaleString() })}
        </button>
      ) : null}
    </div>
  )
}
