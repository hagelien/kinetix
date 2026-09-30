import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { Header } from '@/components/Header';
import { RouteToast } from '@/components/RouteToast';
import { DrugTableShell } from '@/components/drug-table/DrugTableShell';
import { GlobalShortcuts } from '@/components/GlobalShortcuts';
import { FloatingUnitConverter } from '@/components/FloatingUnitConverter';
import { FloatingBasket } from '@/components/FloatingBasket';
import { useAppStore } from '@/stores/appStore';

export function RootLayout() {
  const textScale = useAppStore((state) => state.textScale);
  const themeMode = useAppStore((state) => state.themeMode);

  useEffect(() => {
    document.documentElement.style.setProperty('--text-scale', String(textScale));
  }, [textScale]);

  useEffect(() => {
    function applyTheme(mode: typeof themeMode) {
      if (mode === 'dark') {
        document.documentElement.classList.add('dark');
      } else if (mode === 'light') {
        document.documentElement.classList.remove('dark');
      } else {
        // system
        if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
          document.documentElement.classList.add('dark');
        } else {
          document.documentElement.classList.remove('dark');
        }
      }
    }

    applyTheme(themeMode);

    if (themeMode === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => applyTheme('system');
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
  }, [themeMode]);

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <Header />
      <RouteToast />
      <DrugTableShell>
        <Outlet />
      </DrugTableShell>
      <GlobalShortcuts />
      <FloatingBasket />
      <FloatingUnitConverter />
    </div>
  );
}
