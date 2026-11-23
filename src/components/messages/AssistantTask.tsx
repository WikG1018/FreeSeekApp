import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { agentRunStatusLabels } from '../../i18n/agentWorkflow.js'
import {
  approveAgentPlan,
  endAgentRun,
  loadBackupFile,
  pauseAgentRun,
  resumeAgentRun,
  retryAgentArtifactSync,
} from '../../services/chat/store.js'
import { saveBackup } from '../../services/saveBackup.js'
import {
  canResumeAgentRun,
  isPlanWaitingForUser,
  resumesInForeground,
  taskRequestLimit,
  type AgentStopReason,
  type AgentTaskRun,
} from '../../services/tasks/runState.js'
import type { TaskArtifact, TaskProgress, TaskStep } from '../../services/tasks/tools.js'
import type { SessionArtifact } from '../../services/tasks/sessionArtifacts.js'
import { Button } from '../base/Button.js'
import {
  IconCheckOutline16,
  IconChevronDownOutline14,
  IconDownloadOutline16,
  IconFileOutline16,
  IconWarningOutline16,
} from '../base/icons.js'
import { useOptionPanel } from '../base/OptionPanel.js'
import { ArtifactMeta, ArtifactPreview } from '../session/SessionArtifacts.js'
import { TaskBrowserViewer } from './TaskBrowserViewer.js'
import { TaskReminder } from './TaskReminder.js'
import { workspaceDeviceFiles } from '../../services/tasks/workspacePlatform.js'
import { useToolApprovals } from '../../services/tasks/extensions.js'
import type { AssistantMessage } from '../../services/chat/types.js'
import { replyActivityPhase } from './ReplyActivity.js'
import styles from './AssistantTask.module.css'

const labels = {
  todo: 'taskTodo',
  working: 'taskWorking',
  done: 'taskDone',
  failed: 'taskFailed',
  stopped: 'taskStopped',
} as const
const kinds: Record<TaskStep['kind'], TranslationKey> = {
  read: 'taskReadAttachment',
  search: 'taskSearch',
  xlsx: 'taskCreateSheet',
  docx: 'taskCreateDocument',
  md: 'taskCreateMarkdown',
  web: 'taskReadWeb',
  github: 'taskBrowseGitHub',
  browser: 'taskBrowser',
  table: 'taskAnalyzeTable',
  calculate: 'taskCalculate',
  data: 'taskCreateData',
  tool: 'agentStepTool',
  plan: 'taskPlan',
  files: 'agentStepFiles',
  verification: 'agentStepVerify',
  project: 'agentStepProject',
  script: 'agentStepScript',
  model3d: 'agentStepModel',
  delegate: 'projectDelegateStep',
  integration: 'projectIntegrationStep',
}

const webFailures = {
  blocked: 'taskWebBlocked',
  dns: 'taskWebDns',
  redirect: 'taskWebRedirect',
  timeout: 'taskWebTimeout',
  unsupported: 'taskWebUnsupported',
  network: 'taskWebNetwork',
  browser: 'taskWebBrowser',
  http: 'taskWebHttp',
  'rate-limit': 'taskWebRateLimit',
  empty: 'taskWebEmpty',
} as const

const stepDetails: Partial<Record<string, TranslationKey>> = {
  'read-budget': 'agentStepReadBudget',
  'invalid-arguments': 'agentStepArguments',
  'empty-range': 'agentStepEmptyRange',
  'unverified-revision': 'agentStepRevision',
  'attachment-missing': 'agentStepMissing',
  'attachment-unreadable': 'agentStepUnreadable',
  'source-truncated': 'agentReadTruncated',
  'waiting-browser': 'agentReasonBrowser',
  'project-patch-rejected': 'agentStepPatchRejected',
  'project-archive-invalid': 'agentStepArchiveInvalid',
  'project-outdated': 'projectOldVersion',
  'project-workspace-missing': 'projectMissing',
  'project-script-error': 'agentStepScriptError',
  'project-timeout': 'agentStepScriptTimeout',
  'project-runtime-unavailable': 'agentStepRuntimeUnavailable',
  'model-invalid': 'agentStepModelInvalid',
  'artifact-save-failed': 'agentStepSaveFailed',
  'external-denied': 'projectToolDenied',
  'external-failed': 'projectToolFailed',
}

