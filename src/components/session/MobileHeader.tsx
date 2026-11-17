import type { Ref } from 'react'
import { IconMenuOutline20, IconNewChatOutline20 } from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { newChat } from '../../services/chat/store.js'
import { IconButton } from '../base/IconButton.js'
import { openMobileSider, useMobileSider } from '../sider/mobileSiderState.js'
import styles from './MobileHeader.module.css'

/**
 * 移动端顶栏：左侧菜单打开侧边栏；会话页再显示标题与开启新对话。
 * 三个部件都是同一种玻璃胶囊（左圆键 / 标题 / 右圆键），滚动后浮现渐隐。
 */
export const MobileHeader = ({
  title,
  headerRef,
}: {
  title?: string
  headerRef?: Ref<HTMLDivElement>
}) => {
  const t = useTranslate()
  const open = useMobileSider((state) => state.open)
  return (
    <div ref={headerRef} className={styles.header} data-testid="chat-header">
      <span className={styles.action}>
        <IconButton
          size="m"
          tone="primary"
          hitArea
          icon={<IconMenuOutline20 />}
          aria-label={t('expandSiderbarButton')}
          aria-controls="mobile-sider"
          aria-expanded={open}
          onClick={openMobileSider}
        />
      </span>
      {title === undefined ? null : (
        <>
          <div className={styles.title}>
            <span className={styles.titleText}>{title}</span>
          </div>
          <span className={styles.action}>
            <IconButton
              size="m"
              tone="primary"
              hitArea
              icon={<IconNewChatOutline20 />}
              aria-label={t('newChat')}
              onClick={newChat}
            />
          </span>
        </>
      )}
    </div>
  )
}
