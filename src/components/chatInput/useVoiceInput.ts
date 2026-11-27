import { useCallback, useEffect, useRef, useState } from 'react'
import type { TranslationMessage } from '../../i18n/index.js'
import { transcribe } from '../../services/api/speech.js'
import { ApiError } from '../../services/api/client.js'
import { classifyApiError } from '../../services/api/errors.js'
import { ensureMicPermission, isNativeApp } from '../../services/speech/micPermission.js'
import { startRecording, type Recording } from '../../services/speech/recorder.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import { useSettings } from '../../services/settings.js'
import { diagnosticError, logEvent } from '../../services/diagnostics/log.js'

export type VoiceInputStatus = 'idle' | 'starting' | 'recording' | 'transcribing' | 'failed'

const secure = typeof window === 'undefined' || window.isSecureContext

const describeTranscriptionError = (error: unknown): TranslationMessage => {
  if (error instanceof ApiError && error.localMessage?.key === 'voiceInputInvalidResponse') {
    return error.localMessage
  }
  switch (classifyApiError(error)) {
    case 'unauthorized':
      return { key: 'apiKeyInvalidRetry' }
    case 'insufficientBalance':
      return { key: 'insufficientBalance' }
    case 'rateLimited':
      return { key: 'rateLimited' }
    case 'network':
      return { key: 'ttsNetworkFailed' }
    case 'serverBusy':
      return { key: 'ttsServiceBusy' }
    default:
      return { key: 'voiceInputFailed' }
  }
}