const runReasons: Partial<Record<AgentStopReason, TranslationKey>> = {
  'budget-time': 'agentReasonTime',
  'budget-requests': 'agentReasonRequests',
  'context-limit': 'agentReasonContext',
  'output-limit': 'agentReasonOutput',
  'tools-unavailable': 'agentReasonTools',
  'provider-error': 'agentReasonProvider',
  'request-unconfirmed': 'agentReasonUnconfirmed',
  'tool-unconfirmed': 'agentReasonToolUnconfirmed',
  'provider-rate-limit': 'agentReasonRateLimit',
  'provider-timeout': 'agentReasonModelTimeout',
  'connection-changed': 'agentReasonConnectionChanged',
  'source-failed': 'agentReasonSource',
  'waiting-browser': 'agentReasonBrowser',
  'waiting-foreground': 'agentReasonForeground',
  'criteria-unmet': 'agentReasonCriteria',
  'no-progress': 'agentReasonNoProgress',
  interrupted: 'agentReasonInterrupted',
  'host-busy': 'agentReasonHostBusy',
  'host-unavailable': 'agentReasonHostUnavailable',
  'checkpoint-missing': 'agentReasonCheckpointMissing',
  storage: 'agentReasonStorage',
  'notification-permission': 'agentReasonNotification',
  'system-timeout': 'agentReasonSystemTimeout',
}

const safePublicLink = (value: string | undefined) => {
  if (!value) {
    return undefined
  }
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : undefined
  } catch {
    return undefined
  }
}

