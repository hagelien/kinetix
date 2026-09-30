import {
  isKinelabCaseData,
  kinelabCaseDataSchema,
  KINELAB_CASE_KIND,
  type KineLabCaseData,
} from '@/types/kinelabCase';

// Thin wrapper over /api/simulator/cases. The case-API stores arbitrary
// JSONB; KineLab cases share the table and are tagged with
// `caseData.kind === 'kinelab-case'` so listing flows can filter them out
// from forward-simulator cases. No DB migration required.

export interface KinelabCaseRow {
  id: number;
  name: string;
  caseData: KineLabCaseData;
  createdAt: string;
  updatedAt?: string;
}

export async function saveKinelabCase(
  name: string,
  caseData: KineLabCaseData,
  caseId?: number,
): Promise<KinelabCaseRow> {
  const body = JSON.stringify({ name, caseData });
  const url = caseId
    ? `/api/simulator/cases?id=${caseId}`
    : '/api/simulator/cases';
  const method = caseId ? 'PUT' : 'POST';
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) {
    throw new Error(`Failed to save KineLab case: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as KinelabCaseRow;
}

export async function loadKinelabCase(id: number): Promise<KinelabCaseRow> {
  const res = await fetch(`/api/simulator/cases?id=${id}`);
  if (!res.ok) throw new Error('Failed to load case');
  const row = (await res.json()) as { id: number; name: string; caseData: unknown; createdAt: string; updatedAt?: string };
  if (!isKinelabCaseData(row.caseData)) {
    throw new Error('Saved case is not a KineLab case');
  }
  // Validate the JSONB against the Zod schema so a stale row written by an
  // older schema version surfaces as a clear error rather than a runtime
  // crash deep in the renderer.
  const parsed = kinelabCaseDataSchema.parse(row.caseData);
  return { ...row, caseData: parsed };
}

export async function listKinelabCases(): Promise<KinelabCaseRow[]> {
  // The default list endpoint omits caseData for bandwidth, so it can't be
  // filtered client-side. `?kind=` makes the server filter by the JSONB
  // discriminator AND include caseData in the response. We still re-check
  // `isKinelabCaseData` defensively in case a row was written before the
  // discriminator was enforced.
  const res = await fetch(
    `/api/simulator/cases?kind=${encodeURIComponent(KINELAB_CASE_KIND)}`,
  );
  if (!res.ok) return [];
  const data = (await res.json()) as {
    cases?: Array<{
      id: number;
      name: string;
      caseData: unknown;
      createdAt: string;
      updatedAt?: string;
    }>;
  };
  if (!Array.isArray(data.cases)) return [];
  return data.cases
    .filter((c) => isKinelabCaseData(c.caseData))
    .map((c) => ({
      id: c.id,
      name: c.name,
      caseData: c.caseData as KineLabCaseData,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));
}