/** Keep a failed recording only in this composer, so retrying never requires a second recording. */
export const useVoiceInput = (owner: string | null, onText: (text: string) => void) => {
  const [status, setStatus] = useState<VoiceInputStatus>('idle')
  const phase = useRef<VoiceInputStatus>('idle')
  const [error, setError] = useState<TranslationMessage | null>(null)
  const [permissionBlocked, setPermissionBlocked] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [limitReached, setLimitReached] = useState(false)
  const recording = useRef<Recording | null>(null)
  const audio = useRef<Blob | null>(null)
  const capture = useRef<AbortController | null>(null)
  const request = useRef<AbortController | null>(null)
  const onTextRef = useRef(onText)
  const currentOwner = useRef(owner)
  onTextRef.current = onText
  currentOwner.current = owner

  const change = useCallback((next: VoiceInputStatus) => {
    phase.current = next
    setStatus(next)
  }, [])

  const release = useCallback(() => {
    capture.current?.abort()
    request.current?.abort()
    recording.current?.cancel()
    capture.current = request.current = recording.current = audio.current = null
  }, [])

  const cancel = useCallback(() => {
    if (phase.current !== 'idle') {
      logEvent('speech', 'input.cancelled', { phase: phase.current })
    }
    release()
    setError(null)
    setLimitReached(false)
    change('idle')
  }, [release, change])

  const submit = async () => {
    const recorded = audio.current
    if (!recorded || request.current) {
      return
    }
    const key = useSettings.getState().apiKey?.trim()
    if (!key) {
      setError({ key: 'voiceInputConnectionRequired' })
      change('failed')
      return
    }
    const controller = new AbortController()
    request.current = controller
    setError(null)
    change('transcribing')
    logEvent('speech', 'transcription.started', { bytes: recorded.size, mimeType: recorded.type })
    try {
      const transcript = (await transcribe(key, recorded, controller.signal)).trim()
      if (
        request.current !== controller ||
        controller.signal.aborted ||
        currentOwner.current !== owner
      ) {
        return
      }
      audio.current = null
      change('idle')
      logEvent('speech', 'transcription.completed', { empty: !transcript })
      if (transcript) {
        onTextRef.current(transcript)
        logEvent('speech', 'transcription.inserted-in-composer', { sessionId: owner ?? undefined })
      } else {
        setError({ key: 'voiceInputEmpty' })
      }
    } catch (failure) {
      if (request.current !== controller || controller.signal.aborted) {
        return
      }
      logEvent('speech', 'transcription.failed', diagnosticError(failure), 'error')
      setError(describeTranscriptionError(failure))
      change('failed')
    } finally {
      if (request.current === controller) {
        request.current = null
      }
    }
  }

  const finish = async (interrupted = false) => {
    const active = recording.current
    if (!active) {
      return
    }
    const operation = capture.current
    recording.current = null
    change('transcribing')
    try {
      const captured = await active.stop()
      if (capture.current !== operation || currentOwner.current !== owner) {
        return
      }
      capture.current = null
      if (!captured) {
        logEvent('speech', 'recording.empty', {}, 'warn')
        setError({ key: interrupted ? 'voiceInputDisconnected' : 'voiceInputNoAudio' })
        change('idle')
        return
      }
      audio.current = captured
      logEvent('speech', 'recording.completed', { bytes: captured.size, interrupted })
      if (interrupted) {
        setError({ key: 'voiceInputDisconnected' })
        change('failed')
      } else {
        await submit()
      }
    } catch (failure) {
      if (capture.current !== operation) {
        return
      }
      capture.current = null
      setError({ key: 'voiceInputNoAudio' })
      change('idle')
      logEvent('speech', 'recording.stop-failed', diagnosticError(failure), 'error')
    }
  }

  const pauseTranscription = useCallback(() => {
    if (audio.current) {
      request.current?.abort()
      request.current = null
      setError(null)
      change('failed')
    } else {
      cancel()
    }
  }, [cancel, change])

  const toggle = async () => {
    switch (phase.current) {
      case 'recording':
        return finish()
      case 'starting':
        return cancel()
      case 'transcribing':
        return pauseTranscription()
      case 'failed':
        return submit()
    }
    if (!secure) {
      return
    }
    stopReadAloud()
    setError(null)
    setPermissionBlocked(false)
    setLimitReached(false)
    change('starting')
    const controller = new AbortController()
    capture.current = controller
    try {
      const active = await startRecording({
        authorize: ensureMicPermission,
        signal: controller.signal,
        onLimit: () => {
          setLimitReached(true)
          void finish()
        },
        onInterrupted: () => void finish(true),
      })
      if (capture.current !== controller || currentOwner.current !== owner) {
        active.cancel()
        return
      }
      recording.current = active
      setSeconds(0)
      change('recording')
      logEvent('speech', 'recording.started')
    } catch (failure) {
      if (capture.current !== controller) {
        return
      }
      capture.current = null
      change('idle')
      if (failure instanceof DOMException && failure.name === 'AbortError') {
        return
      }
      logEvent('speech', 'recording.failed', diagnosticError(failure), 'error')
      const name = failure instanceof DOMException ? failure.name : ''
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        if (isNativeApp()) {
          setPermissionBlocked(true)
        } else {
          setError({ key: 'voiceInputBrowserPermission' })
        }
      } else {
        setError({ key: name === 'NotFoundError' ? 'voiceInputNoDevice' : 'voiceInputUnavailable' })
      }
    }
  }

  useEffect(() => {
    if (status !== 'recording') {
      return
    }
    const startedAt = performance.now()
    const timer = setInterval(
      () => setSeconds(Math.floor((performance.now() - startedAt) / 1000)),
      250
    )
    return () => clearInterval(timer)
  }, [status])

  useEffect(() => {
    setError(null)
    setPermissionBlocked(false)
    setLimitReached(false)
    change('idle')
    return release
  }, [owner, release, change])

  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState !== 'hidden') {
        return
      }
      if (phase.current === 'transcribing') {
        pauseTranscription()
      }
      if (phase.current === 'recording' || phase.current === 'starting') {
        cancel()
      }
    }
    document.addEventListener('visibilitychange', onHidden)
    return () => document.removeEventListener('visibilitychange', onHidden)
  }, [cancel, pauseTranscription])

  const getAnalyser = useCallback(() => recording.current?.analyser ?? null, [])

  return {
    status,
    active: status !== 'idle' && status !== 'failed',
    seconds,
    limitReached,
    error,
    getAnalyser,
    toggle,
    cancel,
    available: secure,
    permissionBlocked,
    dismissPermission: () => setPermissionBlocked(false),
  }
}
