import { useEffect, useLayoutEffect, useRef } from 'react'
import { hasOpenModal } from '../components/base/Modal.js'
import { hasTransientPanel } from '../components/base/transientPanel.js'
import { useSearchPanel } from '../components/search/searchPanelState.js'
import { hasSettingsOpen } from '../components/settings/settingsDialogState.js'
import { useMobileSider } from '../components/sider/mobileSiderState.js'
import { getDraft } from '../services/chat/drafts.js'
import { useChatStore } from '../services/chat/store.js'
import { diagnosticError, logEvent } from '../services/diagnostics/log.js'
import { bindScreenTime, isTrackingScreenTime, readScreenTime } from '../services/screenTime.js'
import { isStartupVisible, startupEndedEvent } from '../services/startup.js'
import {
  milestoneHours,
  syncTriggeredMilestones,
  triggerScreenTimeMilestone,
  useScreenTimeMilestones,
} from '../services/screenTimeMilestones.js'

export const useAutomaticScreenTimeMilestones = (atHome: boolean) => {
  const allowed = useRef(false)
  const checkOnEntry = useRef<() => void>()
  useLayoutEffect(() => {
    allowed.current = atHome
    if (atHome) {
      checkOnEntry.current?.()
    }
  }, [atHome])

  useEffect(() => {
    let disposed = false
    let reading = false
    const canShow = () => {
      if (
        disposed ||
        !allowed.current ||
        isStartupVisible() ||
        !isTrackingScreenTime() ||
        hasSettingsOpen() ||
        useMobileSider.getState().open ||
        useSearchPanel.getState().entry !== null ||
        hasOpenModal() ||
        hasTransientPanel() ||
        document.activeElement?.closest('textarea, input, [contenteditable="true"]')
      ) {
        return false
      }
      const { activeId, inheritFrom, importingHistory, streaming } = useChatStore.getState()
      const { playing, triggered } = useScreenTimeMilestones.getState()
      const { text, attachments } = getDraft(null)
      return (
        activeId === null &&
        !inheritFrom &&
        !importingHistory &&
        Object.keys(streaming).length === 0 &&
        !text.trim() &&
        !attachments.length &&
        playing === null &&
        !triggered.includes(milestoneHours[0])
      )
    }
    const check = () => {
      if (reading || !canShow()) {
        return
      }
      reading = true
      void readScreenTime(false)
        .then(({ overall, durable }) => {
          if (durable && canShow()) {
            triggerScreenTimeMilestone(overall.totalMs)
          }
        })
        .catch((error) =>
          logEvent('storage', 'screen-time-milestone.check-failed', diagnosticError(error), 'warn')
        )
        .finally(() => {
          reading = false
        })
    }
    checkOnEntry.current = check
    const stop = bindScreenTime(check)
    window.addEventListener('storage', syncTriggeredMilestones)
    window.addEventListener(startupEndedEvent, check)
    return () => {
      disposed = true
      stop()
      checkOnEntry.current = undefined
      window.removeEventListener('storage', syncTriggeredMilestones)
      window.removeEventListener(startupEndedEvent, check)
    }
  }, [])
}
