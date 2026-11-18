import { useMemo, useState } from 'react'
import { create } from 'zustand'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { ApiError } from '../../services/api/client.js'
import { getVisibleMessages } from '../../services/chat/branches.js'
import {
  applicableSummary,
  contextRounds,
  MAX_SUMMARY_CHARS,
} from '../../services/chat/contextCompression.js'
import {
  compressSession,
  editContextSummary,
  stopReply,
  useChatStore,
} from '../../services/chat/store.js'
import type { Session } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './ContextSummaryDialog.module.css'

const useTarget = create(() => ({ id: '' }))
export const openContextSummary = (id: string) => useTarget.setState({ id })
const close = () => useTarget.setState({ id: '' })

export function ContextSummaryDialog() {
  const target = useTarget((s) => s.id)
  const session = useChatStore((s) => target && s.activeId === target && s.sessionCache[target])
  return session ? <SummaryEditor key={session.id} session={session} /> : null
}

function SummaryEditor({ session }: { session: Session }) {
  const t = useTranslate()
  const { rounds, summary } = useMemo(() => {
    const rounds = contextRounds(getVisibleMessages(session), session.inherited)
    return { rounds, summary: applicableSummary(session.contextSummary, rounds) }
  }, [session])
  const [edit, setEdit] = useState<{ original: NonNullable<typeof summary>; text: string } | null>(
    null
  )
  const [error, setError] = useState<TranslationKey | null>(null)
  const busy = useChatStore((s) => Boolean(s.streaming[session.id]) || s.importingHistory)
  const compressing = useChatStore((s) => Boolean(s.compressing[session.id]))
  const text = edit && edit.original === summary ? edit.text : (summary?.text ?? '')
  const canCompress = rounds.length > (summary?.coveredRounds ?? 0)
  const editing = edit !== null && edit.original === summary
  const generate = async () => {
    setError(null)
    try {
      await compressSession(session.id)
      setEdit(null)
      showToast({ key: 'compressionSaved' })
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        return
      }
      setError(e instanceof ApiError && e.localMessage ? e.localMessage.key : 'compressionFailed')
    }
  }
  return (
    <Modal
      centered
      closable
      title={t('compressTitle')}
      onClose={close}
      footer={
        <>
          {compressing ? (
            <Button variant="outlined" onClick={() => stopReply(session.id)}>
              {t('cancel')}
            </Button>
          ) : editing && summary ? (
            <>
              <Button variant="outlined" onClick={() => setEdit(null)}>
                {t('cancel')}
              </Button>
              <Button
                disabled={busy || !text.trim() || text.trim() === summary.text}
                onClick={() => {
                  if (editContextSummary(session.id, summary, text)) {
                    setEdit(null)
                    showToast({ key: 'compressionSaved' })
                  }
                }}
              >
                {t('compressionSave')}
              </Button>
            </>
          ) : (
            <>
              {canCompress && (
                <Button
                  variant={summary ? 'outlined' : 'primary'}
                  disabled={busy}
                  onClick={() => void generate()}
                >
                  {t(summary ? 'compressionMore' : 'compressionGenerate')}
                </Button>
              )}
              {summary ? (
                <Button
                  disabled={busy}
                  onClick={() => setEdit({ original: summary, text: summary.text })}
                >
                  {t('compressionEdit')}
                </Button>
              ) : (
                !canCompress && <Button onClick={close}>{t('importFinish')}</Button>
              )}
            </>
          )}
        </>
      }
    >
      <p className={styles.hint}>{t(summary ? 'compressionSummaryHint' : 'compressionHelp')}</p>
      {summary && (
        <section className={styles.label}>
          <strong>{t('compressionCoverage', { count: summary.coveredRounds })}</strong>
          {editing ? (
            <textarea
              aria-label={t('compressionSummary')}
              value={text}
              disabled={busy}
              maxLength={MAX_SUMMARY_CHARS}
              onChange={(event) => setEdit({ original: summary, text: event.target.value })}
            />
          ) : (
            <div className={styles.summaryText}>{summary.text}</div>
          )}
          {!editing && canCompress && <small>{t('compressionChargeHint')}</small>}
        </section>
      )}
      <div aria-live="polite" className={styles.status}>
        {compressing
          ? t('compressionBusy')
          : error
            ? t(error)
            : !summary && !canCompress
              ? t('compressionUnavailable')
              : null}
      </div>
    </Modal>
  )
}
