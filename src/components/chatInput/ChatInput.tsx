import clsx from 'clsx'
import { Capacitor } from '@capacitor/core'
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react'
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
import { isWindowsDesktop } from '../../services/api/windowsTransport.js'
import { WorkspacePicker } from '../session/WorkspacePicker.js'
import { ToolApproval } from './ToolApproval.js'
import { useIsMobile } from '../../app/viewport.js'
import { sendMessage, stopReply, useChatStore } from '../../services/chat/store.js'
import { getVisibleMessages } from '../../services/chat/branches.js'
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
import { ensureApiKey, openSettings } from '../settings/settingsDialogState.js'
import { DragMask, useFileDrop } from './DragMask.js'
import { showToast } from '../base/toastState.js'
import { ACCEPT, useUploads } from '../../services/attachments.js'
import { DraftAttachments } from './DraftAttachments.js'
import { useVoiceInput } from './useVoiceInput.js'
import { VoiceButton } from './VoiceButton.js'
import { Spectrum } from './Spectrum.js'
import { useTranslate } from '../../i18n/index.js'
import { AgentProgressButton } from '../messages/AssistantTask.js'
import styles from './ChatInput.module.css'
import { useProviders } from '../../services/providers.js'
import { logEvent } from '../../services/diagnostics/log.js'
import { isAndroidCamera, takeAndroidPhoto } from '../../services/photoCapture.js'
import { ComposerToolbar } from './ComposerToolbar.js'
import { WebcamDialog } from './WebcamDialog.js'
import { useChatMode, useSessionAgent } from '../session/SessionAssistant.js'
import { useAssistantLibrary } from '../../services/assistants/library.js'
import { isPlanWaitingForUser } from '../../services/tasks/runState.js'
import assistantStyles from '../settings/AssistantSettings.module.css'

/** 输入框：自适应高度的文本框 + 文件 + 深度思考与智能搜索开关 + 语音输入 + 发送 / 停止 */
export const ChatInput = memo(function ChatInput({
  sessionId,
  editorRef,
}: {
  sessionId: string | null
  editorRef?: RefObject<HTMLTextAreaElement>
}) {
  // 切换目标时释放录音、转写和 DOM 状态；文字与附件由草稿服务保留。
  return (
    <Input
      key={sessionId === null ? 'new' : `session:${sessionId}`}
      sessionId={sessionId}
      editorRef={editorRef}
    />
  )
})

const AgentProgressDock = ({
  sessionId,
  editorRef,
  streaming,
  busy,
}: {
  sessionId: string
  editorRef: RefObject<HTMLTextAreaElement>
  streaming: boolean
  busy: boolean
}) => {
  const reply = useChatStore((state) => {
    const session = state.sessionCache[sessionId]
    const tail = session && getVisibleMessages(session).at(-1)
    return tail?.role === 'assistant' && tail.stopReason !== 'refusal' && tail.task
      ? tail
      : undefined
  })
  return reply?.task && !isWindowsDesktop() ? (
    <div className={styles.progressRow}>
      <AgentProgressButton
        key={reply.id}
        sessionId={sessionId}
        replyId={reply.id}
        task={reply.task}
        message={reply}
        current
        busy={busy}
        streaming={streaming}
        editorRef={editorRef}
      />
    </div>
  ) : null
}

