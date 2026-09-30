import type { UserBadgeData } from '@/components/ui/UserBadge';

export interface PriorityFlagRow {
  id: number;
  drugId: number;
  parameter: string | null;
  status: 'active' | 'resolved' | 'cancelled';
  note: string | null;
  flaggedBy: number | null;
  resolvedBy: number | null;
  createdAt: string;
  resolvedAt: string | null;
  drugName?: string | null;
  flaggedByUser?: ({ id: number } & UserBadgeData) | null;
  resolvedByUser?: ({ id: number } & UserBadgeData) | null;
}

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export async function fetchPriorityFlags(params?: {
  status?: 'active' | 'resolved' | 'cancelled' | 'all';
  drugId?: number;
  parameter?: string | null;
}): Promise<{ flags: PriorityFlagRow[] }> {
  const sp = new URLSearchParams();
  if (params?.status) sp.set('status', params.status);
  if (params?.drugId) sp.set('drugId', String(params.drugId));
  if (params?.parameter !== undefined) {
    sp.set('parameter', params.parameter ?? 'null');
  }
  return apiFetch(`/api/parameter-priority-flags?${sp}`);
}

export async function createPriorityFlag(data: {
  drugId: number;
  parameter?: string;
  note?: string;
}): Promise<{ flag: PriorityFlagRow }> {
  return apiFetch('/api/parameter-priority-flags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function updatePriorityFlag(
  id: number,
  data: { status: 'active' | 'resolved' | 'cancelled'; note?: string },
): Promise<{ flag: PriorityFlagRow }> {
  return apiFetch(`/api/parameter-priority-flags?id=${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function cancelPriorityFlag(id: number): Promise<void> {
  await apiFetch(`/api/parameter-priority-flags?id=${id}`, { method: 'DELETE' });
}
