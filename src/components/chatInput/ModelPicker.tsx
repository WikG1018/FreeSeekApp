import { useMemo, useId, useState, type RefObject } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { getVisibleMessages } from '../../services/chat/branches.js'
import { getContextRounds } from '../../services/chat/reply.js'
import { useChatStore } from '../../services/chat/store.js'
import {
  OFFICIAL_MODELS,
  modelsInProfile,
  providerModelLabel,
  ProviderConfigError,
  selectModel,
  useProviders,
} from '../../services/providers.js'
import { IconCheckOutline16, IconChevronDownOutline14, IconSearchOutline16 } from '../base/icons.js'
import { useOptionPanel } from '../base/OptionPanel.js'
import panelStyles from '../base/OptionPanel.module.css'
import { showToast } from '../base/toastState.js'
import styles from './ChatInput.module.css'

type Context = { sessionId: string | null; draftImage: boolean }

export const ModelPicker = ({
  disabled,
  editorRef,
  sessionId,
  draftImage,
}: Context & { disabled: boolean; editorRef: RefObject<HTMLTextAreaElement> }) => {
  const t = useTranslate()
  const selection = useProviders((state) => state.selection)
  const profile = useProviders((state) =>
    state.profiles.find((item) => item.id === selection.providerId)
  )
  const panel = useOptionPanel(t('providerSwitch'), {
    side: 'top',
    align: 'start',
    editorRef,
    disabled,
  })
  const description = useId()
  const official = selection.providerId === 'deepseek'
  const fullName = providerModelLabel(selection.model, profile)
  const shortName = official
    ? selection.model === 'deepseek-flash'
      ? 'Flash'
      : 'V4 Pro'
    : fullName
  return (
    <>
      <button
        ref={panel.anchorRef}
        type="button"
        data-testid="composer-model"
        data-toolbar-control="model"
        className={styles.modelTrigger}
        aria-label={t('providerSwitch')}
        aria-describedby={description}
        title={fullName}
        disabled={disabled}
        {...panel.trigger}
      >
        <span className={styles.modelSurface} aria-hidden />
        <span className={styles.modelName} data-model-label="">
          {shortName}
        </span>
        <IconChevronDownOutline14 />
      </button>
      <span hidden id={description}>
        {fullName}
      </span>
      {panel.render(
        <ModelChoices
          sessionId={sessionId}
          draftImage={draftImage}
          onSelected={() => panel.close(true)}
        />
      )}
    </>
  )
}

const PAGE_SIZE = 40

const ModelChoices = ({
  sessionId,
  draftImage,
  onSelected,
}: Context & { onSelected: () => void }) => {
  const t = useTranslate()
  const { profiles, selection } = useProviders()
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(PAGE_SIZE)
  const session = useChatStore((s) => (sessionId === null ? undefined : s.sessionCache[sessionId]))
  const inherited = useChatStore((s) => (sessionId === null ? s.inheritFrom : session?.inherited))
  const hasImages = useMemo(
    () =>
      draftImage ||
      [session ? getVisibleMessages(session) : [], inherited?.messages ?? []].some((path) =>
        getContextRounds(path).some(([question]) => question.files.some((file) => file.isImage))
      ),
    [draftImage, session, inherited]
  )
  const groups = useMemo(() => {
    // Keep the active custom service and model reachable on the first page, even for very large catalogs.
    const custom = [...profiles].sort(
      (a, b) => Number(b.id === selection.providerId) - Number(a.id === selection.providerId)
    )
    return [
      {
        id: 'deepseek',
        name: t('providerOfficial'),
        vision: true,
        profile: undefined,
        models: [...OFFICIAL_MODELS] as string[],
      },
      ...custom.map((p) => ({
        id: p.id,
        name: p.name,
        vision: p.vision,
        profile: p,
        models: [
          ...new Set([
            ...(p.id === selection.providerId ? [selection.model] : []),
            ...modelsInProfile(p),
          ]),
        ],
      })),
    ]
  }, [profiles, selection, t])
  const needle = query.trim().toLocaleLowerCase()
  const results = useMemo(
    () =>
      groups.map((group) => {
        if (!needle || group.name.toLocaleLowerCase().includes(needle)) {
          return group
        }
        return {
          ...group,
          models: group.models.filter((model) => {
            const label = providerModelLabel(model, group.profile)
            return (label + ' ' + model).toLocaleLowerCase().includes(needle)
          }),
        }
      }),
    [groups, needle]
  )
  const filterable = groups.reduce((total, g) => total + g.models.length, 0) > 8
  const count = results.reduce((total, g) => total + g.models.length, 0)
  let remaining = limit
  const choose = (providerId: string, model: string) => {
    try {
      selectModel({ providerId, model })
      onSelected()
    } catch (error) {
      showToast({
        type: 'error',
        key:
          error instanceof ProviderConfigError && error.reason === 'storage'
            ? 'providerErrorStorage'
            : 'providerErrorModel',
      })
    }
  }
  return (
    <>
      {filterable && (
        <label className={panelStyles.filter}>
          <IconSearchOutline16 />
          <input
            type="search"
            aria-label={t('modelFilter')}
            placeholder={t('modelFilter')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setLimit(PAGE_SIZE)
            }}
          />
        </label>
      )}
      <div className={panelStyles.list} role="listbox" aria-label={t('providerSwitch')}>
        {results.map((group) => {
          const models = group.models.slice(0, remaining)
          remaining -= models.length
          if (!models.length) {
            return null
          }
          const official = group.id === 'deepseek'
          return (
            <div role="group" aria-label={group.name} key={group.id}>
              <div className={styles.modelGroup} aria-hidden="true">
                {group.name}
              </div>
              {models.map((model) => {
                const pro = official && model === 'deepseek-v4-pro'
                const selected = group.id === selection.providerId && model === selection.model
                const blocked: TranslationKey | null = hasImages
                  ? pro
                    ? 'providerProNoImages'
                    : !group.vision
                      ? 'providerVisionDisabled'
                      : null
                  : null
                return (
                  <button
                    type="button"
                    role="option"
                    data-panel-item=""
                    key={model}
                    aria-selected={selected}
                    disabled={Boolean(blocked)}
                    className={panelStyles.option}
                    onClick={() => choose(group.id, model)}
                  >
                    <span className={styles.modelGlyph} aria-hidden="true">
                      <svg
                        viewBox="0 0 24 24"
                        width="17"
                        height="17"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinejoin="round"
                      >
                        <path
                          d={
                            official
                              ? pro
                                ? 'm12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z'
                                : 'm13 2-9 12h7l-1 8L20 9h-8Z'
                              : 'm12 3 8 4v10l-8 4-8-4V7Z M4 7l8 4 8-4m-8 4v10'
                          }
                        />
                      </svg>
                    </span>
                    <span className={panelStyles.copy}>
                      <span>{providerModelLabel(model, group.profile)}</span>
                      {blocked ? (
                        <small className={styles.modelReason}>{t(blocked)}</small>
                      ) : official ? (
                        <small>
                          {t(pro ? 'providerProCapability' : 'providerFlashCapability')}
                        </small>
                      ) : null}
                    </span>
                    {selected && <IconCheckOutline16 />}
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>
      {!count && (
        <p role="status" className={panelStyles.empty}>
          {t('modelNoMatches')}
        </p>
      )}
      {count > limit && (
        <button
          data-panel-item=""
          type="button"
          className={panelStyles.manage}
          onClick={() => setLimit((value) => value + PAGE_SIZE)}
        >
          {t('modelShowMore')}
        </button>
      )}
    </>
  )
}
