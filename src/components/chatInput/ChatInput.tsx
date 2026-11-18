import clsx from 'clsx'
import { memo, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import {
  IconAddOutline16,
  IconCameraOutline16,
  IconCloseOutline16,
  IconFileOutline16,
  IconImageOutline16,
  IconSendOutline16,
  IconStopFill16,
} from '../base/icons.js'
import { useSettings } from '../../services/settings.js'
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
import { useOptionPanel } from '../base/OptionPanel.js'
import optionStyles from '../base/OptionPanel.module.css'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
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
import { ComposerToolbar } from './ComposerToolbar.js'

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
  const importingHistory = useChatStore((state) => state.importingHistory)
  const isMobile = useIsMobile()
  const custom = useProviders((state) => state.selection.providerId !== 'deepseek')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const textareaWrapperRef = useRef<HTMLDivElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)
  /** 附件面板展开状态：点 + 展开拍照/相册/文件，选完或点外部收起 */
  const attachmentPanel = useOptionPanel(t('attachPanelLabel'), {
    side: 'top',
    kind: 'actions',
    align: 'end',
  })
  const attachOpen = attachmentPanel.open

  // 输入框高度变化时平滑展开/收起（镜像层测量高度，外层过渡）
  useLayoutEffect(() => {
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
  const hasDraft = Boolean(text.trim() || attachments.length)
  const send = () => {
    if (
      streaming ||
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
    if (isMobile) {
      textareaRef.current?.blur()
    } else {
      textareaRef.current?.focus()
    }
  }

  const voiceControl = (
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
  return (
    <div data-testid="chat-composer" className={styles.wrapper}>
      <ComposerToolbar
        editorRef={textareaRef}
        sessionId={sessionId}
        draftImage={attachments.some((item) => item.isImage)}
        disabled={importingHistory}
        modelLocked={streaming || voice.status !== 'idle'}
      />
      <div className={styles.surface}>
        <DraftAttachments items={attachments} onRetry={retryFile} onRemove={removeFile} />
        <div
          className={styles.inputRow}
          data-testid="composer-input-row"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              textareaRef.current?.focus({ preventScroll: true })
            }
          }}
        >
          <IconButton
            size="xl"
            className={styles.attachTrigger}
            tone="primary"
            icon={attachOpen ? <IconCloseOutline16 /> : <IconAddOutline16 />}
            tooltip={attachOpen ? t('close') : t('attachPanelLabel')}
            buttonRef={attachmentPanel.anchorRef}
            {...attachmentPanel.trigger}
            disabled={importingHistory}
          />
          <div ref={textareaWrapperRef} className={styles.textareaWrapper}>
            <textarea
              ref={textareaRef}
              className={clsx(styles.textarea, recording && isMobile && styles.textareaHidden)}
              placeholder={t('composerMessage')}
              rows={1}
              enterKeyHint="send"
              // 移动端不自动聚焦，避免一打开就弹出键盘
              autoFocus={!isMobile}
              disabled={importingHistory}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onMouseDown={(event) => {
                // 首次点击时手动聚焦，避免 Safari 把整个页面滚到输入框位置。
                if (
                  isMobile &&
                  event.button === 0 &&
                  document.activeElement !== event.currentTarget
                ) {
                  event.preventDefault()
                  event.currentTarget.focus({ preventScroll: true })
                }
              }}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  event.nativeEvent.keyCode !== 229
                ) {
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
              {text}
              {'\u200b'}
            </div>
          </div>

          <div className={styles.right}>
            {!isMobile && !custom && voiceControl}
            {streaming && sessionId ? (
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
            ) : isMobile && !custom && (!hasDraft || voice.status !== 'idle') ? (
              voiceControl
            ) : (
              <button
                type="button"
                className={styles.sendButton}
                aria-label={t('send')}
                disabled={!canSend}
                onClick={send}
              >
                <IconSendOutline16 />
              </button>
            )}
          </div>
        </div>
      </div>
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
      {attachmentPanel.render(
        <>
          <button
            type="button"
            className={optionStyles.option}
            data-panel-item=""
            onClick={() => {
              attachmentPanel.close(true)
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
            className={optionStyles.option}
            data-panel-item=""
            onClick={() => {
              attachmentPanel.close(true)
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
            className={optionStyles.option}
            data-panel-item=""
            onClick={() => {
              attachmentPanel.close(true)
              if (ensureApiKey()) {
                fileInputRef.current?.click()
              }
            }}
          >
            <IconFileOutline16 />
            <span>{t('attachFiles')}</span>
          </button>
        </>
      )}
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
