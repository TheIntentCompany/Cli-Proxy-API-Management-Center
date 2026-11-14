import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/Select';
import { useAuthStore, useLanguageStore } from '@/stores';
import {
  getLoginTransitionTimings,
  useLoginTransitionStore,
} from '@/stores/useLoginTransitionStore';
import { prefersReducedMotion } from '@/hooks/motion';
import { detectApiBaseFromLocation, normalizeApiBase } from '@/utils/connection';
import { LANGUAGE_LABEL_KEYS, LANGUAGE_ORDER } from '@/utils/constants';
import { isSupportedLanguage } from '@/utils/language';
import { IconSidebarRouting } from '@/components/ui/icons';
import type { ApiError } from '@/types';
import { LegacyBackendError } from '@/services/api/legacyBackendProbe';
import { LoginForm } from './login/LoginForm';
import { resolveLoginRedirect } from '@/router/loginRedirect';
import styles from './LoginPage.module.scss';

export type LoginPhase = 'idle' | 'connecting' | 'success' | 'exiting';

/** Product name in the top bar; the same English name in every language, matching the sidebar. */
export const LOGIN_BRAND_NAME = 'CLIProxyAPI';

/** 语言下拉层最小宽度：最长的语言名（繁體中文（台灣））单行显示 */
const LANGUAGE_DROPDOWN_MIN_WIDTH = 180;

interface LoginError {
  /** One plain sentence for the form. */
  summary: string;
  /** The status code and the backend's own words, shown behind "Details". */
  details?: string;
}

