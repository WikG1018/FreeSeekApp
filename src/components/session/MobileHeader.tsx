import type { ReactNode, Ref } from 'react'
import { IconMenuOutline20, IconNewChatOutline20 } from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { newChat } from '../../services/chat/store.js'
import { IconButton } from '../base/IconButton.js'
import { openMobileSider, useMobileSider } from '../sider/mobileSiderState.js'
import { SessionTitle } from './SessionTitle.js'
import styles from './MobileHeader.module.css'

/**
 * 移动端顶栏：左侧菜单打开侧边栏；会话页再显示标题与开启新对话。
 * 三个部件都是同一种玻璃胶囊（左圆键 / 标题 / 右圆键），滚动后浮现渐隐。
 */
export const MobileHeader = ({
  title,
  headerRef,
  openAssistant,
  onTop,
  artifactsButton,
  voicesButton,
}: {
  title?: string
  headerRef?: Ref<HTMLDivElement>
  openAssistant?: () => void
  onTop?: () => void
  artifactsButton?: ReactNode
  voicesButton?: ReactNode
}) => {
  const t = useTranslate()
  const open = useMobileSider((state) => state.open)
  return (
    <div
      ref={headerRef}
      className={styles.header}
      data-testid="chat-header"
      data-artifacts={!!artifactsButton || undefined}
      data-voices={!!voicesButton || undefined}
    >
      <span className={styles.action}>
        <IconButton
          size="m"
          tone="primary"
          hitArea
          icon={<IconMenuOutline20 />}
          aria-label={t('expandSiderbarButton')}
          aria-controls="mobile-sider"
          aria-expanded={open}
          data-chat-mode-fallback
          onClick={openMobileSider}
        />
      </span>
      {title === undefined ? null : (
        <>
          {openAssistant && onTop ? (
            <SessionTitle
              title={title}
              className={styles.title}
              textClassName={styles.titleText}
              onTop={onTop}
              onAssistant={openAssistant}
            />
          ) : (
            <div className={styles.title}>
              <span className={styles.titleText}>{title}</span>
            </div>
          )}
          <div className={styles.right}>
            {artifactsButton}
            {voicesButton}
            <span className={styles.action}>
              <IconButton
                size="m"
                tone="primary"
                hitArea
                icon={<IconNewChatOutline20 />}
                aria-label={t('newChat')}
                data-chat-mode-anchor
                onClick={(event) => newChat(event.currentTarget)}
              />
            </span>
          </div>
        </>
      )}
    </div>
  )
}