const EvidenceList = ({ items }: { items: NonNullable<TaskStep['evidence']> }) => {
  const t = useTranslate()
  return (
    <ul className={styles.evidenceList}>
      {items.map((item, index) => {
        const { range, url } = item
        const href = safePublicLink(url)
        return (
          <li key={item.sourceId + '-' + index} className={styles.evidenceItem}>
            <strong>{item.title}</strong>
            {(item.path || item.revision) && (
              <span className={styles.evidenceLocation}>
                {[item.path, item.revision].filter(Boolean).join(' · ')}
              </span>
            )}
            <p className={styles.evidenceLocation}>
              {[
                range
                  ? t(range.unit === 'lines' ? 'agentReadLines' : 'agentReadChars', {
                      from: range.unit === 'lines' ? range.start : range.start + 1,
                      to: range.end,
                    })
                  : undefined,
                item.sourceTruncated
                  ? t('agentReadTruncated')
                  : item.partial
                    ? t('agentReadPartial')
                    : undefined,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {item.excerpt && <pre className={styles.evidenceExcerpt}>{item.excerpt}</pre>}
            {href && (
              <a href={href} target="_blank" rel="noreferrer">
                {t('taskBrowserOriginal')}
              </a>
            )}
          </li>
        )
      })}
    </ul>
  )
}

const ToolStep = ({ step, onPreview }: { step: TaskStep; onPreview: (source: string) => void }) => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const contentId = useId()
  const kind = t(kinds[step.kind])
  const state = t(
    step.detail === 'waiting-approval' ? 'agentWaitingToolApproval' : labels[step.status]
  )
  const hasEvidence = Boolean(step.evidence?.length)
  const previewSource = step.kind === 'browser' || !hasEvidence ? step.source : undefined
  const icon =
    step.status === 'failed' ? (
      <IconWarningOutline16 />
    ) : step.status === 'done' ? (
      <IconCheckOutline16 />
    ) : (
      <span className={styles.stepDot} />
    )
  return (
    <li className={styles.step} data-status={step.status} data-agent-step={step.id}>
      <span className={styles.stepIcon} aria-hidden="true">
        {icon}
      </span>
      <div className={styles.stepMain}>
        <div className={styles.stepTop}>
          <span className={styles.stepText}>
            <strong>{kind}</strong>
            {step.file && <span className={styles.stepSubject}>{step.file}</span>}
          </span>
          <span
            className={styles.stepStatus}
            aria-label={t('agentStepState', { kind, status: state })}
          >
            {state}
            {step.elapsedMs !== undefined && step.elapsedMs >= 100 && (
              <small className={styles.stepDuration}>
                {t('agentStepDuration', { seconds: (step.elapsedMs / 1000).toFixed(1) })}
              </small>
            )}
          </span>
        </div>
        {step.failure && <p className={styles.stepFailure}>{t(webFailures[step.failure])}</p>}
        {step.detail && !step.failure && (
          <p className={styles.stepDetail}>
            {t(
              (Object.hasOwn(stepDetails, step.detail) && stepDetails[step.detail]) ||
                (step.status === 'stopped' ? 'agentRunStopped' : 'agentStepCouldNotComplete')
            )}
          </p>
        )}
        {step.retryAt && step.retryAt > Date.now() ? (
          <p className={styles.stepDetail}>
            {t('agentStepRetryAfter', {
              time: new Date(step.retryAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              }),
            })}
          </p>
        ) : null}
        {hasEvidence && step.evidence && (
          <>
            <button
              className={styles.browserLink}
              type="button"
              aria-expanded={open}
              aria-controls={open ? contentId : undefined}
              onClick={() => setOpen((value) => !value)}
            >
              <IconChevronDownOutline14 />
              {t('agentStepEvidence')}
            </button>
            {open && (
              <div id={contentId} className={styles.evidenceReveal}>
                <EvidenceList items={step.evidence} />
              </div>
            )}
          </>
        )}
        {previewSource && (
          <button
            className={styles.browserLink}
            type="button"
            onClick={() => onPreview(previewSource)}
          >
            {t('taskBrowserPreview')}
          </button>
        )}
        {step.output && (
          <details className={styles.toolHistory}>
            <summary>{t('agentStepOutput')}</summary>
            <pre className={styles.evidenceExcerpt}>{step.output}</pre>
          </details>
        )}
      </div>
    </li>
  )
}

const VISIBLE_STEPS = 4
const AgentToolSteps = ({
  steps,
  onPreview,
  inline = false,
}: {
  steps: TaskStep[]
  onPreview: (source: string) => void
  inline?: boolean
}) => {
  const t = useTranslate()
  const [expanded, setExpanded] = useState(false)
  const contentId = useId()
  const hidden = Math.max(0, steps.length - VISIBLE_STEPS)
  const previousFailures = steps.slice(0, hidden).filter(({ status }) => status === 'failed').length
  return (
    <div
      className={styles.timeline}
      data-testid={inline ? 'agent-inline-tool-steps' : 'agent-tool-steps'}
    >
      {hidden > 0 && (
        <button
          className={styles.more}
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded((value) => !value)}
        >
          <IconChevronDownOutline14 />
          {t(expanded ? 'agentStepsFewer' : 'agentStepsMore', { count: hidden })}
          {previousFailures > 0 && (
            <span className={styles.stepFailure}>
              {t('agentEarlierFailures', { count: previousFailures })}
            </span>
          )}
        </button>
      )}
      <ol id={contentId} className={styles.stepList} aria-label={t('agentStepsDetails')}>
        {steps.slice(expanded ? 0 : hidden).map((step) => (
          <ToolStep key={step.id} step={step} onPreview={onPreview} />
        ))}
      </ol>
    </div>
  )
}

export const AgentInlineToolSteps = ({ steps }: { steps: TaskStep[] }) => {
  const [source, setSource] = useState<string>()
  return (
    <div className={styles.inlineSteps} data-testid="agent-inline-tools">
      <AgentToolSteps steps={steps} onPreview={setSource} inline />
      {source && <TaskBrowserViewer source={source} close={() => setSource(undefined)} />}
    </div>
  )
}

