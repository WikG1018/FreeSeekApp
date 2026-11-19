import { memo, useRef, type RefObject } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  activeReasoning,
  providerModelLabel,
  setReasoningOverride,
  useProviders,
} from '../../services/providers.js'
import {
  setSearch,
  setThirdPartySearchOn,
  thirdPartySearchKey,
  useSettings,
} from '../../services/settings.js'
import {
  IconChevronDownOutline14,
  IconGlobeLanguageOutline14,
  IconThinkOutline14,
} from '../base/icons.js'
import { Tooltip } from '../base/Tooltip.js'
import { showToast } from '../base/toastState.js'
import { ReasoningOptions, reasoningLabels } from '../base/ReasoningOptions.js'
import { useOptionPanel } from '../base/OptionPanel.js'
import { ContextUsage } from './ContextUsage.js'
import { ModelPicker } from './ModelPicker.js'
import { useComposerToolbarLayout } from './useComposerToolbarLayout.js'
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
  const state = useProviders()
  const settings = useSettings()
  const { selection, reasoningOverride } = state
  const official = selection.providerId === 'deepseek'
  const profile = state.profiles.find((item) => item.id === selection.providerId)
  const control = activeReasoning(state, settings)
  const level =
    control &&
    reasoningOverride?.sessionId === sessionId &&
    control.levels.includes(reasoningOverride.level)
      ? reasoningOverride.level
      : control?.defaultLevel
  const showPicker = Boolean(settings.showModelSwitcher && settings.showReasoningPicker && control)
  const active = level !== undefined && level !== 'off'
  const switchable = Boolean(
    control?.levels.includes('off') && control.levels.some((value) => value !== 'off')
  )
  const searchReady = official || Boolean(thirdPartySearchKey(settings))
  const searchOn = official ? settings.search : settings.thirdPartySearchOn
  const title = t('reasoningStrength')
  const panel = useOptionPanel(title, {
    kind: 'reasoning',
    side: 'top',
    editorRef,
    disabled: !showPicker || disabled,
  })
  const rowRef = useRef<HTMLDivElement>(null)
  const displayLevel = level && t(reasoningLabels[level])
  useComposerToolbarLayout(
    rowRef,
    [
      providerModelLabel(selection.model, profile),
      settings.showModelSwitcher,
      showPicker,
      displayLevel,
      settings.locale,
      settings.fontScale,
    ].join('\n')
  )
  const keepKeyboard = (event: React.PointerEvent) => {
    if (event.button === 0 && document.activeElement === editorRef.current) {
      event.preventDefault()
    }
  }
  return (
    <div
      ref={rowRef}
      className={styles.toolbar}
      role="group"
      aria-label={t('composerTools')}
      data-testid="composer-toolbar"
    >
      {settings.showModelSwitcher && (
        <ModelPicker
          disabled={disabled || modelLocked}
          editorRef={editorRef}
          sessionId={sessionId}
          draftImage={draftImage}
        />
      )}
      <div className={styles.tools} onPointerDown={keepKeyboard}>
        {showPicker && control && level !== undefined ? (
          <button
            ref={panel.anchorRef}
            type="button"
            className={styles.tool}
            disabled={disabled}
            aria-label={title + ' · ' + displayLevel}
            aria-pressed={active}
            data-toolbar-control="effort"
            data-testid="composer-reasoning"
            {...panel.trigger}
          >
            <span className={styles.toolFace}>
              <IconThinkOutline14 />
              <span>
                <span className={styles.effortPrefix}>{t('reasoningShort')} · </span>
                {displayLevel}
              </span>
              <span className={styles.effortChevron}>
                <IconChevronDownOutline14 />
              </span>
            </span>
          </button>
        ) : (
          <Tooltip
            content={t(
              switchable
                ? 'deactivatedThinkTooltip'
                : control
                  ? 'reasoningNoToggle'
                  : 'reasoningUnsupported'
            )}
          >
            <button
              type="button"
              className={styles.tool}
              aria-label={t('thinkingSwitch')}
              aria-pressed={active}
              disabled={disabled}
              aria-disabled={!switchable || disabled}
              data-toolbar-control="effort"
              onClick={() => {
                if (!control || !switchable) {
                  showToast({ key: control ? 'reasoningNoToggle' : 'reasoningUnsupported' })
                  return
                }
                const on =
                  control.defaultLevel !== 'off'
                    ? control.defaultLevel
                    : (control.levels.find((item) => item !== 'off') ?? control.defaultLevel)
                setReasoningOverride(sessionId, active ? 'off' : on)
              }}
            >
              <span className={styles.toolFace}>
                <IconThinkOutline14 />
                <span>
                  <span className={styles.effortFull}>{t('thinkingSwitch')}</span>
                  <span className={styles.effortShort}>{t('reasoningShort')}</span>
                </span>
              </span>
            </button>
          </Tooltip>
        )}
        <Tooltip
          content={t(searchReady ? 'deactivatedSearchTooltip' : 'thirdPartySearchSetupHint')}
        >
          <button
            type="button"
            className={styles.tool}
            aria-pressed={searchReady && searchOn}
            aria-disabled={!searchReady || disabled}
            aria-label={t('search')}
            disabled={disabled}
            data-toolbar-control="search"
            onClick={() => {
              if (!searchReady) {
                showToast({ key: 'thirdPartySearchSetupHint' })
                return
              }
              if (official) {
                setSearch(!searchOn)
              } else {
                setThirdPartySearchOn(!searchOn)
              }
            }}
          >
            <span className={styles.toolFace}>
              <IconGlobeLanguageOutline14 />
              <span>
                <span className={styles.searchFull}>{t('search')}</span>
                <span className={styles.searchShort}>{t('searchShort')}</span>
              </span>
            </span>
          </button>
        </Tooltip>
      </div>
      <ContextUsage sessionId={sessionId} editorRef={editorRef} disabled={disabled} />
      {showPicker &&
        control &&
        level !== undefined &&
        panel.render(
          <ReasoningOptions
            title={title}
            control={control}
            level={level}
            showDefault
            choose={(value) => {
              setReasoningOverride(sessionId, value)
              panel.close(true)
            }}
          />
        )}
    </div>
  )
})
