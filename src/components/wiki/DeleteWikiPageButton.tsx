import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useCan } from '@/lib/usePermissions';
import { showToast } from '@/lib/toast';

interface DeleteWikiPageButtonProps {
  slug: string;
  title: string;
}

/**
 * Permanently deletes a wiki page — its facts, revisions, fact discussions and
 * pending proposals go with it (see the DELETE handler in api/wiki/pages.ts).
 * Shown only to callers holding `wiki.page.delete`; there is no undo, so the
 * click asks for confirmation first.
 */
export function DeleteWikiPageButton({ slug, title }: DeleteWikiPageButtonProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canDelete = useCan('wiki.page.delete');
  const [deleting, setDeleting] = useState(false);

  if (!canDelete) return null;

  async function handleClick() {
    if (!window.confirm(t('wiki.deletePageConfirm', { title }))) return;
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/wiki/pages?slug=${encodeURIComponent(slug)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      navigate('/wiki', { replace: true });
    } catch {
      setDeleting(false);
      showToast(t('wiki.deletePageError'));
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={deleting}
      className="px-3 py-1.5 rounded-md text-destructive hover:bg-destructive/10 disabled:opacity-50"
    >
      {deleting ? t('wiki.deletingPage') : t('wiki.deletePage')}
    </button>
  );
}
