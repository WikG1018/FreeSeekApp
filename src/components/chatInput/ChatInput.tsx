import clsx from 'clsx'
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  IconAddOutline16,
  IconCameraOutline16,
  IconCloseOutline16,
  IconFileOutline16,
  IconGlobeLanguageOutline14,
  IconImageOutline16,
  IconSendOutline16,
  IconStopFill16,
  IconThinkOutline14,
} from '../base/icons.js'
import { setSearch, setThinking, useSettings } from '../../services/settings.js'
import { useIsMobile } from '../../app/viewport.js'
import { sendMessage, stopReply, useChatStore } from '../../services/chat/store.js'
import {
  addDraftFiles,
  EMPTY_DRAFT,
  getDraft,
  prepareDraftMessage,
  removeDraftAttachment,
  retryDraftAttachment,
  setDraftText,
  useDrafts,
} from '../../services/chat/drafts.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import { openAppPermissionSettings } from '../../services/speech/micPermission.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { Tooltip } from '../base/Tooltip.js'
import { ensureApiKey } from '../settings/settingsDialogState.js'
import { DragMask, useFileDrop } from './DragMask.js'
import { showToast } from '../base/toastState.js'
import { ACCEPT, useUploads } from '../../services/attachments.js'
import { DraftAttachments } from './DraftAttachments.js'
import { useVoiceInput } from './useVoiceInput.js'
import { VoiceButton } from './VoiceButton.js'
import { Spectrum } from './Spectrum.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './ChatInput.module.css'
import { useProviders } from '../../services/providers.js'
import { ModelPicker } from '../settings/ProviderSettings.js'

/** 输入框：自适应高度的文本框 + 文件 + 深度思考与智能搜索开关 + 语音输入 + 发送 / 停止 */
export const ChatInput = memo(function ChatInput({ sessionId }: { sessionId: string | null }) {
  // 切换目标时释放录音、转写和 DOM 状态；文字与附件由草稿服务保留。
  return <Input key={sessionId === null ? 'new' : `session:${sessionId}`} sessionId={sessionId} />
})

