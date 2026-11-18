import { useIsMobile } from '../../app/viewport.js'
import { Modal } from '../base/Modal.js'
import { useTranslate } from '../../i18n/index.js'
import { IconCloseOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { closeSearchPanel, useSearchPanel } from './searchPanelState.js'
import { SourceCard } from './SourceCard.js'
import styles from './SearchPanel.module.css'

/** 右侧「搜索结果」面板 */
export const SearchPanel = () => {
  const t = useTranslate()
  const mobile = useIsMobile()
  const entry = useSearchPanel((state) => state.entry)
  const sources = useSearchPanel((state) => state.sources)
  if (!entry) {
    return null
  }
  const cards = sources.map((source) => (
    <SourceCard key={source.url} source={source} className={styles.item} />
  ))
  if (mobile) {
    return (
      <Modal
        title={t('searchResult')}
        closable
        onClose={closeSearchPanel}
        mainClassName={styles.mobileSources}
      >
        {cards}
      </Modal>
    )
  }
  return (
    <aside className={styles.panel}>
      <div className={styles.header}>
        <div role="heading" className={styles.title}>
          {t('searchResult')}
        </div>
        <IconButton
          icon={<IconCloseOutline16 />}
          aria-label={t('close')}
          onClick={closeSearchPanel}
        />
      </div>
      <div className={styles.content}>{cards}</div>
    </aside>
  )
}
