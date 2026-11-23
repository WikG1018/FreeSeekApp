import { useLayoutEffect, useRef } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { chooseChatMode, dismissChatMode, useChatStore } from '../../services/chat/store.js'
import { useOptionPanel } from '../base/OptionPanel.js'
import styles from '../base/OptionPanel.module.css'
import { ConversationIcon } from '../sider/ConversationIcon.js'
import { closeMobileSider } from '../sider/mobileSiderState.js'
import type { ChatMode } from '../../services/chat/types.js'

type Prompt = NonNullable<ReturnType<typeof useChatStore.getState>['chatModePrompt']>

const isVisible = (node: HTMLButtonElement) => {
  const rect = node.getBoundingClientRect()
  return (
    node.isConnected &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.right > 0 &&
    rect.left < window.innerWidth &&
    rect.bottom > 0 &&
    rect.top < window.innerHeight &&
    getComputedStyle(node).visibility === 'visible'
  )
}

const visibleAnchor = (selector: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>(selector)).find(isVisible)

const ChatModeChoices = ({ prompt }: { prompt: Prompt }) => {
  const t = useTranslate()
  const sourceRef = useRef<HTMLButtonElement | null>(null)
  useLayoutEffect(() => {
    const target = prompt.kind === 'new' ? prompt.anchor : undefined
    const selector = prompt.kind === 'send' ? '[data-chat-mode-send]' : '[data-chat-mode-anchor]'
    const anchor = target && isVisible(target) ? target : visibleAnchor(selector)
    sourceRef.current = anchor ?? visibleAnchor('[data-chat-mode-fallback]') ?? null
    if (anchor) {
      anchor.setAttribute('aria-expanded', 'true')
    }
    return () => anchor?.removeAttribute('aria-expanded')
  }, [prompt])
  const panel = useOptionPanel(t('assistantChooseMode'), {
    sourceRef,
    initiallyOpen: true,
    kind: 'chat-mode',
    measureKey: prompt,
    side: prompt.kind === 'send' ? 'top' : 'bottom',
    align: 'end',
    onClose: dismissChatMode,
  })
  const options: [
    ChatMode,
    'assistantChatMode' | 'assistantTaskMode',
    'assistantChatModeHelp' | 'assistantTaskModeHelp',
  ][] = [
    ['chat', 'assistantChatMode', 'assistantChatModeHelp'],
    ['agent', 'assistantTaskMode', 'assistantTaskModeHelp'],
  ]
  return panel.render(
    <>
      {options.map(([mode, title, help]) => (
        <button
          key={mode}
          type="button"
          className={styles.option}
          aria-label={t(title)}
          data-panel-item=""
          onClick={() => {
            chooseChatMode(mode)
            closeMobileSider()
          }}
        >
          <ConversationIcon mode={mode} />
          <span className={styles.copy}>
            <strong>{t(title)}</strong>
            <small>{t(help)}</small>
          </span>
        </button>
      ))}
    </>
  )
}

export const ChatModeDialog = () => {
  const prompt = useChatStore((state) => state.chatModePrompt)
  return prompt ? <ChatModeChoices prompt={prompt} /> : null
}