const PlanChecks = ({ labels: steps }: { labels: TaskProgress['plan'] }) => {
  const t = useTranslate()
  return (
    <ol className={styles.checks}>
      {steps.map((item, index) => (
        <li key={index} data-status={item.status}>
          <span aria-hidden="true" className={styles.checkIcon}>
            {item.status === 'done' ? <IconCheckOutline16 /> : index + 1}
          </span>
          <span>{item.label}</span>
          <small>{t(labels[item.status])}</small>
        </li>
      ))}
    </ol>
  )
}

const scrollToCurrentStep = (list: HTMLDivElement | null) => {
  const step = list?.querySelector<HTMLElement>('[data-status="working"]')
  if (step && list) {
    const top = step.getBoundingClientRect().top - list.getBoundingClientRect().top
    list.scrollTop += top - Math.max(0, (list.clientHeight - step.offsetHeight) / 2)
  }
}

const AgentBudget = ({ run, active }: { run: AgentTaskRun; active: boolean }) => {
  const t = useTranslate()
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) {
      return
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])
  const elapsed =
    (run.elapsedBeforeResume ?? 0) + Math.max(run.elapsedMs, active ? now - run.startedAt : 0)
  return (
    <div className={styles.budget} data-testid="agent-run-budget">
      <span>
        {t('agentSpent', {
          elapsed: Math.floor(elapsed / 60_000),
          used: run.totalRequests,
          requests: taskRequestLimit(run),
        })}
      </span>
    </div>
  )
}

