import { useEffect, useRef, useState } from 'react'
import { ApiError, verifyApiKey } from '../../services/api/client.js'
import { classifyApiError } from '../../services/api/errors.js'
import { setApiKey } from '../../services/settings.js'
import { useTranslate } from '../../i18n/index.js'

/** 输入 API Key 后先用 GET /models 校验，通过才保存 */
export const useApiKeyForm = (onSaved?: () => void) => {
  const t = useTranslate()
  const [value, updateValue] = useState('')
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  const [verifying, setVerifying] = useState(false)
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null)
  const cause = failure?.cause
  const error =
    failure === null
      ? null
      : classifyApiError(cause) === 'unauthorized'
        ? t('apiKeyInvalid')
        : classifyApiError(cause) === 'network'
          ? t('commonNetworkErrorToast')
          : t('apiKeyVerificationFailed', {
              message:
                cause instanceof ApiError && cause.localMessage
                  ? t(cause.localMessage.key, cause.localMessage.params)
                  : cause instanceof Error
                    ? cause.message
                    : String(cause),
            })

  const submit = async () => {
    const apiKey = value.trim()
    if (!apiKey || controller.current) {
      return
    }
    const active = new AbortController()
    controller.current = active
    setVerifying(true)
    setFailure(null)
    try {
      await verifyApiKey(apiKey, active.signal)
      if (active.signal.aborted) {
        return
      }
      setApiKey(apiKey)
      updateValue('')
      onSaved?.()
    } catch (e) {
      if (!active.signal.aborted) {
        setFailure({ cause: e })
      }
    } finally {
      controller.current = null
      if (!active.signal.aborted) {
        setVerifying(false)
      }
    }
  }

  const setValue = (text: string) => {
    updateValue(text)
    setFailure(null)
  }
  return { value, setValue, verifying, error, submit }
}
