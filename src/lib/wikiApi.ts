import type { UserBadgeData } from "@/components/ui/UserBadge";

export interface WikiPageSummary {
  id: number;
  slug: string;
  title: string;
  pageType: string;
  drugCid: number | null;
  updatedAt: string;
  updatedBy: UserBadgeData | null;
}

export interface WikiPageFull extends WikiPageSummary {
  content: unknown;
  contentHtml: string;
  status: string;
}

export interface WikiRevision {
  id: number;
  content: unknown;
  editSummary: string | null;
  createdBy: { username: string } | null;
  createdAt: string;
}

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  let data: Record<string, unknown>;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Request failed with status ${res.status}`);
  }
  if (!res.ok) {
    throw new Error(
      (data.error as string) ?? `Request failed with status ${res.status}`,
    );
  }
  return data as T;
}

export async function fetchWikiPages(params?: {
  pageType?: string;
  limit?: number;
  offset?: number;
}): Promise<{ pages: WikiPageSummary[]; total: number; hasMore: boolean }> {
  const searchParams = new URLSearchParams();
  if (params?.pageType) searchParams.set("pageType", params.pageType);
  if (params?.limit) searchParams.set("limit", String(params.limit));
  if (params?.offset) searchParams.set("offset", String(params.offset));
  return apiFetch(`/api/wiki/pages?${searchParams}`);
}

export async function fetchWikiPage(
  slug: string,
): Promise<{ page: WikiPageFull }> {
  return apiFetch(`/api/wiki/pages?slug=${encodeURIComponent(slug)}`);
}

export async function createWikiPage(data: {
  title: string;
  content: unknown;
  pageType?: string;
  drugCid?: number;
  editSummary?: string;
}): Promise<{ page: { id: number; slug: string; title: string } }> {
  return apiFetch("/api/wiki/pages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function updateWikiPage(
  slug: string,
  data: {
    title?: string;
    content?: unknown;
    editSummary?: string;
  },
): Promise<{ page: { id: number; slug: string; title: string } }> {
  return apiFetch(`/api/wiki/pages?slug=${encodeURIComponent(slug)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function fetchWikiHistory(slug: string): Promise<{
  pageTitle: string;
  revisions: WikiRevision[];
  limit: number;
  offset: number;
  hasMore: boolean;
}> {
  return apiFetch(`/api/wiki/history?slug=${encodeURIComponent(slug)}`);
}

export async function fetchDrugWikiPage(
  cid: number,
): Promise<{ page: WikiPageSummary | null }> {
  return apiFetch(`/api/wiki/pages?drugCid=${cid}`);
}
