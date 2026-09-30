import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import {
  fetchLearningUnit,
  type ClinicalCaseContent,
  type LearningUnitContent,
  type LearningUnitDetail,
} from '@/lib/learnApi';
import { SourceCard } from '@/components/learn/SourceCard';
import { CaseScenario } from '@/components/learn/CaseScenario';
import { CaseCrossLinks } from '@/components/learn/CaseCrossLinks';
import { Prerequisites } from '@/components/learn/Prerequisites';
import { PreReadingGuide } from '@/components/learn/PreReadingGuide';
import { Objectives } from '@/components/learn/Objectives';
import { Assessment } from '@/components/learn/Assessment';

type Status = 'loading' | 'ok' | 'notfound' | 'error';

export function LearningUnitPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const [unit, setUnit] = useState<LearningUnitDetail | null>(null);
  const [status, setStatus] = useState<Status>('loading');

  useEffect(() => {
    let cancelled = false;
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      setStatus('notfound');
      return;
    }
    setStatus('loading');
    fetchLearningUnit(numericId)
      .then((data) => {
        if (cancelled) return;
        setUnit(data);
        setStatus('ok');
      })
      .catch((err: Error & { status?: number }) => {
        if (cancelled) return;
        setStatus(err.status === 404 ? 'notfound' : 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const backLink = (
    <Link
      to="/learn"
      className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" />
      {t('learn.back')}
    </Link>
  );

  if (status === 'loading') {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6">
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      </div>
    );
  }

  if (status === 'notfound' || status === 'error' || !unit) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6">
        {backLink}
        <p className="text-sm text-muted-foreground">
          {status === 'error' ? t('learn.loadError') : t('learn.notFound')}
        </p>
      </div>
    );
  }

  // A clinical case shows the safety-notice banner + scenario (no SourceCard /
  // PreReadingGuide, which are unit-only); a unit renders as before. The shared
  // pieces — Prerequisites, Objectives, Assessment — render for both, and
  // attempts persist identically since a case is a learning_units row.
  if (unit.kind === 'clinical_case') {
    const content = unit.content as ClinicalCaseContent;
    return (
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
        {backLink}
        <CaseScenario
          title={unit.title}
          difficulty={unit.difficulty}
          content={content}
        />
        <Prerequisites prerequisites={content.prerequisites} />
        <Objectives objectives={content.objectives} />
        <CaseCrossLinks crossLinks={content.crossLinks} />
        <Assessment questions={content.questions} unitId={unit.id} />
      </div>
    );
  }

  const content = unit.content as LearningUnitContent;

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
      {backLink}
      <SourceCard
        title={unit.title}
        difficulty={unit.difficulty}
        source={unit.source}
        card={content.sourceCard}
      />
      <Prerequisites prerequisites={content.prerequisites} />
      <PreReadingGuide prompts={content.preReadingPrompts} />
      <Objectives objectives={content.objectives} />
      <Assessment questions={content.questions} unitId={unit.id} />
    </div>
  );
}
