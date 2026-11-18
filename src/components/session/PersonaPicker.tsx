import { useTranslate } from '../../i18n/index.js'
import { setDefaultPersona, usePersonas } from '../../services/personas.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'

export const PersonaPicker = () => {
  const t = useTranslate()
  const personas = usePersonas((state) => state.personas)
  const id = usePersonas((state) => state.defaultId)
  return (
    <Select
      pill
      prefix={t('personaRowLabel')}
      ariaLabel={t('personaPickerTitle')}
      value={id}
      placeholder={t('personaDefaultName')}
      options={personas.map((p) => ({
        value: p.id,
        label: p.name,
        detail: p.prompt ? p.prompt.slice(0, 80) : t('personaDefaultHint'),
      }))}
      onChange={(value) => {
        try {
          setDefaultPersona(value)
        } catch {
          showToast({ key: 'personaSaveFailed', type: 'error' })
        }
      }}
      footer={{ label: t('personaManage'), onSelect: () => openSettings('personas') }}
    />
  )
}
