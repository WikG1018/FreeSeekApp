import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { logEvent } from '../../services/diagnostics/log.js'
import { Button } from '../base/Button.js'
import { closeTopModal, Modal } from '../base/Modal.js'
import styles from './WebcamDialog.module.css'

const stopTracks = (stream: MediaStream) => stream.getTracks().forEach((track) => track.stop())

export const WebcamDialog = ({
  onClose,
  onGallery,
  onPhoto,
}: {
  onClose: () => void
  onGallery: () => void
  onPhoto: (photo: File) => void
}) => {
  const t = useTranslate()
  const video = useRef<HTMLVideoElement>(null)
  const request = useRef<AbortController>()
  const activeStream = useRef<MediaStream>()
  const tookPhoto = useRef(false)
  const [ready, setReady] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState<TranslationKey>()

  const finish = useCallback(() => {
    request.current?.abort()
    if (activeStream.current) {
      stopTracks(activeStream.current)
      activeStream.current = undefined
    }
    if (video.current) {
      video.current.srcObject = null
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    request.current = controller
    const fail = (key: TranslationKey) => {
      setError(key)
      setReady(false)
      logEvent('upload', 'picker.camera.failed', { localKey: key }, 'warn')
    }
    void (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        fail('attachWebCameraUnavailable')
        return
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        })
        if (controller.signal.aborted || !video.current) {
          stopTracks(stream)
          return
        }
        activeStream.current = stream
        const preview = video.current
        preview.srcObject = stream
        stream.getVideoTracks().forEach((track) =>
          track.addEventListener(
            'ended',
            () => {
              if (!controller.signal.aborted) {
                fail('attachWebCameraUnavailable')
              }
            },
            { once: true }
          )
        )
        await preview.play()
        if (!controller.signal.aborted) {
          setReady(true)
        }
      } catch (reason) {
        if (!controller.signal.aborted) {
          fail(
            reason instanceof DOMException && reason.name === 'NotAllowedError'
              ? 'attachWebCameraPermission'
              : 'attachWebCameraUnavailable'
          )
          finish()
        }
      }
    })()
    return finish
  }, [finish])

  const capture = () => {
    const preview = video.current
    const signal = request.current?.signal
    if (!preview || !ready || capturing || !preview.videoWidth || !preview.videoHeight) {
      return
    }
    setCapturing(true)
    const fail = () => {
      setCapturing(false)
      logEvent('upload', 'picker.camera.failed', { localKey: 'attachCameraFailed' }, 'warn')
      setError('attachCameraFailed')
    }
    try {
      const scale = Math.min(1, 1920 / Math.max(preview.videoWidth, preview.videoHeight))
      const frame = document.createElement('canvas')
      frame.width = Math.round(preview.videoWidth * scale)
      frame.height = Math.round(preview.videoHeight * scale)
      const context = frame.getContext('2d')
      if (!context) {
        fail()
        return
      }
      context.drawImage(preview, 0, 0, frame.width, frame.height)
      frame.toBlob(
        (blob) => {
          if (signal?.aborted) {
            return
          }
          if (!blob) {
            fail()
            return
          }
          tookPhoto.current = true
          closeTopModal()
          onPhoto(new File([blob], `照片-${Date.now()}.jpg`, { type: 'image/jpeg' }))
        },
        'image/jpeg',
        0.92
      )
    } catch {
      fail()
    }
  }

  return (
    <Modal
      centered
      title={t('attachCamera')}
      onDismissStart={() => {
        finish()
        if (!error && !tookPhoto.current) {
          logEvent('upload', 'picker.camera.cancelled')
        }
      }}
      onClose={onClose}
      footer={
        <>
          <Button variant="outlined" onClick={closeTopModal}>
            {t('cancel')}
          </Button>
          {error ? (
            <Button
              onClick={() => {
                onGallery()
                closeTopModal()
              }}
            >
              {t('attachGallery')}
            </Button>
          ) : (
            <Button disabled={!ready || capturing} onClick={capture}>
              {t('attachTakePhoto')}
            </Button>
          )}
        </>
      }
    >
      <div className={styles.preview} data-ready={ready && !error}>
        <video ref={video} muted playsInline aria-label={t('attachWebCameraPreview')} />
        {error ? (
          <p role="alert">{t(error)}</p>
        ) : ready ? null : (
          <p role="status">{t('attachWebCameraStarting')}</p>
        )}
      </div>
    </Modal>
  )
}
