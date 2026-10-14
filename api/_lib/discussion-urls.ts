/**
 * Route to a drug-scoped discussion comment. A parameter thread opens that
 * parameter's discussion at the comment. A `fact:<id>` thread has no parameter
 * panel: the link carries the fact id and the monograph page picks the fact's
 * tab and opens its discussion. A whole-monograph thread has nothing to open.
 */
export function drugDiscussionUrl(row: {
  id: number;
  drugId: number;
  parameter: string | null;
}): string {
  const base = `/wiki/drug/${row.drugId}`;
  if (!row.parameter) return base;
  if (row.parameter.startsWith('fact:')) {
    const fact = row.parameter.slice('fact:'.length);
    return fact
      ? `${base}?${new URLSearchParams({ fact, comment: String(row.id) })}`
      : base;
  }
  return `${base}?${new URLSearchParams({
    param: row.parameter,
    view: 'discussion',
    comment: String(row.id),
  })}`;
}
