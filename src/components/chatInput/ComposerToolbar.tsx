import { memo, useId, type RefObject } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useProviders } from '../../services/providers.js'
import { setSearch, setThinking, useSettings } from '../../services/settings.js'
import { IconGlobeLanguageOutline14, IconThinkOutline14 } from '../base/icons.js'
import { Tooltip } from '../base/Tooltip.js'
import { showToast } from '../base/toastState.js'
import { ContextUsage } from './ContextUsage.js'
import { ModelPicker } from './ModelPicker.js'
import styles from './ChatInput.module.css'

export const ComposerToolbar = memo(function ComposerToolbar({
  editorRef,
  sessionId,
  draftImage,
  disabled,
  modelLocked,
}: {
  editorRef: RefObject<HTMLTextAreaElement>
  sessionId: string | null
  draftImage: boolean
  disabled: boolean
  modelLocked: boolean
}) {
  const t = useTranslate()
  const hint = useId()
  const showModel = useSettings((state) => state.showModelSwitcher)
  const thinking = useSettings((state) => state.thinking),
    search = useSettings((state) => state.search)
  const official = useProviders((state) => state.selection.providerId === 'deepseek')
  return (
    <div
      className={styles.toolbar}
      role="group"
      aria-label={t('composerTools')}
      data-testid="composer-toolbar"
    >
      {showModel && (
        <ModelPicker
          disabled={disabled || modelLocked}
          editorRef={editorRef}
          sessionId={sessionId}
          draftImage={draftImage}
        />
      )}
      <div
        className={styles.tools}
        onPointerDown={(event) => {
          if (event.button === 0 && document.activeElement === editorRef.current) {
            event.preventDefault()
          }
        }}
      >
        {(
          [
            {
              label: 'thinkingSwitch',
              tip: 'deactivatedThinkTooltip',
              on: thinking,
              change: setThinking,
              icon: <IconThinkOutline14 />,
            },
            {
              label: 'search',
              tip: 'deactivatedSearchTooltip',
              on: search,
              change: setSearch,
              icon: <IconGlobeLanguageOutline14 />,
            },
          ] as const
        ).map((tool) => (
          <Tooltip key={tool.label} content={t(official ? tool.tip : 'providerOfficialToolsOnly')}>
            <button
              type="button"
              className={styles.tool}
              disabled={disabled}
              aria-disabled={!official || disabled}
              aria-pressed={official && tool.on}
              aria-label={t(tool.label)}
              aria-describedby={official ? undefined : hint}
              onClick={() => {
                if (official) {
                  tool.change(!tool.on)
                } else {
                  showToast({ key: 'providerOfficialToolsOnly' })
                }
              }}
            >
              <span className={styles.toolFace}>
                {tool.icon}
                <span>{t(tool.label)}</span>
              </span>
            </button>
          </Tooltip>
        ))}
      </div>
      <ContextUsage sessionId={sessionId} editorRef={editorRef} disabled={disabled} />
      {!official && (
        <span id={hint} hidden>
          {t('providerOfficialToolsOnly')}
        </span>
      )}
    </div>
  )
})
