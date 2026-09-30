import { useState, useRef, useEffect, type FormEvent } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { Trans, useTranslation } from 'react-i18next';

function StrongText({ children }: React.PropsWithChildren): JSX.Element {
  return <strong>{children}</strong>;
}

export function LoginPage() {
  const { t, i18n } = useTranslation();
  // The auth store reports its built-in fallbacks as i18n keys; a server-sent
  // string passes through unchanged. Translate only when the value is a key.
  const resolveAuthMessage = (msg: string) =>
    i18n.exists(msg) ? t(msg) : msg;
  const location = useLocation();
  const locationState = location.state as {
    message?: string;
    from?: { pathname?: string; search?: string; hash?: string };
  } | null;
  const redirectMessage = locationState?.message;
  // #310 P2: AuthGuard stashes the originally-requested path in
  // state.from so we can return the user there after a successful
  // login. Fall back to "/" (drug table) when there's no preserved
  // path — that covers direct visits to /login as well as routes that
  // don't pass a from value (e.g. /admin's role check).
  const fromPath = (() => {
    const from = locationState?.from;
    if (!from?.pathname || from.pathname === '/login') return '/';
    return `${from.pathname}${from.search ?? ''}${from.hash ?? ''}`;
  })();

  const [email, setEmail] = useState('');
  const [stayLoggedIn, setStayLoggedIn] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // OTP code step
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [codeDigits, setCodeDigits] = useState(['', '', '', '', '', '']);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const navigate = useNavigate();

  const {
    requestMagicLink,
    verifyCode,
    checkAuth,
    isAuthenticated,
    isLoading,
  } = useAuthStore();

  // Redirect if already logged in
  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      navigate(fromPath, { replace: true });
    }
  }, [isLoading, isAuthenticated, navigate, fromPath]);

  useEffect(() => {
    if (step === 'code') {
      inputRefs.current[0]?.focus();
    }
  }, [step]);

  async function handleEmailSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setMessage('');
    setIsSubmitting(true);

    try {
      const reply = await requestMagicLink(email, stayLoggedIn);
      setMessage(resolveAuthMessage(reply));
      setStep('code');
    } catch (err) {
      setError(
        err instanceof Error
          ? resolveAuthMessage(err.message)
          : t('auth.somethingWentWrong'),
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function submitCode(digits: string[]) {
    const code = digits.join('');
    if (code.length !== 6) return;
    setError('');
    setIsSubmitting(true);

    try {
      await verifyCode(email, code, stayLoggedIn);
      await checkAuth();
      navigate(fromPath, { replace: true });
    } catch (err) {
      setError(
        err instanceof Error
          ? resolveAuthMessage(err.message)
          : t('auth.invalidCode'),
      );
      setCodeDigits(['', '', '', '', '', '']);
      inputRefs.current[0]?.focus();
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleCodeInput(index: number, value: string) {
    // Allow only digits
    const digit = value.replace(/\D/g, '').slice(-1);
    const next = [...codeDigits];
    next[index] = digit;
    setCodeDigits(next);

    if (digit && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }

    // Auto-submit when all 6 digits filled
    if (digit && index === 5 && next.every((d) => d)) {
      submitCode(next);
    }
  }

  function handleCodeKeyDown(index: number, e: React.KeyboardEvent) {
    if (e.key === 'Backspace' && !codeDigits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  }

  function handleCodePaste(e: React.ClipboardEvent) {
    e.preventDefault();
    const pasted = e.clipboardData
      .getData('text')
      .replace(/\D/g, '')
      .slice(0, 6);
    if (!pasted) return;
    const next = [...codeDigits];
    for (let i = 0; i < 6; i++) {
      next[i] = pasted[i] ?? '';
    }
    setCodeDigits(next);
    if (pasted.length === 6) {
      submitCode(next);
    } else {
      inputRefs.current[Math.min(pasted.length, 5)]?.focus();
    }
  }

  return (
    <div className="flex-1 bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <Link to="/" className="inline-flex flex-col items-center gap-2">
            <img
              src="/kinetix_logo.png"
              alt="Kinetix"
              className="h-12 w-auto"
            />
            <span className="font-display text-2xl font-bold text-foreground">
              Kinetix
            </span>
          </Link>
          <p className="text-muted-foreground mt-2">
            {step === 'email' ? t('auth.signInWithCode') : t('auth.enterCode')}
          </p>
        </div>

        <div className="bg-card border border-border rounded-lg p-6">
          {redirectMessage && !error && step === 'email' && (
            <div className="mb-4 p-3 bg-blue-50 text-blue-700 text-sm rounded-md">
              {redirectMessage}
            </div>
          )}
          {error && (
            <div className="mb-4 p-3 bg-destructive/10 text-destructive text-sm rounded-md">
              {error}
            </div>
          )}
          {message && step === 'code' && (
            <div className="mb-4 p-3 bg-emerald-50 text-emerald-700 text-sm rounded-md">
              {message}
            </div>
          )}

          {step === 'email' ? (
            <form onSubmit={handleEmailSubmit} className="space-y-4">
              <div>
                <label
                  htmlFor="email"
                  className="block text-sm font-medium mb-1"
                >
                  {t('auth.email')}
                </label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  className="w-full px-3 py-2 bg-background border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder="you@kinetix.no"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('auth.allowlistNote')}
                </p>
              </div>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={stayLoggedIn}
                  onChange={(e) => setStayLoggedIn(e.target.checked)}
                />
                {t('auth.stayLoggedIn')}
              </label>

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full py-2 px-4 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
              >
                {isSubmitting ? t('auth.sendingCode') : t('auth.sendCode')}
              </button>
            </form>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground text-center">
                <Trans
                  i18nKey="auth.codeSent"
                  values={{ email }}
                  components={{ strong: <StrongText /> }}
                />
              </p>

              <div
                className="flex justify-center gap-2"
                onPaste={handleCodePaste}
              >
                {codeDigits.map((digit, i) => (
                  <input
                    key={i}
                    ref={(el) => {
                      inputRefs.current[i] = el;
                    }}
                    type="text"
                    inputMode="numeric"
                    maxLength={1}
                    value={digit}
                    onChange={(e) => handleCodeInput(i, e.target.value)}
                    onKeyDown={(e) => handleCodeKeyDown(i, e)}
                    disabled={isSubmitting}
                    className="w-11 h-14 text-center text-2xl font-mono font-bold bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                  />
                ))}
              </div>

              <p className="text-center text-xs text-muted-foreground">
                {t('auth.codeValid')}
              </p>

              <button
                type="button"
                onClick={() => {
                  setStep('email');
                  setCodeDigits(['', '', '', '', '', '']);
                  setError('');
                  setMessage('');
                }}
                className="w-full py-2 text-sm text-muted-foreground hover:text-foreground"
              >
                {t('auth.differentEmail')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
