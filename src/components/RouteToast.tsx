import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';

interface ToastState {
  toast?: string;
}

export function RouteToast() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const toast = (location.state as ToastState | null)?.toast;
    if (!toast) return;

    setMessage(toast);
    navigate(location.pathname + location.search, {
      replace: true,
      state: null,
    });
  }, [location, navigate]);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(null), 3500);
    return () => window.clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    function handleToast(event: Event) {
      const customEvent = event as CustomEvent<{ message?: string }>;
      if (customEvent.detail?.message) {
        setMessage(customEvent.detail.message);
      }
    }

    window.addEventListener('kinetix:toast', handleToast);
    return () => window.removeEventListener('kinetix:toast', handleToast);
  }, []);

  if (!message) return null;

  return (
    <div className="fixed right-4 top-20 z-50 max-w-sm rounded-lg border border-success/60 bg-card px-4 py-3 text-sm text-card-foreground shadow-lg">
      <div className="flex items-start justify-between gap-3">
        <p>{message}</p>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => setMessage(null)}
          aria-label={t('common.dismiss')}
        >
          ×
        </button>
      </div>
    </div>
  );
}
