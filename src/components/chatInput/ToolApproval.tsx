import { useTranslate } from '../../i18n/index.js'
import { chooseToolApproval, useToolApprovals } from '../../services/tasks/extensions.js'
import { Button } from '../base/Button.js'
import styles from './ChatInput.module.css'

export const ToolApproval = ({ sessionId }: { sessionId: string }) => {
  const t = useTranslate()
  const request = useToolApprovals(({ requests }) =>
    requests.find((item) => item.sessionId === sessionId)
  )
  if (!request) {
    return null
  }
  return (
    <section
      className={styles.toolApproval}
      aria-label={t('projectToolRequest', { tool: request.tool })}
    >
      <strong>{t('projectToolRequest', { tool: request.tool })}</strong>
      <small>{request.endpoint}</small>
      <details>
        <summary>{t('projectToolArguments')}</summary>
        <pre>{request.arguments}</pre>
      </details>
      <div>
        <Button variant="outlined" size="s" onClick={() => chooseToolApproval(request.id, false)}>
          {t('projectToolDeny')}
        </Button>
        <Button size="s" onClick={() => chooseToolApproval(request.id, true)}>
          {t('projectToolAllow')}
        </Button>
      </div>
    </section>
  )
}