/** Turns a failed login into a plain sentence, keeping the raw response for the details block. */
function describeLoginError(error: unknown, t: (key: string) => string): LoginError {
  if (error instanceof LegacyBackendError) return { summary: t('login.error_legacy_backend') };
  const apiError = error as Partial<ApiError>;
  const status = typeof apiError.status === 'number' ? apiError.status : undefined;
  const code = typeof apiError.code === 'string' ? apiError.code : undefined;
  const message =
    error instanceof Error
      ? error.message
      : typeof apiError.message === 'string'
        ? apiError.message
        : typeof error === 'string'
          ? error
          : '';
  const detail = message.trim();
  const genericAxiosMessage = status ? `Request failed with status code ${status}` : '';
  const details =
    [status ? `HTTP ${status}` : '', detail && detail !== genericAxiosMessage ? detail : '']
      .filter(Boolean)
      .join(': ') || undefined;
  const lower = message.toLowerCase();

  if (status === 401) return { summary: t('login.error_unauthorized'), details };
  if (status === 403) return { summary: t('login.error_forbidden'), details };
  if (status === 404) return { summary: t('login.error_not_found'), details };
  if (status && status >= 500) return { summary: t('login.error_server'), details };
  if (code === 'ECONNABORTED' || lower.includes('timeout'))
    return { summary: t('login.error_timeout'), details };
  if (code === 'ERR_NETWORK' || lower.includes('network error'))
    return { summary: t('login.error_network'), details };
  if (code === 'ERR_CERT_AUTHORITY_INVALID' || lower.includes('certificate'))
    return { summary: t('login.error_ssl'), details };
  if (lower.includes('cors') || lower.includes('cross-origin'))
    return { summary: t('login.error_cors'), details };
  return { summary: t('login.error_invalid'), details };
}

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const language = useLanguageStore((state) => state.language);
  const setLanguage = useLanguageStore((state) => state.setLanguage);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const login = useAuthStore((state) => state.login);
  const restoreSession = useAuthStore((state) => state.restoreSession);

  const detectedBase = useMemo(() => detectApiBaseFromLocation(), []);
  // 首帧即用已保存的连接信息填好表单：没有可恢复会话时表单直接出现，不闪启动画面
  const [apiBase, setApiBase] = useState(() => useAuthStore.getState().apiBase || detectedBase);
  const [managementKey, setManagementKey] = useState(
    () => useAuthStore.getState().managementKey || ''
  );
  const [showCustomBase, setShowCustomBase] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [rememberPassword, setRememberPassword] = useState(() => {
    const { rememberPassword: remembered, managementKey: key } = useAuthStore.getState();
    return remembered || Boolean(key);
  });
  const [phase, setPhase] = useState<LoginPhase>('idle');
  // 仅在确实会自动登录时显示启动画面
  const [autoLoading, setAutoLoading] = useState(() =>
    useAuthStore.getState().hasRestorableSession()
  );
  const [autoLoginSuccess, setAutoLoginSuccess] = useState(false);
  const [error, setError] = useState<LoginError | null>(null);

  const startReveal = useLoginTransitionStore((state) => state.startReveal);
  const exitTimersRef = useRef<number[]>([]);
  const loading = phase === 'connecting';
  const redirectTarget = resolveLoginRedirect(location.state);

  useEffect(
    () => () => {
      exitTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    },
    []
  );

  const leaveTo = useCallback(
    (redirect: string, hold: number) => {
      const timings = getLoginTransitionTimings(prefersReducedMotion());
      const schedule = (callback: () => void, delay: number) => {
        exitTimersRef.current.push(window.setTimeout(callback, delay));
      };
      schedule(() => setPhase('exiting'), hold);
      schedule(() => {
        startReveal();
        navigate(redirect, { replace: true });
      }, hold + timings.exit);
    },
    [navigate, startReveal]
  );
  const languageOptions = useMemo(
    () =>
      LANGUAGE_ORDER.map((lang) => ({
        value: lang,
        label: t(LANGUAGE_LABEL_KEYS[lang]),
      })),
    [t]
  );
  const handleLanguageChange = useCallback(
    (selectedLanguage: string) => {
      if (!isSupportedLanguage(selectedLanguage)) {
        return;
      }
      setLanguage(selectedLanguage);
    },
    [setLanguage]
  );

  useEffect(() => {
    const splashStartedAt = performance.now();
    const init = async () => {
      try {
        const autoLoggedIn = await restoreSession();
        if (autoLoggedIn) {
          setAutoLoginSuccess(true);
          // 每次打开都会经过启动画面：网络快时补足最短停留，避免一闪而过；网络慢时不再额外等待
          const { splashMin } = getLoginTransitionTimings(prefersReducedMotion());
          const elapsed = performance.now() - splashStartedAt;
          leaveTo(redirectTarget, Math.max(0, splashMin - elapsed));
        } else {
          // 按最新的已保存信息回填表单（restoreSession 可能迁移了旧版存储）。
          // 自动登录被 401 拒绝时全局会登出并清空存储，此时保留首帧填入的地址与密钥，
          // 用户修正后即可直接重试，自定义地址也不会丢失。
          const stored = useAuthStore.getState();
          setApiBase((previous) => stored.apiBase || previous || detectedBase);
          setManagementKey((previous) => stored.managementKey || previous);
          setRememberPassword(
            (previous) => stored.rememberPassword || Boolean(stored.managementKey) || previous
          );
        }
      } finally {
        setAutoLoading(false);
      }
    };

    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSubmit = useCallback(async () => {
    if (phase !== 'idle') return;
    if (!managementKey.trim()) {
      setError({ summary: t('login.error_required') });
      return;
    }

    const baseToUse = apiBase ? normalizeApiBase(apiBase) : detectedBase;
    // 先进入 connecting：登录成功瞬间 isAuthenticated 变真时不会被立即重定向打断
    setPhase('connecting');
    setError(null);
    try {
      await login({
        apiBase: baseToUse,
        managementKey: managementKey.trim(),
        rememberPassword,
      });
    } catch (err: unknown) {
      // The form shows the error inline and announces it; a toast would say it twice.
      setPhase('idle');
      setError(describeLoginError(err, t));
      return;
    }
    setPhase('success');
    leaveTo(redirectTarget, getLoginTransitionTimings(prefersReducedMotion()).successHold);
  }, [
    apiBase,
    detectedBase,
    leaveTo,
    login,
    managementKey,
    phase,
    redirectTarget,
    rememberPassword,
    t,
  ]);

  if (isAuthenticated && !autoLoading && !autoLoginSuccess && phase === 'idle') {
    return <Navigate to={redirectTarget} replace />;
  }

  const showSplash = autoLoading || autoLoginSuccess;

  return (
    <div className={styles.container} data-phase={phase === 'exiting' ? 'exiting' : undefined}>
      <div className={styles.formPanel}>
        {/* 自动登录启动页自带大徽标与品牌名，此时不再渲染顶栏，避免重复 */}
        {!showSplash && (
          <header className={styles.topBar}>
            <div className={styles.brandMark}>
              <span className={styles.brandLogo} aria-hidden="true">
                <IconSidebarRouting size={14} />
              </span>
              <span className={styles.brandName} title={LOGIN_BRAND_NAME}>
                {LOGIN_BRAND_NAME}
              </span>
            </div>
            <Select
              className={styles.languageSelect}
              dropdownClassName={styles.languageDropdown}
              dropdownMinWidth={LANGUAGE_DROPDOWN_MIN_WIDTH}
              value={language}
              options={languageOptions}
              onChange={handleLanguageChange}
              fullWidth={false}
              size="sm"
              ariaLabel={t('language.switch')}
            />
          </header>
        )}

        <main className={styles.main}>
          {showSplash ? (
            <div className={styles.splash} role="status" aria-live="polite">
              <span className={styles.splashLogo} aria-hidden="true">
                <IconSidebarRouting size={22} />
              </span>
              <div className={styles.splashText}>
                <h1 className={styles.splashTitle}>{t('splash.title')}</h1>
                <p className={styles.splashSubtitle}>{t('splash.subtitle')}</p>
              </div>
              <div className={styles.splashLoader} aria-hidden="true">
                <div className={styles.splashLoaderBar} />
              </div>
            </div>
          ) : (
            <div className={styles.column}>
              <div className={styles.heading}>
                <h1 className={styles.title}>{t('login.title')}</h1>
                <p className={styles.subtitle}>{t('login.subtitle')}</p>
              </div>
              <LoginForm
                apiBase={apiBase}
                detectedBase={detectedBase}
                editingBase={showCustomBase}
                managementKey={managementKey}
                showKey={showKey}
                rememberPassword={rememberPassword}
                loading={loading}
                success={phase === 'success' || phase === 'exiting'}
                error={error?.summary ?? ''}
                errorDetails={error?.details}
                onApiBaseChange={setApiBase}
                onEditingBaseChange={setShowCustomBase}
                onManagementKeyChange={setManagementKey}
                onShowKeyChange={setShowKey}
                onRememberPasswordChange={setRememberPassword}
                onSubmit={handleSubmit}
              />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
