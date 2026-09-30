import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquare } from 'lucide-react';
import { fetchDrugByWikiDrugId } from '@/lib/drugApi';
import { fetchDrugIndicators } from '@/lib/drugIndicatorsApi';
import { DiscussionThread } from './DiscussionThread';

interface Props {
  drugCid: number;
}

export function MonographDiscussion({ drugCid }: Props) {
  const { t } = useTranslation();
  const [drugId, setDrugId] = useState<number | null>(null);
  const [commentCount, setCommentCount] = useState(0);

  useEffect(() => {
    fetchDrugByWikiDrugId(drugCid)
      .then(({ drug }) => setDrugId(drug.id))
      .catch(() => setDrugId(null));
  }, [drugCid]);

  useEffect(() => {
    if (drugId == null) return;
    fetchDrugIndicators(drugId)
      .then((data) => setCommentCount(data.comments.__monograph__ ?? 0))
      .catch(() => {});
  }, [drugId]);

  if (drugId == null) return null;

  return (
    <div className="mt-10 border-t border-border pt-6">
      <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
        <MessageSquare className="h-5 w-5 text-muted-foreground" />
        {t('discussion.monographTitle')}
        {commentCount > 0 && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
            {commentCount}
          </span>
        )}
      </h2>
      <DiscussionThread host={{ drugId }} parameter={null} />
    </div>
  );
}
