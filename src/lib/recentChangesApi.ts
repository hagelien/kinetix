import type { UserBadgeData } from '@/components/ui/UserBadge';

export interface RecentDrugParameterChange {
  type: 'drug_parameter';
  id: number;
  parameter: string;
  editSummary: string | null;
  createdAt: string;
  drug: {
    // Both optional: a response served from cache across a deploy may
    // still be in the previous, slug-only shape (no `id`), or a client on
    // the previous frontend bundle may receive this shape (no use for
    // `slug`, but it's kept so that bundle keeps working).
    id?: number;
    slug?: string;
    names: Record<string, string>;
    nameShort: string | null;
  };
  author: UserBadgeData | null;
}

export interface RecentWikiChange {
  type: 'wiki';
  id: number;
  editSummary: string | null;
  createdAt: string;
  page: {
    slug: string;
    title: string;
  };
  author: UserBadgeData | null;
}

export type RecentChange = RecentDrugParameterChange | RecentWikiChange;

export async function fetchRecentChanges(
  limit?: number,
): Promise<{ changes: RecentChange[] }> {
  const url =
    limit != null ? `/api/recent-changes?limit=${limit}` : '/api/recent-changes';
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Request failed with status ${res.status}`);
  }
  return res.json();
}
