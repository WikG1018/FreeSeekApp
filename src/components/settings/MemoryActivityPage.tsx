import { useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import {
  undoAutomaticMemory,
  useAssistantLibrary,
  type MemoryActivity,
} from '../../services/assistants/library.js'
import { loadSession } from '../../services/chat/db.js'
import { Button } from '../base/Button.js'
import { assistantErrorKey } from './MemoryDialogs.js'
import { SettingsDisclosure } from './SettingsDisclosure.js'
import { Row, Section } from './SettingsRows.js'
import styles from './AssistantSettings.module.css'

const ActivityItem = ({ item }: { item: MemoryActivity }) => {
  const t = useTranslate()
  const active = useAssistantLibrary((state) =>
    state.data.memories.some(({ revision }) => revision === item.current.revision)
  )
  const agent = useAssistantLibrary((state) =>
    state.data.agents.find(({ id }) => id === item.current.agentId)
  )
  const [source, setSource] = useState<string>()
  const [error, setError] = useState<TranslationKey>()
  const [busy, setBusy] = useState(false)
  const loadSource = async () => {
    setBusy(true)
    try {
      const ref = item.current.source
      const session = ref && (await loadSession(ref.sessionId))
      const message = session?.messages.find(({ id }) => id === ref?.messageId)
      setSource(message?.role === 'user' ? message.content.slice(0, 400) : '')
    } catch {
      setSource('')
    } finally {
      setBusy(false)
    }
  }
  return (
    <SettingsDisclosure
      title={item.current.text}
      description={
        t(
          item.undone
            ? 'assistantMemoryUndone'
            : item.prior
              ? 'assistantMemoryUpdated'
              : 'assistantMemorySaved'
        ) +
        ' · ' +
        t('agentConversationRound', { round: item.round }) +
        ' · ' +
        (agent?.name ?? t(item.current.agentId ? 'assistantPrivate' : 'assistantGlobal'))
      }
    >
      {item.prior && <Row label={t('assistantExistingMemory')} description={item.prior.text} />}
      {source !== undefined && (
        <Row
          label={t('assistantSuggestionSource')}
          description={source || t('assistantMemorySourceUnavailable')}
        />
      )}
      <div className={styles.activityActions}>
        {source === undefined && (
          <Button variant="outlined" size="s" disabled={busy} onClick={() => void loadSource()}>
            {t('assistantViewMemorySource')}
          </Button>
        )}
        {active && !item.undone && (
          <Button
            variant="outlined"
            size="s"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              setError(undefined)
              try {
                await undoAutomaticMemory(item.id)
              } catch (failure) {
                setError(assistantErrorKey(failure))
              } finally {
                setBusy(false)
              }
            }}
          >
            {t('assistantUndoMemory')}
          </Button>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {t(error)}
          </p>
        )}
      </div>
    </SettingsDisclosure>
  )
}

export const MemoryActivityPage = () => {
  const t = useTranslate()
  const { activity, suggestions } = useAssistantLibrary((state) => state.data)
  return (
    <>
      {activity.length ? (
        activity.map((item) => <ActivityItem key={item.id} item={item} />)
      ) : (
        <p role="status" className={styles.hint}>
          {t('assistantMemoryActivityEmpty')}
        </p>
      )}
      {suggestions.length > 0 && (
        <SettingsDisclosure title={t('assistantLegacyMemorySuggestions')}>
          <Section>
            {suggestions.map((item) => (
              <Row
                key={item.id}
                label={item.text}
                description={t('agentConversationRound', { round: item.round })}
              />
            ))}
          </Section>
        </SettingsDisclosure>
      )}
    </>
  )
}
