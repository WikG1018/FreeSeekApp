import clsx from 'clsx'
import { useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { REPO } from '../../services/update.js'
import { copyText } from '../../utils/clipboard.js'
import { openExternal } from '../../utils/openExternal.js'
import { Row, Section } from './SettingsRows.js'
import { aboutBrandPaths } from './aboutBrandMarks.js'
import styles from './Settings.module.css'

const github = 'https://github.com/' + REPO
const xAccount = '@WikG1018'
const xiaohongshuId = '677206944'
type Platform = keyof typeof aboutBrandPaths
type Link = {
  platform: Platform
  label: string
  account: string
  clipboard: string
  url: string
}

export const AboutLinks = () => {
  const t = useTranslate()
  const [feedback, setFeedback] = useState<{
    platform: Platform
    key: TranslationKey
    error: boolean
  }>()
  const copyAndOpen = async ({ platform, clipboard, url }: Link) => {
    setFeedback(undefined)
    const [copy, open] = await Promise.allSettled([copyText(clipboard), openExternal(url)])
    const copied = copy.status === 'fulfilled' && copy.value
    const failed = open.status === 'rejected'
    setFeedback({
      platform,
      error: failed || !copied,
      key: failed
        ? copied
          ? 'aboutOpenFailedCopied'
          : 'aboutOpenFailed'
        : copied
          ? 'aboutCopied'
          : 'aboutCopyFailed',
    })
  }
  const linkRow = (link: Link) => (
    <div>
      <Row
        label={link.label}
        description={link.account}
        value={t(link.platform === 'xiaohongshu' ? 'aboutCopyAndSearch' : 'aboutCopyAndOpen')}
        icon={
          <svg
            className={link.platform === 'xiaohongshu' ? styles.redNoteMark : undefined}
            viewBox="0 0 24 24"
            fill="currentColor"
            focusable="false"
          >
            <path d={aboutBrandPaths[link.platform]} />
          </svg>
        }
        onClick={() => void copyAndOpen(link)}
        target={link.platform}
      />
      {feedback?.platform === link.platform && (
        <p
          className={clsx(
            styles.rowNote,
            styles.aboutLinkFeedback,
            feedback.error && styles.errorNote
          )}
          role={feedback.error ? 'alert' : 'status'}
        >
          {t(feedback.key)}
        </p>
      )}
    </div>
  )

  return (
    <>
      <Section title={t('aboutProjectLinks')}>
        {linkRow({
          platform: 'github',
          label: t('aboutGitHub'),
          account: REPO,
          clipboard: github,
          url: github,
        })}
      </Section>
      <Section title={t('aboutAuthor')}>
        {linkRow({
          platform: 'x',
          label: 'X',
          account: xAccount,
          clipboard: xAccount,
          url: 'https://x.com/' + xAccount.slice(1),
        })}
        {linkRow({
          platform: 'xiaohongshu',
          label: t('aboutXiaohongshu'),
          account: t('aboutXiaohongshuId', { id: xiaohongshuId }),
          clipboard: xiaohongshuId,
          url: 'https://www.xiaohongshu.com/search_result/?keyword=' + xiaohongshuId + '&type=user',
        })}
      </Section>
    </>
  )
}
