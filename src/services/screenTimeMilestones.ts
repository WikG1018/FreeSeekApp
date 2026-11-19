import { create } from 'zustand'

export const milestoneHours = [1000, 500, 100] as const
export type MilestoneHours = (typeof milestoneHours)[number]

const keyFor = (hours: MilestoneHours) => 'freeseek:screen-time-milestone:' + hours
const readTriggered = () =>
  milestoneHours.filter((hours) => localStorage.getItem(keyFor(hours)) === '1')
const loadTriggered = () => {
  try {
    return readTriggered()
  } catch {
    return []
  }
}

export const useScreenTimeMilestones = create<{
  triggered: MilestoneHours[]
  playing: MilestoneHours | null
}>(() => ({ triggered: loadTriggered(), playing: null }))

/** Only record the milestone that is about to be shown, including on upgrade. */
export const triggerScreenTimeMilestone = (totalMs: number) => {
  const hours = milestoneHours.find((level) => totalMs >= level * 3_600_000)
  if (!hours || useScreenTimeMilestones.getState().playing !== null) {
    return
  }
  try {
    const triggered = readTriggered()
    if (triggered.includes(hours)) {
      return
    }
    localStorage.setItem(keyFor(hours), '1')
    useScreenTimeMilestones.setState({
      triggered: milestoneHours.filter((level) => level === hours || triggered.includes(level)),
      playing: hours,
    })
  } catch {
    // Wait for a durable marker before showing an automatic celebration.
  }
}

export const replayScreenTimeMilestone = (hours: MilestoneHours) => {
  const { playing, triggered } = useScreenTimeMilestones.getState()
  if (playing === null && triggered.includes(hours)) {
    useScreenTimeMilestones.setState({ playing: hours })
  }
}

export const closeScreenTimeMilestone = () => useScreenTimeMilestones.setState({ playing: null })

export const syncTriggeredMilestones = (event: StorageEvent) => {
  if (event.key === null || milestoneHours.some((hours) => event.key === keyFor(hours))) {
    useScreenTimeMilestones.setState({ triggered: loadTriggered() })
  }
}
