import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { Capacitor } from '@capacitor/core'
import { App as NativeApp } from '@capacitor/app'
import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { useMobileViewport } from '../../app/viewport.js'
import { listenMediaQuery } from '../../utils/mediaQuery.js'
import { IconChevronLeftOutline16, IconCloseOutline16 } from '../base/icons.js'
import { Button } from '../base/Button.js'
import { closeTopModal, hasOpenModal } from '../base/Modal.js'
import { closeTransientPanel, hasTransientPanel } from '../base/transientPanel.js'
import { registerWebBack } from '../../app/webBack.js'
import { useDialogFocus } from '../base/useDialogFocus.js'
import {
  closeSettings,
  finishCloseSettings,
  openSettings,
  parentSettingsPage,
  useSettingsDialog,
  type SettingsPageId,
} from './settingsDialogState.js'
import { pageTitles, SettingsDirectory } from './SettingsDirectory.js'
import { SettingsLeaveContext } from './useSettingsLeave.js'
import styles from './Settings.module.css'

const wide = matchMedia('(min-width: 900px) and (min-height: 540px)')
const subscribe = (notify: () => void) => listenMediaQuery(wide, notify)
type Direction = 'initial' | 'forward' | 'back' | 'switch'

export const SettingsShell = ({
  children,
  backTarget,
}: {
  backTarget?: SettingsPageId
  children: (
    page: SettingsPageId,
    open: (page: SettingsPageId) => void,
    finish: (next?: SettingsPageId) => void
  ) => ReactNode
}) => {
  const t = useTranslate(),
    wideLayout = useSyncExternalStore(subscribe, () => wide.matches)
  const { page: requested, closing } = useSettingsDialog()
  const page = wideLayout && requested === 'home' ? 'account' : requested
  useLayoutEffect(() => {
    if (wideLayout && requested === 'home' && !closing) {
      openSettings('account')
    }
  }, [wideLayout, requested, closing])
  const parent = backTarget ?? parentSettingsPage(page)
  const canGoBack = page !== 'home' && (!wideLayout || parent !== 'home')
  const scale = useSettings((s) => s.fontScale)
  const layer = useMobileViewport(true, Capacitor.getPlatform() === 'android' ? 1 : scale)
  const dialog = useRef<HTMLDivElement>(null),
    scroll = useRef<HTMLDivElement>(null),
    title = useRef<HTMLHeadingElement>(null)
  const guard = useRef<((after: () => void) => void) | null>(null)
  const positions = useRef(new Map<SettingsPageId, number>())
  const restore = useRef<{ top: number; target?: SettingsPageId } | null>(null)
  const [direction, setDirection] = useState<Direction>('initial')
  const [presented, setPresented] = useState(false)
  useLayoutEffect(() => {
    // 先确定屏外位置，下一帧由同一条 transition 进出，快速返回也从当前位置反向。
    dialog.current?.getBoundingClientRect()
    const frame = requestAnimationFrame(() => setPresented(true))
    return () => cancelAnimationFrame(frame)
  }, [])
  useDialogFocus(dialog, () => !hasOpenModal() && !hasTransientPanel())

  const leave = (action: () => void) => {
    if (guard.current) {
      guard.current(action)
    } else {
      action()
    }
  }
  const navigate = (next: SettingsPageId, motion: Direction) => {
    if (next === page) {
      return
    }
    positions.current.set(page, scroll.current?.scrollTop ?? 0)
    restore.current = {
      top: motion === 'back' ? (positions.current.get(next) ?? 0) : 0,
      target: motion === 'back' ? page : undefined,
    }
    setDirection(motion)
    openSettings(next, { showTutorial: page === 'guide' && motion === 'forward' })
  }
  const go = (next: SettingsPageId, motion: Direction) => {
    if (next !== page) {
      leave(() => navigate(next, motion))
    }
  }
  const close = () => leave(closeSettings)
  const back = () => {
    if (canGoBack) {
      go(parent, 'back')
    } else {
      close()
    }
  }
  const backRef = useRef(back)
  backRef.current = back
  useLayoutEffect(() => {
    const pending = restore.current
    if (!pending || !scroll.current) {
      return
    }
    const trigger = pending.target
      ? scroll.current.querySelector<HTMLElement>('[data-settings-target="' + pending.target + '"]')
      : null
    ;(trigger ?? title.current)?.focus({ preventScroll: true })
    scroll.current.scrollTop = pending.top
    restore.current = null
  }, [page, wideLayout])
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !hasOpenModal() && !hasTransientPanel()) {
        e.preventDefault()
        backRef.current()
      }
    }
    document.addEventListener('keydown', key)
    const sub = Capacitor.isNativePlatform()
      ? NativeApp.addListener('backButton', () => {
          if (!closeTransientPanel() && !closeTopModal()) {
            backRef.current()
          }
        })
      : null
    // 网页版/PWA：系统返回等同浏览器后退，先关弹层，再逐级返回或关闭设置。
    const dropWebBack = Capacitor.isNativePlatform()
      ? undefined
      : registerWebBack(() => {
          if (!closeTransientPanel() && !closeTopModal()) {
            backRef.current()
          }
          return true
        })
    return () => {
      document.removeEventListener('keydown', key)
      dropWebBack?.()
      void sub?.then((handle) => handle.remove())
    }
  }, [])
  useEffect(() => {
    if (!closing) {
      return
    }
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finishCloseSettings()
      return
    }
    // 动画被系统关闭或窗口进入后台时也要完成卸载。
    const id = setTimeout(finishCloseSettings, 220)
    return () => clearTimeout(id)
  }, [closing])
  const home = page === 'home'
  return (
    <SettingsLeaveContext.Provider value={guard}>
      <div
        ref={layer}
        className={styles.layer}
        data-presented={presented && !closing}
        data-closing={closing}
      >
        <div className={styles.scrim} aria-hidden onClick={close} />
        <div
          ref={dialog}
          className={styles.page}
          role="dialog"
          aria-modal="true"
          aria-label={t(pageTitles[page])}
          tabIndex={-1}
          data-split={wideLayout}
          onTransitionEnd={(e) => {
            if (closing && e.target === e.currentTarget && e.propertyName === 'transform') {
              finishCloseSettings()
            }
          }}
        >
          {wideLayout && (
            <aside className={styles.rail}>
              <div className={styles.railTitle}>{t('settings')}</div>
              <SettingsDirectory rail active={page} open={(next) => go(next, 'switch')} />
              <div className={styles.railExit}>
                <Button variant="outlined" onClick={close}>
                  <IconChevronLeftOutline16 />
                  {t('settingsReturnToChat')}
                </Button>
              </div>
            </aside>
          )}
          <div className={styles.detail}>
            <header
              className={styles.header}
              data-directory={home}
              data-api-settings={page === 'account' || page.startsWith('provider') || undefined}
            >
              {/*
                手机版：首页没有返回键，就给一个关闭键——iPhone 主屏幕版没有系统返回，
                没有它设置页就是进得去出不来。二级页显示返回箭头。
                电脑版：不用头部返回键——左栏底部已有「返回对话」，
                再放一个箭头会造成两个返回入口。
              */}
              {canGoBack && !wideLayout ? (
                <button className={styles.back} aria-label={t('back')} type="button" onClick={back}>
                  <IconChevronLeftOutline16 />
                </button>
              ) : null}
              <h1 className={styles.title} ref={title} tabIndex={-1} data-dialog-initial>
                {t(pageTitles[page])}
              </h1>
              {!wideLayout &&
                (canGoBack ? (
                  // 二级页补右侧占位，保证标题居中；首页标题左对齐
                  <span className={styles.backPlaceholder} aria-hidden />
                ) : (
                  <button
                    className={styles.close}
                    aria-label={t('close')}
                    type="button"
                    data-settings-close=""
                    onClick={close}
                  >
                    <IconCloseOutline16 />
                  </button>
                ))}
            </header>
            <div
              ref={scroll}
              className={styles.scroll}
              data-testid="settings-scroll"
              data-scroll-edge=""
            >
              <div
                key={page}
                className={styles.pageBody}
                data-scroll-edge-content=""
                data-direction={direction}
                data-settings-page={page}
                data-provider-footer={
                  page === 'providerAccess' ||
                  page === 'providerConnection' ||
                  page === 'providerModel' ||
                  page === 'providerSearch' ||
                  undefined
                }
              >
                {home ? (
                  <SettingsDirectory active={page} open={(next) => go(next, 'forward')} />
                ) : (
                  children(
                    page,
                    (next) => go(next, 'forward'),
                    (next = parent) => navigate(next, next === parent ? 'back' : 'forward')
                  )
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </SettingsLeaveContext.Provider>
  )
}