const Input = ({
  sessionId,
  editorRef,
}: {
  sessionId: string | null
  editorRef?: RefObject<HTMLTextAreaElement>
}) => {
  const t = useTranslate()
  const draft = useDrafts((state) => state.drafts.get(sessionId) ?? EMPTY_DRAFT)
  const { text, attachments } = draft
  const setText = (value: string) => setDraftText(sessionId, value)
  const agent = useSessionAgent(sessionId)
  const mode = useChatMode(sessionId)
  const planStatus = useChatStore((state) => {
    const session = sessionId !== null ? state.sessionCache[sessionId] : undefined
    const tail = session?.mode === 'agent' ? getVisibleMessages(session).at(-1) : undefined
    const run = tail?.role === 'assistant' ? tail.task?.run : undefined
    return !isWindowsDesktop() && isPlanWaitingForUser(run) ? run.status : undefined
  })
  const askMode = useSettings((state) => state.askChatMode)
  const deferUpload = Boolean(
    agent || mode === 'agent' || (sessionId === null && mode === null && askMode)
  )
  const selectedAgent = useChatStore((state) =>
    sessionId === null ? state.draftAgent : state.sessionCache[sessionId]?.agent
  )
  const selection = useProviders((state) => agent?.model ?? state.selection)
  const route = deferUpload ? { selection, deferUpload } : undefined
  const invalidAgent = !isWindowsDesktop() && Boolean(selectedAgent && !agent)
  const assistantReady = useAssistantLibrary((state) => state.ready)
  const attachmentToolOff = useSettings((state) => mode === 'agent' && !state.agentTools.attachment)
  const filesDisabled = agent?.attachments === false || invalidAgent || attachmentToolOff
  const draftReady = useUploads((state) => prepareDraftMessage(draft, state.tasks, route) !== null)
  const streaming = useChatStore(
    (state) => sessionId !== null && Object.hasOwn(state.streaming, sessionId)
  )
  const importingHistory = useChatStore((state) => state.importingHistory)
  const isMobile = useIsMobile()
  const enterSends = useSettings((state) => state.composerEnter) === 'send'
  const custom = selection.providerId !== 'deepseek'
  const hasVoiceKey = useSettings((state) => Boolean(state.apiKey?.trim()))
  const fileInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const cameraBusy = useRef(false)
  const [webcamOpen, setWebcamOpen] = useState(false)
  const localEditorRef = useRef<HTMLTextAreaElement>(null)
  const textareaRef = editorRef ?? localEditorRef
  const composing = useRef(false)
  const keepLineBreak = useRef(false)
  const textareaWrapperRef = useRef<HTMLDivElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)
  /** 附件面板展开状态：点 + 展开拍照/相册/文件，选完或点外部收起 */
  const attachmentPanel = useOptionPanel(t('attachPanelLabel'), {
    side: 'top',
    kind: 'actions',
    align: 'end',
    editorRef: textareaRef,
    disabled: importingHistory || filesDisabled,
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
    if (
      files.length === 0 ||
      filesDisabled ||
      useChatStore.getState().importingHistory ||
      (!agent?.model && !ensureApiKey())
    ) {
      return
    }
    const error = addDraftFiles(sessionId, files, useSettings.getState().apiKey ?? '', route)
    if (error) {
      showToast(error)
    }
  }
  const acceptSelection = (source: 'camera' | 'gallery' | 'files', input: HTMLInputElement) => {
    const files = Array.from(input.files ?? [])
    input.value = ''
    if (files.length) {
      logEvent('upload', 'picker.' + source + '.completed', { count: files.length })
      acceptFiles(files)
    }
  }
  const capture = async () => {
    if (!Capacitor.isNativePlatform()) {
      logEvent('upload', 'picker.camera.started')
      setWebcamOpen(true)
      return
    }
    if (!isAndroidCamera()) {
      logEvent('upload', 'picker.camera.started')
      cameraInputRef.current?.click()
      return
    }
    if (cameraBusy.current) {
      return
    }
    cameraBusy.current = true
    logEvent('upload', 'picker.camera.started')
    try {
      const photo = await takeAndroidPhoto()
      logEvent('upload', photo ? 'picker.camera.completed' : 'picker.camera.cancelled')
      if (photo && textareaRef.current) {
        acceptFiles([photo])
      }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      const key =
        code === 'camera-unavailable'
          ? 'attachCameraUnavailable'
          : code === 'camera-too-large'
            ? 'uploadTooLarge'
            : 'attachCameraFailed'
      logEvent('upload', 'picker.camera.failed', { localKey: key }, 'warn')
      showToast({ key, type: 'error' })
    } finally {
      cameraBusy.current = false
    }
  }
  const retryFile = useCallback(
    (id: string) => {
      if (
        !filesDisabled &&
        !useChatStore.getState().importingHistory &&
        (agent?.model || ensureApiKey())
      ) {
        retryDraftAttachment(sessionId, id, useSettings.getState().apiKey ?? '', deferUpload)
      }
    },
    [agent, deferUpload, filesDisabled, sessionId]
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
  const voice = useVoiceInput(sessionId, (transcript) => {
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
  useEffect(
    () =>
      useChatStore.subscribe((state, previous) => {
        if (state.importingHistory && !previous.importingHistory) {
          cancelVoice()
          setWebcamOpen(false)
        }
      }),
    [cancelVoice]
  )

  const recording = voice.status === 'recording'
  const voiceAvailable = (voice.active || !custom || hasVoiceKey) && voice.status !== 'failed'
  const voiceTime = `${Math.floor(voice.seconds / 60)}:${String(voice.seconds % 60).padStart(2, '0')}`

  // 排队、上传中或上传失败的附件都留在输入框，全部上传成功后才能发送
  const canSend =
    !importingHistory &&
    !streaming &&
    !voice.active &&
    draftReady &&
    !invalidAgent &&
    !(filesDisabled && attachments.length)
  const hasDraft = Boolean(text.trim() || attachments.length)
  const send = () => {
    if (
      streaming ||
      useChatStore.getState().importingHistory ||
      voice.active ||
      !prepareDraftMessage(getDraft(sessionId), useUploads.getState().tasks, route)
    ) {
      return
    }
    // 文本与上传完成态由提交动作读取最新快照，不使用上一次渲染的草稿。
    if (invalidAgent || (!agent?.model && !ensureApiKey()) || !sendMessage(sessionId)) {
      return
    }
    cancelVoice()
    stopReadAloud()
    if (isMobile) {
      textareaRef.current?.blur()
    } else {
      textareaRef.current?.focus()
    }
  }

  const latestSend = useRef(send)
  latestSend.current = send
  useEffect(() => {
    const input = textareaRef.current
    if (!enterSends || !input) {
      return
    }
    // Some software keyboards commit a line break directly, without an Enter keydown.
    const submitLineBreak = (event: InputEvent) => {
      const isLineBreak =
        event.inputType === 'insertLineBreak' ||
        event.inputType === 'insertParagraph' ||
        (event.inputType === 'insertText' && event.data === '\n')
      if (!isLineBreak || event.defaultPrevented || !event.cancelable) {
        return
      }
      if (!composing.current && !event.isComposing && !keepLineBreak.current) {
        event.preventDefault()
        latestSend.current()
      }
      keepLineBreak.current = false
    }
    input.addEventListener('beforeinput', submitLineBreak)
    return () => input.removeEventListener('beforeinput', submitLineBreak)
  }, [enterSends, textareaRef])

  const voiceControl = (
    <VoiceButton
      status={voice.status}
      disabled={!voice.available}
      onClick={() => {
        if (!voice.active) {
          if (useChatStore.getState().importingHistory) {return}
          if (!hasVoiceKey) {
            showToast({ key: 'voiceInputConnectionRequired' })
            openSettings('account')
            return
          }
          textareaRef.current?.blur()
        }
        void voice.toggle()
      }}
    />
  )
  return (
    <div data-testid="chat-composer" className={styles.wrapper}>
      {mode === 'agent' && sessionId !== null && <ToolApproval sessionId={sessionId} />}
      {mode === 'agent' && (
        <div className={styles.agentDockRow}>
          <WorkspacePicker
            sessionId={sessionId}
            busy={importingHistory || streaming}
            editorRef={textareaRef}
          />
          {sessionId !== null && (
            <AgentProgressDock
              sessionId={sessionId}
              busy={importingHistory || streaming}
              streaming={streaming}
              editorRef={textareaRef}
            />
          )}
        </div>
      )}
      <ComposerToolbar
        editorRef={textareaRef}
        sessionId={sessionId}
        draftImage={attachments.some((item) => item.isImage)}
        disabled={importingHistory}
        modelLocked={streaming || voice.active}
        planLocked={!!planStatus}
      />
      <div className={styles.surface} data-testid="composer-input-surface">
        <DraftAttachments items={attachments} onRetry={retryFile} onRemove={removeFile} />
        {(voice.error || voice.status === 'failed') && (
          <div className={styles.voiceFeedback}>
            {voice.error && <p role="alert">{t(voice.error.key, voice.error.params)}</p>}
            {voice.status === 'failed' && (
              <div className={styles.voiceRecovery}>
                <Button size="s" onClick={() => void voice.toggle()}>
                  {t('voiceInputRetry')}
                </Button>
                <Button size="s" variant="outlined" onClick={cancelVoice}>{t('voiceInputDiscard')}</Button>
              </div>
            )}
          </div>
        )}
        {(invalidAgent || (filesDisabled && attachments.length > 0)) && (
          <p className={assistantStyles.hint + ' ' + assistantStyles.toolbarNote} role="status">
            {t(
              invalidAgent
                ? assistantReady
                  ? 'assistantAgentMissing'
                  : 'assistantLibraryLoading'
                : attachmentToolOff
                  ? 'agentAttachmentToolDisabled'
                  : 'assistantAttachmentsDisabled'
            )}
          </p>
        )}
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
            tooltip={
              filesDisabled
                ? t('assistantAttachmentsDisabled')
                : attachOpen
                  ? t('close')
                  : t('attachPanelLabel')
            }
            buttonRef={attachmentPanel.anchorRef}
            {...attachmentPanel.trigger}
            disabled={importingHistory || filesDisabled}
          />
          <div ref={textareaWrapperRef} className={styles.textareaWrapper} data-voice-active={voice.active || undefined}>
            <textarea
              ref={textareaRef}
              className={clsx(styles.textarea, voice.active && styles.textareaHidden)}
              placeholder={t(
                planStatus === 'awaiting-review'
                  ? 'agentPlanFeedbackPlaceholder'
                  : planStatus === 'awaiting-input'
                    ? 'agentPlanQuestionPlaceholder'
                    : 'composerMessage'
              )}
              rows={1}
              enterKeyHint={enterSends ? 'send' : 'enter'}
              // 移动端不自动聚焦，避免一打开就弹出键盘
              autoFocus={!isMobile}
              disabled={importingHistory || voice.active}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onCompositionStart={() => (composing.current = true)}
              onCompositionEnd={() => (composing.current = false)}
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
                keepLineBreak.current =
                  event.key === 'Enter' &&
                  (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey)
                if (
                  enterSends &&
                  event.key === 'Enter' &&
                  !keepLineBreak.current &&
                  !composing.current &&
                  !event.nativeEvent.isComposing &&
                  event.nativeEvent.keyCode !== 229
                ) {
                  event.preventDefault()
                  send()
                }
              }}
              onKeyUp={() => (keepLineBreak.current = false)}
              onBlur={() => (keepLineBreak.current = false)}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.files)
                if (files.length > 0) {
                  event.preventDefault()
                  acceptFiles(files)
                }
              }}
            />
            {voice.active && (
              <div className={styles.voiceInline}>
                <span className={styles.voiceState} role="status">
                  {recording ? t('voiceInputRecording') : t(voice.status === 'starting'
                    ? 'voiceInputStarting'
                    : voice.limitReached ? 'voiceInputLimitTranscribing' : 'voiceInputTranscribing')}
                </span>
                {recording && (
                  <>
                    <span className={styles.voiceClock} aria-hidden>{voiceTime}</span>
                    <div className={styles.voiceWave}><Spectrum getAnalyser={voice.getAnalyser} /></div>
                    <button type="button" className={styles.voiceDiscard} aria-label={t('voiceInputDiscard')} onClick={cancelVoice}>
                      <IconCloseOutline16 />
                    </button>
                  </>
                )}
              </div>
            )}
            <div ref={mirrorRef} className={styles.mirror} aria-hidden>
              {!voice.active && text}
              {'\u200b'}
            </div>
          </div>

          <div className={styles.right}>
            {voiceAvailable && !streaming && voiceControl}
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
            ) : !voice.active && (!isMobile || hasDraft || !voiceAvailable) ? (
              <button
                type="button"
                className={styles.sendButton}
                aria-label={t('send')}
                data-chat-mode-send
                disabled={!canSend}
                onClick={send}
              >
                <IconSendOutline16 />
              </button>
            ) : null}
          </div>
        </div>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        accept={ACCEPT}
        onChange={(event) => acceptSelection('files', event.currentTarget)}
      />
      <input
        ref={imageInputRef}
        type="file"
        multiple
        hidden
        accept="image/*"
        onChange={(event) => acceptSelection('gallery', event.currentTarget)}
      />
      {/* 只有未实现相机插件的原生端才使用系统文件控件。 */}
      <input
        ref={cameraInputRef}
        type="file"
        hidden
        accept="image/*"
        capture="environment"
        onChange={(event) => acceptSelection('camera', event.currentTarget)}
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
                void capture()
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
                logEvent('upload', 'picker.gallery.started')
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
                logEvent('upload', 'picker.files.started')
                fileInputRef.current?.click()
              }
            }}
          >
            <IconFileOutline16 />
            <span>{t('attachFiles')}</span>
          </button>
        </>
      )}
      {webcamOpen && !importingHistory && (
        <WebcamDialog
          onClose={() => setWebcamOpen(false)}
          onGallery={() => {
            logEvent('upload', 'picker.gallery.started')
            imageInputRef.current?.click()
          }}
          onPhoto={(photo) => {
            logEvent('upload', 'picker.camera.completed', { count: 1 })
            acceptFiles([photo])
          }}
        />
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
