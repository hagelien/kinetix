import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ClipboardCopy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCan } from '@/lib/usePermissions';
import { fillDrugName, loadSeedPromptTemplate } from '@/lib/deepResearchPrompt';
import { copyPendingTextToClipboard, copyTextToClipboard } from '@/lib/clipboard';
import { showToast } from '@/lib/toast';

interface DrugSeedPromptButtonProps {
  /** Substance name substituted into the prompt's Input section. */
  drugName: string;
}

/** How long the button stays in its "copied" state before reverting (ms). */
const COPIED_FEEDBACK_MS = 2000;

/**
 * One-click copy of the deep-research seeding prompt for this drug.
 *
 * Seeding a monograph starts by pasting `agents/deep-research-drug-seeding.md`
 * into a research agent with the substance filled in; the JSON that comes back
 * is imported under **Admin → Seed drug**. Everything before the paste was
 * manual — open the file, copy the marked block, leave the operator notes
 * behind, substitute the name — so this puts it one click from the monograph
 * whose gaps prompted the run in the first place.
 *
 * Gated on `admin.researchImport.run`, the capability behind
 * `POST /api/research-import`: the same people who can act on the JSON are the
 * ones offered the prompt that produces it. The prompt itself is public (it is
 * in the repo), so this is an affordance, not a secret.
 */
export function DrugSeedPromptButton({ drugName }: DrugSeedPromptButtonProps) {
  const { t } = useTranslation();
  const canSeedFromResearch = useCan('admin.researchImport.run');
  const [status, setStatus] = useState<'idle' | 'busy' | 'copied'>('idle');
  const [template, setTemplate] = useState<string | null>(null);

  // Warm the prompt chunk as soon as the button exists, so the press that
  // follows has the text in hand. A clipboard write only holds the user's
  // transient activation for as long as it does not wait on the network — the
  // first click would otherwise be the one that pays for the fetch, and on
  // WebKit it is the one that gets refused. Only admins render this, so nobody
  // else pays for the download.
  useEffect(() => {
    if (!canSeedFromResearch) return;
    let live = true;
    loadSeedPromptTemplate()
      .then((loaded) => {
        if (live) setTemplate(loaded);
      })
      .catch(() => {
        // Leave `template` null: the click path retries the load and reports
        // a failure the user can act on, rather than a dead button.
      });
    return () => {
      live = false;
    };
  }, [canSeedFromResearch]);

  useEffect(() => {
    if (status !== 'copied') return;
    const timer = setTimeout(() => setStatus('idle'), COPIED_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [status]);

  const name = drugName.trim();
  if (!canSeedFromResearch || !name) return null;

  function onCopy() {
    setStatus('busy');
    let copied: Promise<void>;
    try {
      copied =
        template != null
          ? // The normal path: filling the name is pure string work, so the
            // clipboard call is the first thing this handler does.
            copyTextToClipboard(fillDrugName(template, name))
          : // A press that beat the prefetch. Hand the clipboard the pending
            // text instead of awaiting it, which keeps the gesture.
            copyPendingTextToClipboard(
              loadSeedPromptTemplate().then((loaded) => fillDrugName(loaded, name)),
            );
    } catch (err) {
      copied = Promise.reject(err);
    }
    copied
      .then(() => {
        setStatus('copied');
        showToast(t('wiki.seedPrompt.copiedToast', { drug: name }));
      })
      .catch(() => {
        setStatus('idle');
        showToast(t('wiki.seedPrompt.failed'));
      });
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onCopy}
      disabled={status === 'busy'}
      title={t('wiki.seedPrompt.hint', { drug: name })}
      className="gap-1.5"
    >
      {status === 'copied' ? (
        <Check className="h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <ClipboardCopy className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      {status === 'copied'
        ? t('wiki.seedPrompt.copied')
        : status === 'busy'
          ? t('wiki.seedPrompt.copying')
          : t('wiki.seedPrompt.copy')}
    </Button>
  );
}
