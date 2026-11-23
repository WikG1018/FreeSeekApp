import type { ProviderModelParameters } from '../services/providers.js'
import type { useTranslate } from './index.js'

export const modelInputLabel = (
  t: ReturnType<typeof useTranslate>,
  { vision, pdf }: Pick<ProviderModelParameters, 'vision' | 'pdf'>
) =>
  vision || pdf
    ? [t('providerInputText'), vision && t('providerInputImages'), pdf && 'PDF']
        .filter(Boolean)
        .join(' · ')
    : t('providerTextOnlyCapability')
