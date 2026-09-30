export interface InlineRefSegment {
  /** First reference number in this segment (inclusive). */
  from: number;
  /** Last reference number in this segment (inclusive). Equal to `from` for a singleton. */
  to: number;
}

/**
 * Collapses inline reference numbers, folding any contiguous run of two or
 * more consecutive integers into a single `from–to` segment. Citation groups
 * are sorted first so markers render in ascending bibliography order.
 */
export function compactInlineRefs(nums: number[]): InlineRefSegment[] {
  const sorted = [...nums].sort((a, b) => a - b);
  const result: InlineRefSegment[] = [];
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i]!;
    let j = i + 1;
    while (j < sorted.length && sorted[j] === sorted[j - 1]! + 1) j++;
    if (j - i >= 2) {
      result.push({ from: start, to: sorted[j - 1]! });
    } else {
      for (let k = i; k < j; k++)
        result.push({ from: sorted[k]!, to: sorted[k]! });
    }
    i = j;
  }
  return result;
}

const RENDERED_MARKER_RE =
  /<sup class="footnote-marker"(?: data-reference-ids="([^"]*)")?><a href="#param-ref-(\d+)">\[\d+\]<\/a><\/sup>/g;
const RENDERED_MARKER_RUN_RE =
  /<sup class="footnote-marker"(?: data-reference-ids="[^"]*")?><a href="#param-ref-\d+">\[\d+\]<\/a><\/sup>(?:\s*<sup class="footnote-marker"(?: data-reference-ids="[^"]*")?><a href="#param-ref-\d+">\[\d+\]<\/a><\/sup>){1,}/g;

interface RenderedMarker {
  num: number;
  referenceIds: string[];
}

function markerHtml(
  num: number,
  to = num,
  referenceIds: string[] = [],
): string {
  const idsAttr =
    referenceIds.length > 0
      ? ` data-reference-ids="${referenceIds.join(",")}"`
      : "";
  const label = to === num ? `[${num}]` : `[${num}–${to}]`;
  return `<sup class="footnote-marker"${idsAttr}><a href="#param-ref-${num}">${label}</a></sup>`;
}

/**
 * Post-processes WikiRenderer output to sort adjacent footnote marker groups
 * and collapse runs of two or more consecutive markers into compact `[N–M]`
 * segments. Runs that mix non-consecutive numbers stay as individual markers.
 */
export function compactRenderedRefs(html: string): string {
  return html.replace(RENDERED_MARKER_RUN_RE, (run) => {
    const markers: RenderedMarker[] = [];
    for (const m of run.matchAll(RENDERED_MARKER_RE)) {
      markers.push({
        referenceIds: m[1] ? m[1].split(",").filter(Boolean) : [],
        num: Number(m[2]),
      });
    }
    if (markers.length === 0) return run;

    markers.sort((a, b) => a.num - b.num);

    const out: string[] = [];
    let i = 0;
    while (i < markers.length) {
      const start = markers[i]!;
      let j = i + 1;
      while (
        j < markers.length &&
        markers[j]!.num === markers[j - 1]!.num + 1
      ) {
        j++;
      }
      if (j - i >= 2) {
        const end = markers[j - 1]!;
        out.push(
          markerHtml(
            start.num,
            end.num,
            markers.slice(i, j).flatMap((marker) => marker.referenceIds),
          ),
        );
      } else {
        for (let k = i; k < j; k++) {
          const marker = markers[k]!;
          out.push(markerHtml(marker.num, marker.num, marker.referenceIds));
        }
      }
      i = j;
    }
    return out.join("");
  });
}
