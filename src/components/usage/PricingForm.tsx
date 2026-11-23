import { useState, type FormEvent, type ReactNode } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { providerModelLabel, useProviders } from '../../services/providers.js'
import {
  DEFAULT_PRICING,
  PRO_PRICING,
  modelPriceKey,
  proPriceKey,
  savePrice,
  usePricing,
  type FlashPricing,
} from '../../services/usage.js'
import { Button } from '../base/Button.js'
import { Select } from '../base/Select.js'
import styles from './PricingForm.module.css'

type PriceKey = keyof FlashPricing
type PricingModel = {
  value: string
  label: string
  model: string
  provider?: string
  defaults?: FlashPricing
}
const official: PricingModel[] = [
  { value: 'flash', label: 'DeepSeek Flash', model: 'deepseek-flash', defaults: DEFAULT_PRICING },
  { value: proPriceKey, label: 'DeepSeek V4 Pro', model: 'deepseek-v4-pro', defaults: PRO_PRICING },
]
const offPeakFields: [PriceKey, TranslationKey][] = [
  ['offPeakHit', 'usagePricingHit'],
  ['offPeakMiss', 'usagePricingMiss'],
  ['offPeakOut', 'usagePricingOut'],
]
const peakFields: [PriceKey, TranslationKey][] = [
  ['peakHit', 'usagePricingHit'],
  ['peakMiss', 'usagePricingMiss'],
  ['peakOut', 'usagePricingOut'],
]

const Group = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className={styles.group}>
    <h3 className={styles.groupTitle}>{title}</h3>
    <div className={styles.card}>{children}</div>
  </section>
)

const ModelPrices = ({ model, current }: { model: PricingModel; current?: FlashPricing }) => {
  const t = useTranslate()
  const [draft, setDraft] = useState<Partial<Record<PriceKey, string>>>({})
  const [notice, setNotice] = useState<'saved' | 'reset' | 'failed'>()
  const fields = [
    ...offPeakFields,
    ...(model.defaults ? peakFields : []),
    ...(model.value === 'flash' ? [['searchPer1k', 'usagePricingSearch'] as const] : []),
  ]
  const values = Object.fromEntries(
    fields.map(([key]) => [key, draft[key] ?? String(current?.[key] ?? '')])
  )
  const valid = fields.every(
    ([key]) =>
      values[key].trim() && Number.isFinite(Number(values[key])) && Number(values[key]) >= 0
  )
  const changed = fields.some(([key]) => values[key] !== String(current?.[key] ?? ''))
  const apply = (event: FormEvent) => {
    event.preventDefault()
    if (!valid || !changed) {
      return
    }
    const converted = Object.fromEntries(
      fields.map(([key]) => [key, Number(values[key])])
    ) as FlashPricing
    const rate = model.defaults
      ? { ...model.defaults, ...converted }
      : {
          ...converted,
          peakHit: converted.offPeakHit,
          peakMiss: converted.offPeakMiss,
          peakOut: converted.offPeakOut,
          searchPer1k: 0,
        }
    if (savePrice(model.value, rate)) {
      setDraft({})
      setNotice('saved')
    } else {
      setNotice('failed')
    }
  }
  const reset = () => {
    const value = model.value === 'flash' ? DEFAULT_PRICING : undefined
    if (savePrice(model.value, value)) {
      setDraft({})
      setNotice('reset')
    } else {
      setNotice('failed')
    }
  }
  const input = (key: PriceKey, label: TranslationKey, unit = t('usagePricingUnit')) => (
    <label className={styles.row} key={key}>
      <span className={styles.label}>{t(label)}</span>
      <span className={styles.control}>
        <input
          className={styles.input}
          type="number"
          inputMode="decimal"
          min="0"
          step="any"
          value={values[key]}
          onChange={(event) => {
            setDraft((value) => ({ ...value, [key]: event.target.value }))
            setNotice(undefined)
          }}
        />
        <span className={styles.unit}>{unit}</span>
      </span>
    </label>
  )
  return (
    <form className={styles.form} onSubmit={apply}>
      <Group title={t(model.defaults ? 'usagePricingOffPeak' : 'usageModelTokenPricing')}>
        {offPeakFields.map(([key, label]) => input(key, label))}
      </Group>
      {model.defaults && (
        <Group title={t('usagePricingPeak')}>
          {peakFields.map(([key, label]) => input(key, label))}
        </Group>
      )}
      {model.value === 'flash' && (
        <Group title={t('usagePricingSearchSection')}>
          {input('searchPer1k', 'usagePricingSearch', t('usagePricingSearchUnit'))}
          <p className={styles.policy}>{t('usagePricingSearchPolicy')}</p>
        </Group>
      )}
      <div className={styles.formActions}>
        <Button type="submit" disabled={!valid || !changed}>
          {t('usageSavePrice')}
        </Button>
        {(model.defaults || current) && (
          <Button variant="outlined" type="button" onClick={reset}>
            {t(model.defaults ? 'usagePricingReset' : 'usageClearPrice')}
          </Button>
        )}
      </div>
      {notice && (
        <p
          className={styles.notice}
          role={notice === 'failed' ? 'alert' : 'status'}
          data-error={notice === 'failed'}
        >
          {t(
            notice === 'failed'
              ? 'usagePriceSaveFailed'
              : notice === 'saved'
                ? 'usageSaved'
                : model.defaults
                  ? 'usagePricingResetDone'
                  : 'usagePriceCleared'
          )}
        </p>
      )}
      <p className={styles.hint}>
        {t(model.defaults ? 'usagePricingHint' : 'usageCustomPriceHint')}
      </p>
    </form>
  )
}

export const PricingForm = () => {
  const t = useTranslate()
  const pricing = usePricing()
  const profiles = useProviders((state) => state.profiles)
  const [selection, setSelection] = useState('flash')
  const options = [
    ...official,
    ...profiles.flatMap((profile) =>
      [...new Set([profile.model, ...profile.models])].filter(Boolean).map((model) => ({
        value: modelPriceKey(profile.id, model),
        label: providerModelLabel(model, profile),
        model,
        provider: profile.name,
      }))
    ),
  ] satisfies PricingModel[]
  const model: PricingModel = options.find(({ value }) => value === selection) ?? official[0]
  const current =
    model.value === 'flash' ? pricing.pricing : (pricing.modelPrices[model.value] ?? model.defaults)
  return (
    <>
      <div className={styles.modelRow}>
        <Select
          ariaLabel={t('usagePricingModel')}
          settingRow="value"
          value={model.value}
          options={options.map(({ value, label, provider }) => ({
            value,
            label,
            detail: provider,
          }))}
          onChange={setSelection}
        />
        <p className={styles.modelCode}>{model.model}</p>
      </div>
      <ModelPrices key={model.value} model={model} current={current} />
    </>
  )
}
