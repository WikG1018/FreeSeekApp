import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import {
  isApiFailure,
  login,
  logout,
  refreshMe,
  register,
  setAccountMode,
  setServerUrl,
  useAccount,
} from '../../services/account.js'
import { showToast } from '../base/toastState.js'
import { BalanceBlock } from './AccountPanels.js'
import styles from './Account.module.css'

type Tab = 'login' | 'register'

/** 登录 / 注册表单：服务地址 + 用户名 + 密码 */
const AuthForm = () => {
  const t = useTranslate()
  const serverUrl = useAccount((state) => state.serverUrl)
  const busy = useAccount((state) => state.busy)
  const [tab, setTab] = useState<Tab>('login')
  const [url, setUrl] = useState(serverUrl)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => setUrl(serverUrl), [serverUrl])

  const submit = async () => {
    setError(null)
    if (!/^https?:\/\/.+/.test(url.trim())) {
      setError(t('accountNeedServer'))
      return
    }
    setServerUrl(url.trim())
    try {
      if (tab === 'login') {
        await login(username.trim(), password)
      } else {
        await register(username.trim(), password)
      }
    } catch (cause) {
      if (!isApiFailure(cause)) {
        setError(t('accountNetworkError'))
        return
      }
      if (cause.code === 'invalid_credentials') {
        setError(t('accountInvalidCredentials'))
      } else if (cause.code === 'username_taken') {
        setError(t('accountUsernameTaken'))
      } else if (cause.code === 'rate_limited') {
        setError(t('rateLimited'))
      } else {
        setError(cause.message || t('accountNetworkError'))
      }
    }
  }

  return (
    <>
      <div className={styles.tabs}>
        <button
          type="button"
          className={clsx(styles.tab, tab === 'login' && styles.tabActive)}
          onClick={() => setTab('login')}
        >
          {t('accountLogin')}
        </button>
        <button
          type="button"
          className={clsx(styles.tab, tab === 'register' && styles.tabActive)}
          onClick={() => setTab('register')}
        >
          {t('accountRegister')}
        </button>
      </div>
      <label className={styles.field}>
        <span>{t('accountServerUrl')}</span>
        <input
          value={url}
          placeholder="https://api.example.com"
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>
      <label className={styles.field}>
        <span>{t('accountUsername')}</span>
        <input
          value={username}
          autoComplete="username"
          spellCheck={false}
          onChange={(event) => setUsername(event.target.value)}
        />
      </label>
      <label className={styles.field}>
        <span>{t('accountPassword')}</span>
        <input
          type="password"
          value={password}
          autoComplete={tab === 'login' ? 'current-password' : 'new-password'}
          onChange={(event) => setPassword(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !busy) {
              void submit()
            }
          }}
        />
      </label>
      {error ? <div className={styles.error}>{error}</div> : null}
      <button
        type="button"
        className={styles.submit}
        disabled={busy || !username.trim() || !password}
        onClick={() => void submit()}
      >
        {busy ? t('accountBusy') : tab === 'login' ? t('accountLogin') : t('accountRegister')}
      </button>
      <div className={styles.hint}>{t('accountAuthHint')}</div>
    </>
  )
}

/** 账号页：使用方式切换 + 登录 / 余额 / 账单 */
export const AccountPanels = () => {
  const t = useTranslate()
  const mode = useAccount((state) => state.mode)
  const token = useAccount((state) => state.token)
  const user = useAccount((state) => state.user)
  const loggedIn = !!token

  useEffect(() => {
    if (loggedIn) {
      void refreshMe().catch(() => {})
    }
  }, [loggedIn])

  return (
    <>
      <div className={styles.modeRow}>
        <button
          type="button"
          className={clsx(styles.modeCard, mode === 'account' && styles.modeActive)}
          onClick={() => {
            if (!loggedIn) {
              showToast({ key: 'accountLoginRequired' })
              return
            }
            setAccountMode('account')
          }}
        >
          <span className={styles.modeTitle}>{t('accountModeAccount')}</span>
          <span className={styles.modeHint}>{t('accountModeAccountHint')}</span>
        </button>
        <button
          type="button"
          className={clsx(styles.modeCard, mode === 'key' && styles.modeActive)}
          onClick={() => setAccountMode('key')}
        >
          <span className={styles.modeTitle}>{t('accountModeKey')}</span>
          <span className={styles.modeHint}>{t('accountModeKeyHint')}</span>
        </button>
      </div>

      {loggedIn ? (
        <>
          <div className={styles.signedIn}>
            <span className={styles.signedUser}>{user?.username}</span>
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => void refreshMe().catch(() => {})}
            >
              {t('accountRefresh')}
            </button>
            <button type="button" className={styles.dangerLink} onClick={() => void logout()}>
              {t('accountLogout')}
            </button>
          </div>
          <BalanceBlock />
        </>
      ) : (
        <AuthForm />
      )}
    </>
  )
}
