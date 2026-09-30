import type { AnalyticalMethod, DrugComponent } from '@/types';

export function methodIncludesDrug(
  method: AnalyticalMethod,
  drug: DrugComponent,
): boolean {
  const idIsDbFallback = drug._dbId != null && drug.id === String(drug._dbId);
  if (!idIsDbFallback && method.components?.includes(drug.id)) return true;
  return drug._dbId != null && (method.drugIds?.includes(drug._dbId) ?? false);
}

export function analyticalMethodsForDrug(
  methods: AnalyticalMethod[],
  drug: DrugComponent,
): AnalyticalMethod[] {
  return methods
    .filter((method) => methodIncludesDrug(method, drug))
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}