const Input = ({ sessionId }: { sessionId: string | null }) => {
  const t = useTranslate()
  const draft = useDrafts((state) => state.drafts.get(sessionId) ?? EMPTY_DRAFT)
  const { text, attachments } = draft
  const setText = (value: string) => setDraftText(sessionId, value)
  const draftReady = useUploads((state) => prepareDraftMessage(draft, state.tasks) !== null)
  const streaming = useChatStore(
    (state) => sessionId !== null && Object.hasOwn(state.streaming, sessionId)
  )
  const thinking = useSettings((state) => state.thinking)
  const importingHistory = useChatStore((state) => state.importingHistory)
  const isMobile = useIsMobile()
  const search = useSettings((state) => state.search)
  const custom = useProviders((state) => state.selection.providerId !== 'deepseek')
  const showModelSwitcher = useSettings((state) => state.showModelSwitcher)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const togglesRef = useRef<HTMLDivElement>(null)
  const textareaWrapperRef = useRef<HTMLDivElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)
  /** 附件面板展开状态：点 + 展开拍照/相册/文件，选完或点外部收起 */
  const [attachOpen, setAttachOpen] = useState(false)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    if (!attachOpen) {
      return
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        setAttachOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [attachOpen])

  // 输入框高度变化时平滑展开/收起（镜像层测量高度，外层过渡）
  useEffect(() => {
    const mirror = mirrorRef.current
    const wrapper = textareaWrapperRef.current
    if (!mirror || !wrapper) {
      return
    }
    const update = () => {
      wrapper.style.height = `${mirror.offsetHeight}px`
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(mirror)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const toggles = togglesRef.current
    if (!toggles) {
      return
    }
    // 标签始终显示：只在极窄屏压缩字号，不隐藏文字
    const update = () => {
      toggles.classList.toggle(styles.tightToggles, toggles.scrollWidth > toggles.clientWidth)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(toggles)
    return () => observer.disconnect()
  }, [t])

  const acceptFiles = (files: File[]) => {
    if (files.length === 0 || useChatStore.getState().importingHistory || !ensureApiKey()) {
      return
    }
    const error = addDraftFiles(sessionId, files, useSettings.getState().apiKey ?? '')
    if (error) {
      showToast(error)
    }
  }
  const retryFile = useCallback(
    (id: string) => {
      if (!useChatStore.getState().importingHistory && ensureApiKey()) {
        retryDraftAttachment(sessionId, id, useSettings.getState().apiKey ?? '')
      }
    },
    [sessionId]
  )
  const removeFile = useCallback(
    (id: string) => {
      if (!useChatStore.getState().importingHistory) {
        removeDraftAttachment(sessionId, id)
      }
    },
    [sessionId]
  )
  const dragging = useFileDrop(acceptFiles)

  /** 转写结果插入到光标处，并把光标移到插入内容之后 */
  const voice = useVoiceInput((transcript) => {
    const textarea = textareaRef.current
    const current = getDraft(sessionId).text
    const start = textarea?.selectionStart ?? current.length
    const end = textarea?.selectionEnd ?? current.length
    setText(current.slice(0, start) + transcript + current.slice(end))
    requestAnimationFrame(() => {
      textarea?.focus({ preventScroll: true })
      textarea?.setSelectionRange(start + transcript.length, start + transcript.length)
    })
  })

  // 欢迎页导入后会话 ID 不变，不能依赖卸载取消语音；订阅开始事件也覆盖快速完成的导入。
  const cancelVoice = voice.cancel
  useEffect(() => {
    if (custom) {
      cancelVoice()
      stopReadAloud()
    }
  }, [custom, cancelVoice])
  useEffect(
    () =>
      useChatStore.subscribe((state, previous) => {
        if (state.importingHistory && !previous.importingHistory) {
          cancelVoice()
        }
      }),
    [cancelVoice]
  )

  // 移动端录音时用频谱替代输入框内容
  const recording = voice.status === 'recording'

  // 排队、上传中或上传失败的附件都留在输入框，全部上传成功后才能发送
  const canSend = !importingHistory && !streaming && voice.status === 'idle' && draftReady
  const compact =
    isMobile &&
    !editing &&
    !text &&
    !attachments.length &&
    !attachOpen &&
    !showModelSwitcher &&
    voice.status === 'idle' &&
    (custom || (!thinking && !search))

  const send = () => {
    if (
      useChatStore.getState().importingHistory ||
      voice.status !== 'idle' ||
      !prepareDraftMessage(getDraft(sessionId), useUploads.getState().tasks)
    ) {
      return
    }
    // 文本与上传完成态由提交动作读取最新快照，不使用上一次渲染的草稿。
    if (!ensureApiKey() || !sendMessage(sessionId)) {
      return
    }
    stopReadAloud()
    setEditing(false)
    if (isMobile) {
      textareaRef.current?.blur()
    } else {
      textareaRef.current?.focus()
    }
  }

  return (
    <div
      ref={wrapperRef}
      data-testid="chat-composer"
      className={clsx(
        styles.wrapper,
        sessionId === null ? styles.home : styles.session,
        showModelSwitcher && styles.hasModelSwitcher,
        compact && styles.compact
      )}
      onFocusCapture={() => {
        if (document.activeElement === textareaRef.current) {
          setEditing(true)
        }
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setEditing(false)
        }
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          textareaRef.current?.focus({ preventScroll: true })
        }
      }}
    >
      <DraftAttachments items={attachments} onRetry={retryFile} onRemove={removeFile} />
      {showModelSwitcher ? <ModelPicker disabled={streaming || importingHistory} /> : null}
      <div ref={textareaWrapperRef} className={styles.textareaWrapper}>
        <textarea
          ref={textareaRef}
          className={clsx(styles.textarea, recording && isMobile && styles.textareaHidden)}
          placeholder={t('chatInputPlaceholderChat')}
          rows={2}
          // 手机版不显示发送按钮，交给输入法回车键发送
          enterKeyHint="send"
          // 移动端不自动聚焦，避免一打开就弹出键盘
          autoFocus={!isMobile}
          disabled={importingHistory}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onMouseDown={(event) => {
            // 首次点击时手动聚焦，避免 Safari 把整个页面滚到输入框位置。
            if (isMobile && event.button === 0 && document.activeElement !== event.currentTarget) {
              event.preventDefault()
              event.currentTarget.focus({ preventScroll: true })
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              send()
            }
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files)
            if (files.length > 0) {
              event.preventDefault()
              acceptFiles(files)
            }
          }}
        />
        {recording && isMobile ? <Spectrum getAnalyser={voice.getAnalyser} /> : null}
        <div ref={mirrorRef} className={styles.mirror} aria-hidden>
          {`${text}\n`}
        </div>
      </div>
      {attachOpen ? (
        <div className={styles.attachPanel} role="group" aria-label={t('attachPanelLabel')}>
          <button
            type="button"
            className={styles.attachOption}
            onClick={() => {
              setAttachOpen(false)
              if (ensureApiKey()) {
                cameraInputRef.current?.click()
              }
            }}
          >
            <IconCameraOutline16 />
            <span>{t('attachCamera')}</span>
          </button>
          <button
            type="button"
            className={styles.attachOption}
            onClick={() => {
              setAttachOpen(false)
              if (ensureApiKey()) {
                imageInputRef.current?.click()
              }
            }}
          >
            <IconImageOutline16 />
            <span>{t('attachGallery')}</span>
          </button>
          <button
            type="button"
            className={styles.attachOption}
            onClick={() => {
              setAttachOpen(false)
              if (ensureApiKey()) {
                fileInputRef.current?.click()
              }
            }}
          >
            <IconFileOutline16 />
            <span>{t('attachFiles')}</span>
          </button>
        </div>
      ) : null}
      <div className={styles.functionRow}>
        {/* 深度思考 / 智能搜索开关，tooltip 在按钮上方 */}
        <div ref={togglesRef} className={styles.toggles}>
          {custom ? null : (
            <>
              <Tooltip content={t('deactivatedThinkTooltip')}>
                <button
                  type="button"
                  className={clsx(styles.toggle, thinking && styles.selected)}
                  aria-label={t('thinkingSwitch')}
                  aria-pressed={thinking}
                  onClick={() => setThinking(!thinking)}
                >
                  <IconThinkOutline14 />
                  <span className={styles.toggleLabel}>{t('thinkingSwitch')}</span>
                </button>
              </Tooltip>
              <Tooltip content={t('deactivatedSearchTooltip')}>
                <button
                  type="button"
                  className={clsx(styles.toggle, search && styles.selected)}
                  aria-label={t('search')}
                  aria-pressed={search}
                  onClick={() => setSearch(!search)}
                >
                  <IconGlobeLanguageOutline14 />
                  <span className={styles.toggleLabel}>{t('search')}</span>
                </button>
              </Tooltip>
            </>
          )}
        </div>
        <div className={styles.right}>
          {/* 桌面保留三个并列按钮；手机把「麦克风 / 发送」合并成一个位置 */}
          {isMobile || custom ? null : (
            <VoiceButton
              status={voice.status}
              disabled={!voice.available}
              seconds={voice.seconds}
              onClick={() => {
                if (
                  voice.status !== 'idle' ||
                  (!useChatStore.getState().importingHistory && ensureApiKey())
                ) {
                  void voice.toggle()
                }
              }}
            />
          )}
          <IconButton
            size={isMobile ? 's' : 'm'}
            className={styles.attachTrigger}
            tone="primary"
            hitArea
            icon={attachOpen ? <IconCloseOutline16 /> : <IconAddOutline16 />}
            tooltip={attachOpen ? t('close') : t('attachPanelLabel')}
            aria-expanded={attachOpen}
            disabled={importingHistory}
            onClick={() => setAttachOpen((value) => !value)}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            accept={ACCEPT}
            onChange={(event) => {
              acceptFiles(Array.from(event.target.files ?? []))
              event.target.value = ''
            }}
          />
          <input
            ref={imageInputRef}
            type="file"
            multiple
            hidden
            accept="image/*"
            onChange={(event) => {
              acceptFiles(Array.from(event.target.files ?? []))
              event.target.value = ''
            }}
          />
          {/* 拍照：capture 让 Android 直接打开相机，桌面端退化为选图 */}
          <input
            ref={cameraInputRef}
            type="file"
            hidden
            accept="image/*"
            capture="environment"
            onChange={(event) => {
              acceptFiles(Array.from(event.target.files ?? []))
              event.target.value = ''
            }}
          />
          {isMobile ? (
            // 手机版：空输入显示麦克风，有文字/附件变为发送，生成中变为停止
            streaming && sessionId ? (
              <button
                type="button"
                className={styles.sendButton}
                aria-label={t('chatInputStopButtonTooltip')}
                onClick={() => {
                  stopReadAloud()
                  stopReply(sessionId)
                }}
              >
                <IconStopFill16 />
              </button>
            ) : canSend ? (
              <button
                type="button"
                className={styles.sendButton}
                aria-label={t('send')}
                onClick={send}
              >
                <IconSendOutline16 />
              </button>
            ) : custom ? (
              <button
                type="button"
                className={clsx(styles.sendButton, styles.disabled)}
                aria-label={t('send')}
                aria-disabled="true"
                onClick={send}
              >
                <IconSendOutline16 />
              </button>
            ) : (
              <VoiceButton
                status={voice.status}
                disabled={!voice.available}
                seconds={voice.seconds}
                onClick={() => {
                  if (
                    voice.status !== 'idle' ||
                    (!useChatStore.getState().importingHistory && ensureApiKey())
                  ) {
                    void voice.toggle()
                  }
                }}
              />
            )
          ) : streaming && sessionId ? (
            <button
              type="button"
              className={styles.sendButton}
              aria-label={t('chatInputStopButtonTooltip')}
              onClick={() => {
                stopReadAloud()
                stopReply(sessionId)
              }}
            >
              <IconStopFill16 />
            </button>
          ) : (
            <button
              type="button"
              className={clsx(styles.sendButton, !canSend && styles.disabled)}
              aria-label={t('send')}
              aria-disabled={!canSend}
              onClick={send}
            >
              <IconSendOutline16 />
            </button>
          )}
        </div>
      </div>
      {dragging ? <DragMask /> : null}
      {voice.permissionBlocked ? (
        <Modal
          title={t('voiceInputPermissionTitle')}
          centered
          onClose={voice.dismissPermission}
          footer={
            <>
              <Button variant="outlined" autoFocus onClick={voice.dismissPermission}>
                {t('cancel')}
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  void openAppPermissionSettings()
                  voice.dismissPermission()
                }}
              >
                {t('openSystemSettings')}
              </Button>
            </>
          }
        >
          {t('voiceInputPermissionText')}
        </Modal>
      ) : null}
    </div>
  )
}
