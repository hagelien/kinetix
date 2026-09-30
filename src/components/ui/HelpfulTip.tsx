import {
  useEffect,
  useId,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { HelpCircle, X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useHoverGrace } from '@/lib/useHoverGrace';

interface HelpfulTipProps {
  /**
   * Stable identifier for this tip. Used to remember the user's
   * "don't show this again" choice across reloads. Keep it unique per
   * distinct tip (e.g. `unit-converter-settings`).
   */
  id: string;
  /** Tooltip body — already-translated content, may include links. */
  content: ReactNode;
  /**
   * When true, the tip auto-opens (provided tips are globally enabled and
   * this tip hasn't been dismissed). Drive this from a nearby interaction —
   * e.g. the first time the user focuses a form control — to surface the tip
   * without the user hunting for the `?` button.
   */
  autoShow?: boolean;
  /** Accessible label for the manual help trigger. */
  triggerLabel: string;
  /** Optional extra classes for the wrapping span. */
  className?: string;
}

/**
 * Universal "helpful tip" affordance, reusable anywhere on the site.
 *
 * Two ways to surface the same popover:
 *  1. The user hovers/focuses a small `?` button (always available).
 *  2. `autoShow` is set by the host while the universal tips feature is on
 *     and the tip hasn't been dismissed — the popover appears on its own.
 *
 * The popover always offers the user a way out: "don't show this again"
 * (dismisses just this tip) and "turn off tips" (the global master switch in
 * the app store). Both are reversible from the preferences page.
 */
export function HelpfulTip({
  id,
  content,
  autoShow = false,
  triggerLabel,
  className,
}: HelpfulTipProps) {
  const { t } = useTranslation();
  const tipsEnabled = useAppStore((s) => s.tipsEnabled);
  const dismissed = useAppStore((s) => s.dismissedTips.includes(id));
  const dismissTip = useAppStore((s) => s.dismissTip);
  const setTipsEnabled = useAppStore((s) => s.setTipsEnabled);

  // Hover/focus open-state lives in the shared grace hook: spreading
  // `hoverProps` on both the trigger and the popover lets the pointer cross the
  // gap into the popover (to click the link or the dismiss controls) without it
  // closing out from under the user.
  const { open: hoverOpen, hoverProps, toggle, close: closeHover } =
    useHoverGrace();
  // Tracks whether the auto-show has been acknowledged this mount so a single
  // dismissal/close doesn't immediately reopen while `autoShow` stays true.
  const [autoDismissed, setAutoDismissed] = useState(false);
  const tooltipId = useId();

  const autoOpen = autoShow && tipsEnabled && !dismissed && !autoDismissed;
  const open = hoverOpen || autoOpen;

  // Reset the local auto-dismissal if the host stops requesting an auto-show,
  // so a later interaction can surface the tip again within the same mount.
  useEffect(() => {
    if (!autoShow) setAutoDismissed(false);
  }, [autoShow]);

  function close() {
    closeHover();
    setAutoDismissed(true);
  }

  return (
    <span className={`relative inline-flex items-center ${className ?? ''}`}>
      <button
        type="button"
        aria-label={triggerLabel}
        title={triggerLabel}
        aria-describedby={open ? tooltipId : undefined}
        {...hoverProps}
        onClick={toggle}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
      >
        <HelpCircle className="h-4 w-4" />
      </button>

      {open && (
        <span
          id={tooltipId}
          role="tooltip"
          {...hoverProps}
          className="absolute left-0 top-full z-50 mt-2 w-64 rounded-md border border-border bg-popover p-3 text-left text-xs leading-relaxed text-popover-foreground shadow-md"
        >
          <button
            type="button"
            aria-label={t('helpfulTip.close') as string}
            onClick={close}
            className="absolute right-1.5 top-1.5 text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
          <span className="block pr-4">{content}</span>
          <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 border-t border-border pt-2 text-[11px]">
            <button
              type="button"
              onClick={() => {
                dismissTip(id);
                close();
              }}
              className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {t('helpfulTip.dontShowAgain')}
            </button>
            <button
              type="button"
              onClick={() => {
                setTipsEnabled(false);
                close();
              }}
              className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {t('helpfulTip.turnOffTips')}
            </button>
          </span>
        </span>
      )}
    </span>
  );
}