const ResumeAction = ({
  run,
  sessionId,
  replyId,
  outlined = false,
}: {
  run: AgentTaskRun
  sessionId: string
  replyId: string
  outlined?: boolean
}) => {
  const t = useTranslate()
  const [now, setNow] = useState(Date.now)
  const [failed, setFailed] = useState(false)
  const retryAt = run.retryAt ?? 0
  useEffect(() => {
    setNow(Date.now())
    if (retryAt <= Date.now()) {
      return
    }
    const timer = window.setTimeout(() => setNow(Date.now()), retryAt - Date.now())
    return () => window.clearTimeout(timer)
  }, [retryAt])
  const addRequests = run.totalRequests >= taskRequestLimit(run)
  const retryUnconfirmed = Boolean(run.requestInFlight || run.reason === 'tool-unconfirmed')
  const useCurrentConnection =
    run.reason === 'connection-changed' || run.reason === 'tools-unavailable'
  const label =
    now < retryAt
      ? t('agentRetryAvailableAt', {
          time: new Date(retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        })
      : addRequests
        ? t(retryUnconfirmed ? 'agentRetryWithBudget' : 'agentAddRequestBudget', {
            requests: run.budgetRequests,
          })
        : retryUnconfirmed
          ? t('agentRetryUnconfirmed')
          : useCurrentConnection
            ? t('agentResumeWithSelected')
            : t(
                resumesInForeground(run.reason)
                  ? 'agentResumeForeground'
                  : run.status === 'partial' && !outlined
                    ? 'agentContinueRemaining'
                    : 'agentResume'
              )
  return (
    <>
      {retryUnconfirmed &&
        run.reason !== 'request-unconfirmed' &&
        run.reason !== 'tool-unconfirmed' && (
          <small className={styles.runNote}>{t('agentReasonUnconfirmed')}</small>
        )}
      <Button
        size="s"
        variant={outlined ? 'outlined' : undefined}
        disabled={now < retryAt}
        onClick={() => {
          setFailed(
            !resumeAgentRun(sessionId, replyId, {
              addRequests,
              retryUnconfirmed,
              useCurrentConnection,
            })
          )
        }}
      >
        {label}
      </Button>
      {failed && (
        <small className={styles.runNote} role="alert">
          {t('agentResumeNotReady')}
        </small>
      )}
    </>
  )
}

const AssistantTask = ({
  task,
  sessionId,
  replyId,
  current,
  busy,
  streaming,
  phase,
  onPreview,
  onPlanReply,
  onPlanApproved,
}: {
  task: TaskProgress
  sessionId: string
  replyId: string
  current: boolean
  busy: boolean
  streaming: boolean
  phase?: { label: string; file?: string; stepId?: string }
  onPreview: (source: string) => void
  onPlanReply: () => void
  onPlanApproved: () => void
}) => {
  const t = useTranslate()
  const [confirmEnd, setConfirmEnd] = useState(false)
  const [sync, setSync] = useState<'working' | 'failed'>()
  const scrollRef = useRef<HTMLDivElement>(null)
  const run = task.run
  const review = current && !busy && isPlanWaitingForUser(run)
  const canResume = Boolean(run && current && !busy && canResumeAgentRun(run))
  const canPause = Boolean(
    run && current && streaming && (run.status === 'running' || run.status === 'planning')
  )
  const reason = run?.reason && runReasons[run.reason]
  const hasPlan = task.plan.length > 0
  const canEnd = canResume || canPause || review
  const history = phase?.stepId ? task.steps.filter(({ id }) => id !== phase.stepId) : task.steps
  const hasCurrentStep =
    task.plan.some(({ status }) => status === 'working') ||
    (!hasPlan && history.some(({ status }) => status === 'working'))
  useLayoutEffect(() => {
    scrollToCurrentStep(scrollRef.current)
  }, [])
  const title =
    run &&
    t(
      run.status === 'running' && run.background
        ? 'agentRunBackground'
        : agentRunStatusLabels[run.status]
    )
  return (
    <section
      className={styles.run}
      data-testid="agent-run-summary"
      data-status={run?.status}
      aria-label={title || t('taskPlan')}
      tabIndex={-1}
    >
      <div className={styles.runHeading}>
        <div className={styles.runStatus}>
          <strong>{t(hasPlan ? 'agentExecutionPlan' : 'agentStepsDetails')}</strong>
          {hasPlan && (
            <span>
              {task.plan.filter(({ status }) => status === 'done').length}/{task.plan.length}
            </span>
          )}
        </div>
        {hasCurrentStep && (hasPlan ? task.plan.length : history.length) > 5 && (
          <button
            type="button"
            className={styles.locate}
            onClick={() => scrollToCurrentStep(scrollRef.current)}
          >
            {t('agentLocateStep')}
          </button>
        )}
      </div>
      {phase && (
        <div className={styles.liveStep} data-testid="agent-live-step" role="status">
          <span className={styles.progressDot} aria-hidden="true" />
          <div>
            <strong>{phase.label}</strong>
            {phase.file && <small title={phase.file}>{phase.file}</small>}
          </div>
        </div>
      )}
      <div
        ref={scrollRef}
        className={styles.runScroll}
        data-testid="agent-progress-scroll"
        data-scroll-edge=""
      >
        <div className={styles.scrollContent} data-scroll-edge-content="">
          {reason && run && (
            <p className={styles.runNote}>{t(reason, { minutes: run.budgetMinutes })}</p>
          )}
          {current && workspaceDeviceFiles() && (
            <TaskReminder sessionId={sessionId} canResume={canResume} />
          )}
          {!!task.artifactSyncPending && (
            <div className={styles.syncNote} role="status">
              <span>{t('agentArtifactSyncPending', { count: task.artifactSyncPending })}</span>
              {!busy && (
                <Button
                  variant="outlined"
                  size="s"
                  disabled={sync === 'working'}
                  onClick={() => {
                    setSync('working')
                    void retryAgentArtifactSync(sessionId, replyId).then((ok) =>
                      setSync(ok ? undefined : 'failed')
                    )
                  }}
                >
                  {t('agentArtifactSyncRetry')}
                </Button>
              )}
              {sync === 'failed' && <span>{t('agentArtifactSyncFailed')}</span>}
            </div>
          )}
          {task.warning && !reason && (
            <p className={styles.runNote} role="status">
              {t(task.warning === 'limit' ? 'taskLimit' : 'taskToolsUnavailable')}
            </p>
          )}
          {run?.mode === 'goal' && run.criteria.length > 0 && (
            <div className={styles.plan}>
              <small className={styles.budget}>
                {t('agentGoalProgress', { met: run.met.length, total: run.criteria.length })}
              </small>
              <PlanChecks
                labels={run.criteria.map((label, index) => ({
                  label,
                  status: run.met.includes(index + 1) ? 'done' : 'todo',
                }))}
              />
            </div>
          )}
          {hasPlan && (
            <div>
              {run?.mode === 'plan' && run.revision > 0 && (
                <div className={styles.planVersion}>
                  {t('agentPlanVersion', { revision: run.revision })}
                </div>
              )}
              <PlanChecks labels={task.plan} />
            </div>
          )}
          {run && <AgentBudget run={run} active={canPause} />}
          {!!history.length &&
            (hasPlan ? (
              <details className={styles.toolHistory}>
                <summary>{t('agentStepHistory', { count: history.length })}</summary>
                <AgentToolSteps steps={history} onPreview={onPreview} />
              </details>
            ) : (
              <AgentToolSteps steps={history} onPreview={onPreview} />
            ))}
          {!phase && !hasPlan && !task.steps.length && !reason && !task.warning && (
            <p className={styles.runNote}>{title || t('agentRunPlanning')}</p>
          )}
        </div>
      </div>
      {canEnd && !confirmEnd && (
        <div className={styles.actions}>
          {review && run.status === 'awaiting-review' && hasPlan && (
            <AgentPlanActions
              sessionId={sessionId}
              replyId={replyId}
              revision={run.revision}
              onReply={onPlanReply}
              onApproved={onPlanApproved}
            />
          )}
          {review && run.status === 'awaiting-input' && (
            <Button variant="outlined" size="s" onClick={onPlanReply}>
              {t('agentAnswerQuestion')}
            </Button>
          )}
          {canResume && run && <ResumeAction run={run} sessionId={sessionId} replyId={replyId} />}
          {canPause && (
            <Button size="s" onClick={() => pauseAgentRun(sessionId, replyId)}>
              {t('agentPause')}
            </Button>
          )}
          <Button size="s" variant="outlined" onClick={() => setConfirmEnd(true)}>
            {t('agentEnd')}
          </Button>
        </div>
      )}
      {confirmEnd && canEnd && (
        <div className={styles.endConfirmation}>
          <strong>{t('agentConfirmEnd')}</strong>
          <small>{t('agentEndExplanation')}</small>
          <div className={styles.actions}>
            <Button size="s" variant="outlined" onClick={() => setConfirmEnd(false)}>
              {t('cancel')}
            </Button>
            <Button
              size="s"
              variant="danger"
              onClick={() => {
                endAgentRun(sessionId, replyId)
                setConfirmEnd(false)
              }}
            >
              {t('agentEnd')}
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}

const AgentPlanActions = ({
  sessionId,
  replyId,
  revision,
  onReply,
  onApproved,
}: {
  sessionId: string
  replyId: string
  revision: number
  onReply: () => void
  onApproved?: () => void
}) => {
  const t = useTranslate()
  const [approvalFailed, setApprovalFailed] = useState(false)
  return (
    <>
      <div className={styles.planPromptActions}>
        <Button variant="outlined" size="s" onClick={onReply}>
          {t('agentAskToRevise')}
        </Button>
        <Button
          size="s"
          onClick={() => {
            if (approveAgentPlan(sessionId, replyId, revision)) {
              onApproved?.()
            } else {
              setApprovalFailed(true)
            }
          }}
        >
          {t('agentApprovePlan')}
        </Button>
      </div>
      {approvalFailed && (
        <p role="alert" className={styles.runNote}>
          {t('agentPlanApprovalFailed')}
        </p>
      )}
    </>
  )
}

export const AgentPlanPrompt = ({
  task,
  sessionId,
  replyId,
  current,
  onReply,
}: {
  task: TaskProgress
  sessionId: string
  replyId: string
  current: boolean
  onReply: () => void
}) => {
  const t = useTranslate()
  const run = task.run
  if (run?.question) {
    return (
      <section
        className={styles.planPrompt}
        aria-label={t('agentPlanQuestion')}
        data-testid="agent-plan-question"
      >
        <p className={styles.planPromptText}>{run.question}</p>
        {current && run.status === 'awaiting-input' && (
          <Button variant="outlined" size="s" onClick={onReply}>
            {t('agentAnswerQuestion')}
          </Button>
        )}
      </section>
    )
  }
  if (!current || run?.status !== 'awaiting-review' || !task.plan.length) {
    return null
  }
  return (
    <section
      className={styles.planPrompt}
      aria-label={t('agentPlanReady')}
      data-testid="agent-plan-review"
    >
      <div className={styles.planPromptHeading}>
        <IconFileOutline16 />
        <strong>{t('agentPlanReady')}</strong>
        <span>
          {t('agentPlanVersion', { revision: run.revision })} ·{' '}
          {t('agentPlanStepCount', { count: task.plan.length })}
        </span>
      </div>
      <p className={styles.planPromptText} role="status">
        {t('agentPlanDecision')}
      </p>
      <AgentPlanActions
        sessionId={sessionId}
        replyId={replyId}
        revision={run.revision}
        onReply={onReply}
      />
    </section>
  )
}

export const AgentRunRecovery = ({
  task,
  sessionId,
  replyId,
}: {
  task: TaskProgress
  sessionId: string
  replyId: string
}) => {
  const t = useTranslate()
  const run = task.run
  const reason = run?.reason && runReasons[run.reason]
  if (!run || !reason || !canResumeAgentRun(run)) {
    return null
  }
  return (
    <div className={styles.recovery} role="status" data-testid="agent-run-recovery">
      <IconWarningOutline16 />
      <span>{t(reason, { minutes: run.budgetMinutes })}</span>
      <ResumeAction run={run} sessionId={sessionId} replyId={replyId} outlined />
    </div>
  )
}

export const AgentProgressButton = ({
  task,
  message,
  sessionId,
  replyId,
  current,
  busy,
  streaming,
  editorRef,
}: {
  task: TaskProgress
  sessionId: string
  replyId: string
  current: boolean
  busy: boolean
  streaming: boolean
  message?: AssistantMessage
  editorRef?: RefObject<HTMLTextAreaElement>
}) => {
  const t = useTranslate()
  const [webPreview, setWebPreview] = useState<string>()
  const panel = useOptionPanel(t('agentActiveRun'), {
    kind: 'progress',
    side: 'top',
    align: current ? 'center' : 'start',
    editorRef,
    focusFirst: false,
  })
  const run = task.run
  const workingPlan = task.plan.findIndex(({ status }) => status === 'working')
  const active = Boolean(
    current && streaming && (run?.status === 'running' || run?.status === 'planning')
  )
  const workingTool = active ? task.steps.find(({ status }) => status === 'working') : undefined
  const needsApproval = useToolApprovals(
    ({ requests }) => active && requests.some((request) => request.sessionId === sessionId)
  )
  const modelPhase = useMemo(() => {
    if (!active || !message) {
      return undefined
    }
    return message.status === 'pending' ? 'agentConnectingModel' : replyActivityPhase(message)
  }, [active, message])
  const phase = active
    ? {
        label: needsApproval
          ? t('agentWaitingToolApproval')
          : workingTool
            ? t('agentRunCurrentTool', { label: t(kinds[workingTool.kind]) })
            : t(modelPhase ?? 'replyActivityWaiting'),
        file: workingTool?.file,
        stepId: workingTool?.id,
      }
    : undefined
  const label = !current
    ? t('agentStepsDetails')
    : run?.status === 'awaiting-review'
      ? t('agentViewPlan')
      : run?.status === 'running' && workingPlan !== -1
        ? t('agentRunCurrentStep', {
            step: workingPlan + 1,
            total: task.plan.length,
            label: task.plan[workingPlan].label,
          })
        : phase
          ? phase.label
          : run
            ? t(
                run.status === 'running' && run.background
                  ? 'agentRunBackground'
                  : agentRunStatusLabels[run.status]
              )
            : t('agentStepsDetails')
  return (
    <>
      <button
        type="button"
        className={styles.progressButton}
        data-current={current}
        data-testid={current ? 'agent-progress-dock' : 'agent-history-progress'}
        ref={panel.anchorRef}
        {...panel.trigger}
      >
        {current && run && (
          <span className={styles.progressDot} aria-hidden="true" data-status={run.status} />
        )}
        <span
          className={styles.progressText}
          title={label}
          aria-live={current ? 'polite' : undefined}
        >
          {label}
        </span>
        <IconChevronDownOutline14 />
      </button>
      {panel.render(
        <AssistantTask
          task={task}
          sessionId={sessionId}
          replyId={replyId}
          current={current}
          busy={busy}
          streaming={streaming}
          phase={phase}
          onPlanReply={() => {
            panel.close()
            editorRef?.current?.focus({ preventScroll: true })
          }}
          onPlanApproved={() => panel.close()}
          onPreview={(source) => {
            panel.close()
            setWebPreview(source)
          }}
        />
      )}
      {webPreview && (
        <TaskBrowserViewer
          source={webPreview}
          close={() => {
            setWebPreview(undefined)
            panel.show()
          }}
        />
      )}
    </>
  )
}

const OutputFile = ({
  file,
  sessionId,
  createdAt,
  round,
}: {
  file: TaskArtifact
  sessionId: string
  createdAt: number
  round?: number
}) => {
  const t = useTranslate()
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const [preview, setPreview] = useState(false)
  const artifact = useMemo<SessionArtifact>(
    () => ({ ...file, createdAt: file.createdAt ?? createdAt, round }),
    [file, createdAt, round]
  )
  const save = async () => {
    setStatus('saving')
    try {
      const blob = await loadBackupFile(file.id)
      if (!blob || blob.size !== file.size) {
        setStatus('failed')
        return
      }
      setStatus((await saveBackup(file.name, blob)) ? 'saved' : 'idle')
    } catch {
      setStatus('failed')
    }
  }
  return (
    <div className={styles.output}>
      <div className={styles.outputRow}>
        <button
          type="button"
          className={styles.file}
          aria-label={t('agentReadyOutput', { name: file.name })}
          onClick={() => setPreview(true)}
          data-testid="task-output"
        >
          <span className={styles.fileIcon} aria-hidden="true">
            <IconFileOutline16 />
          </span>
          <span className={styles.fileDetails}>
            <strong>{file.name}</strong>
            <ArtifactMeta file={artifact} />
          </span>
        </button>
        <button
          type="button"
          className={styles.outputSave}
          aria-label={t('taskSaveOutput', { name: file.name })}
          disabled={status === 'saving'}
          onClick={() => void save()}
        >
          <IconDownloadOutline16 />
        </button>
      </div>
      {status !== 'idle' && (
        <p
          className={styles.fileStatus}
          role={status === 'failed' ? 'alert' : 'status'}
          data-status={status}
        >
          {t(
            status === 'saving'
              ? 'taskOutputSaving'
              : status === 'saved'
                ? 'taskOutputSaved'
                : 'taskOutputSaveFailed'
          )}
        </p>
      )}
      {preview && (
        <ArtifactPreview file={artifact} sessionId={sessionId} close={() => setPreview(false)} />
      )}
    </div>
  )
}

export const AgentOutputs = ({
  task,
  sessionId,
  createdAt,
  round,
}: {
  task: TaskProgress
  sessionId: string
  createdAt: number
  round?: number
}) =>
  task.artifacts.length > 0 ? (
    <div className={styles.outputs}>
      {task.artifacts.map((file) => (
        <OutputFile
          file={file}
          createdAt={createdAt}
          sessionId={sessionId}
          round={round}
          key={file.id}
        />
      ))}
    </div>
  ) : null
