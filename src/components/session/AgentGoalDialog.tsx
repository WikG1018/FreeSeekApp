import { useId, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { chooseAgentGoal, dismissAgentGoal, useChatStore } from '../../services/chat/store.js'
import { goalBudgets, type AgentBudgetMinutes } from '../../services/tasks/runState.js'
import { Button } from '../base/Button.js'
import { Modal, closeTopModal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import styles from './AgentGoalDialog.module.css'

const presets = { '5': 5, '15': 15, '30': 30 } as const satisfies Record<string, AgentBudgetMinutes>
type Budget = keyof typeof presets
const budgetOptions = Object.keys(presets) as Budget[]

const GoalSetup = () => {
  const t = useTranslate()
  const form = useId()
  const criteriaId = useId()
  const hintId = useId()
  const errorId = useId()
  const [criteria, setCriteria] = useState('')
  const [budget, setBudget] = useState<Budget>('15')
  const [error, setError] = useState<'criteria' | 'start'>()
  return (
    <Modal
      title={t('agentGoalSetup')}
      onClose={dismissAgentGoal}
      className={styles.sheet}
      footer={
        <>
          <Button variant="outlined" onClick={closeTopModal}>
            {t('cancel')}
          </Button>
          <Button form={form} type="submit" disabled={!criteria.trim()}>
            {t('agentGoalStart')}
          </Button>
        </>
      }
    >
      <form
        className={styles.fields}
        id={form}
        onSubmit={(event) => {
          event.preventDefault()
          const items = criteria
            .split('\n')
            .map((item) => item.trim())
            .filter(Boolean)
          if (items.length < 1 || items.length > 8 || items.some((item) => item.length > 240)) {
            setError('criteria')
            return
          }
          if (!chooseAgentGoal(items, presets[budget])) {
            setError('start')
          }
        }}
      >
        <div className={styles.field}>
          <label htmlFor={criteriaId}>{t('agentGoalCriteria')}</label>
          <textarea
            id={criteriaId}
            value={criteria}
            rows={4}
            maxLength={1935}
            aria-describedby={error === 'criteria' ? `${hintId} ${errorId}` : hintId}
            aria-invalid={error === 'criteria' || undefined}
            onChange={(event) => {
              setCriteria(event.target.value)
              setError(undefined)
            }}
          />
          <small id={hintId}>{t('agentGoalCriteriaHint')}</small>
          {error === 'criteria' && (
            <p id={errorId} role="alert">
              {t('agentGoalCriteriaInvalid')}
            </p>
          )}
        </div>
        <div className={styles.field}>
          <span className={styles.fieldTitle}>{t('agentGoalBudget')}</span>
          <Select<Budget>
            ariaLabel={t('agentGoalBudget')}
            value={budget}
            options={budgetOptions.map((value) => ({
              value,
              label: t('agentGoalBudgetRequests', { requests: goalBudgets[presets[value]] }),
            }))}
            onChange={(value) => {
              setBudget(value)
              if (error === 'start') {
                setError(undefined)
              }
            }}
          />
          <small>{t('agentGoalBudgetHint')}</small>
          {error === 'start' && <p role="alert">{t('agentGoalStartFailed')}</p>}
        </div>
      </form>
    </Modal>
  )
}

export const AgentGoalDialog = () => {
  const prompt = useChatStore((state) => state.agentGoalPrompt)
  return prompt ? <GoalSetup key={prompt.sessionId ?? 'draft'} /> : null
}
