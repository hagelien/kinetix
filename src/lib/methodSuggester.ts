import type { MethodMatrix, MethodRow, MethodType } from '@/lib/drugApi';

/**
 * Confirmatory-method basket suggester.
 *
 * Given a basket of components (analytes the user wants confirmed) and the
 * catalogue of analytical methods, this proposes the combinations of
 * *confirmatory-capable* methods that cover every basket component, optimising
 * two competing objectives:
 *   1. the fewest individual methods, and
 *   2. the least net sample volume.
 *
 * Net volume is only physically meaningful within a single sample matrix
 * (you cannot pool a blood method and a urine method into one draw), so the
 * problem is solved independently per matrix and the non-dominated
 * (Pareto-optimal) solutions are returned for each. The UI surfaces, e.g.,
 * both the fewest-methods combo and the lowest-volume combo when they differ.
 */

/** A component the suggester must cover. */
export interface BasketComponent {
  drugId: number;
  pubchemCid: number | null;
  drugName: string;
}

/** Method types that can run a confirmatory analysis. */
const CONFIRMATORY_TYPES: ReadonlySet<MethodType> = new Set<MethodType>([
  'confirmatory',
  'screening_confirmatory',
]);

export function isConfirmatoryMethod(method: MethodRow): boolean {
  return method.methodType != null && CONFIRMATORY_TYPES.has(method.methodType);
}

/** True when `method` includes `component` in its component set. */
export function methodCoversComponent(
  method: MethodRow,
  component: BasketComponent,
): boolean {
  if (method.drugIds.includes(component.drugId)) return true;
  return (
    component.pubchemCid != null &&
    method.pubchemCids.includes(component.pubchemCid)
  );
}

/** One candidate combination of methods that fully covers the basket. */
export interface MethodSolution {
  methods: MethodRow[];
  methodCount: number;
  /** Summed sample volume; null when any chosen method has an unknown volume. */
  totalVolumeMl: number | null;
  /** True when at least one chosen method has no recorded volume. */
  hasUnknownVolume: boolean;
}

/** Suggestions for a single sample matrix. */
export interface MatrixSuggestion {
  matrix: MethodMatrix;
  /** Pareto-optimal full-coverage combinations, best-ranked first. */
  solutions: MethodSolution[];
  /** Components no confirmatory method in this matrix can cover. */
  uncoverableComponents: BasketComponent[];
}

export interface SuggestionResult {
  /** Per-matrix suggestions, only for matrices with ≥1 covering method. */
  matrices: MatrixSuggestion[];
  /**
   * Components that no confirmatory method covers in *any* matrix — there is
   * no confirmatory analysis available for these at all.
   */
  globallyUncoverable: BasketComponent[];
}

/** Above this many candidate methods in a matrix we fall back to greedy. */
const EXACT_SOLVE_LIMIT = 24;

interface PreparedMethod {
  method: MethodRow;
  /** Bitmask over the matrix's coverable-component index space. */
  mask: number;
  volume: number | null;
}

/**
 * Enumerate Pareto-optimal full-coverage combinations over `targetMask`.
 * Objectives: (methodCount, totalVolume). A solution dominates another when it
 * is no worse on both and strictly better on one. Exact branch-and-bound; the
 * candidate set per matrix is small in practice.
 */
function solveExact(
  prepared: PreparedMethod[],
  targetMask: number,
): MethodSolution[] {
  const frontier: MethodSolution[] = [];

  const consider = (chosen: PreparedMethod[]) => {
    const candidate = buildSolution(chosen);
    // Drop the candidate if an existing frontier entry dominates it; drop any
    // existing entries the candidate dominates.
    for (const existing of frontier) {
      if (dominates(existing, candidate)) return;
    }
    for (let i = frontier.length - 1; i >= 0; i -= 1) {
      const entry = frontier[i];
      if (entry && dominates(candidate, entry)) frontier.splice(i, 1);
    }
    frontier.push(candidate);
  };

  const recurse = (start: number, covered: number, chosen: PreparedMethod[]) => {
    if (covered === targetMask) {
      consider(chosen);
      return;
    }
    // Prune: even taking every remaining method, can we still finish coverage?
    const reachable = prepared
      .slice(start)
      .reduce((acc, p) => acc | p.mask, covered);
    if ((reachable & targetMask) !== targetMask) return;

    for (let i = start; i < prepared.length; i += 1) {
      const next = prepared[i];
      // Skip methods that add no new coverage along this branch.
      if (!next || (next.mask & ~covered & targetMask) === 0) continue;
      chosen.push(next);
      recurse(i + 1, covered | next.mask, chosen);
      chosen.pop();
    }
  };

  recurse(0, 0, []);
  return sortSolutions(frontier);
}

/** Greedy max-coverage fallback for large candidate sets (≈ ln n optimal). */
function solveGreedy(
  prepared: PreparedMethod[],
  targetMask: number,
): MethodSolution[] {
  const chosen: PreparedMethod[] = [];
  let covered = 0;
  const remaining = [...prepared];
  while (covered !== targetMask && remaining.length > 0) {
    let bestIndex = -1;
    let bestGain = 0;
    let bestVolume = Number.POSITIVE_INFINITY;
    for (let i = 0; i < remaining.length; i += 1) {
      const candidate = remaining[i];
      if (!candidate) continue;
      const gain = popcount(candidate.mask & ~covered & targetMask);
      if (gain === 0) continue;
      const volume = candidate.volume ?? 0;
      // Prefer most new coverage; break ties on smaller added volume.
      if (gain > bestGain || (gain === bestGain && volume < bestVolume)) {
        bestIndex = i;
        bestGain = gain;
        bestVolume = volume;
      }
    }
    if (bestIndex === -1) break;
    const [picked] = remaining.splice(bestIndex, 1);
    if (!picked) break;
    chosen.push(picked);
    covered |= picked.mask;
  }
  if (covered !== targetMask) return [];
  return [buildSolution(chosen)];
}

function buildSolution(chosen: PreparedMethod[]): MethodSolution {
  const hasUnknownVolume = chosen.some((p) => p.volume == null);
  const totalVolumeMl = hasUnknownVolume
    ? null
    : chosen.reduce((sum, p) => sum + (p.volume ?? 0), 0);
  return {
    methods: chosen.map((p) => p.method),
    methodCount: chosen.length,
    totalVolumeMl,
    hasUnknownVolume,
  };
}

/** True when `a` is no worse than `b` on both objectives and better on one. */
function dominates(a: MethodSolution, b: MethodSolution): boolean {
  const aVol = a.totalVolumeMl ?? Number.POSITIVE_INFINITY;
  const bVol = b.totalVolumeMl ?? Number.POSITIVE_INFINITY;
  const noWorse = a.methodCount <= b.methodCount && aVol <= bVol;
  const strictlyBetter = a.methodCount < b.methodCount || aVol < bVol;
  return noWorse && strictlyBetter;
}

function sortSolutions(solutions: MethodSolution[]): MethodSolution[] {
  return [...solutions].sort((a, b) => {
    if (a.methodCount !== b.methodCount) return a.methodCount - b.methodCount;
    const aVol = a.totalVolumeMl ?? Number.POSITIVE_INFINITY;
    const bVol = b.totalVolumeMl ?? Number.POSITIVE_INFINITY;
    return aVol - bVol;
  });
}

function popcount(n: number): number {
  let count = 0;
  let value = n;
  while (value) {
    value &= value - 1;
    count += 1;
  }
  return count;
}

/**
 * Suggest confirmatory method combinations for a basket of components.
 */
export function suggestConfirmatoryMethods(
  basket: BasketComponent[],
  methods: MethodRow[],
): SuggestionResult {
  if (basket.length === 0) {
    return { matrices: [], globallyUncoverable: [] };
  }

  const confirmatory = methods.filter(isConfirmatoryMethod);

  // Which basket components can be covered by *any* confirmatory method.
  const coverableGlobally = new Set<number>();
  for (const method of confirmatory) {
    for (const component of basket) {
      if (methodCoversComponent(method, component)) {
        coverableGlobally.add(component.drugId);
      }
    }
  }
  const globallyUncoverable = basket.filter(
    (c) => !coverableGlobally.has(c.drugId),
  );

  // Every matrix any confirmatory method declares.
  const matrices = new Set<MethodMatrix>();
  for (const method of confirmatory) {
    for (const matrix of method.matrices) matrices.add(matrix);
  }

  const matrixSuggestions: MatrixSuggestion[] = [];
  for (const matrix of matrices) {
    const matrixMethods = confirmatory.filter((m) =>
      m.matrices.includes(matrix),
    );

    // Components this matrix can cover define the index space; the rest are
    // reported as uncoverable for this matrix.
    const coverable: BasketComponent[] = [];
    const uncoverableComponents: BasketComponent[] = [];
    for (const component of basket) {
      const covered = matrixMethods.some((m) =>
        methodCoversComponent(m, component),
      );
      (covered ? coverable : uncoverableComponents).push(component);
    }

    if (coverable.length === 0) continue;

    const indexOf = new Map<number, number>();
    coverable.forEach((c, i) => indexOf.set(c.drugId, i));
    const targetMask = (1 << coverable.length) - 1;

    // Build per-method bitmasks; drop methods that cover nothing relevant.
    const prepared: PreparedMethod[] = [];
    for (const method of matrixMethods) {
      let mask = 0;
      for (const component of coverable) {
        if (methodCoversComponent(method, component)) {
          mask |= 1 << (indexOf.get(component.drugId) as number);
        }
      }
      if (mask !== 0) {
        prepared.push({ method, mask, volume: method.volumeMl });
      }
    }
    // Drop methods whose coverage is a subset of another's with no smaller
    // volume — they can never improve a solution. Keeps the search small.
    const pruned = dropDominatedMethods(prepared);

    const solutions =
      pruned.length <= EXACT_SOLVE_LIMIT
        ? solveExact(pruned, targetMask)
        : solveGreedy(pruned, targetMask);

    matrixSuggestions.push({ matrix, solutions, uncoverableComponents });
  }

  matrixSuggestions.sort((a, b) => a.matrix.localeCompare(b.matrix));
  return { matrices: matrixSuggestions, globallyUncoverable };
}

/**
 * Remove methods whose component coverage is a subset of another method that
 * costs no more volume — such a method can never be part of a Pareto-optimal
 * solution, so dropping it shrinks the search without losing any answer.
 */
function dropDominatedMethods(prepared: PreparedMethod[]): PreparedMethod[] {
  return prepared.filter((candidate, i) =>
    !prepared.some((other, j) => {
      if (i === j) return false;
      const isSubset =
        (candidate.mask & other.mask) === candidate.mask &&
        candidate.mask !== other.mask;
      const equalCoverage = candidate.mask === other.mask;
      const otherVol = other.volume ?? Number.POSITIVE_INFINITY;
      const candVol = candidate.volume ?? Number.POSITIVE_INFINITY;
      // Strict subset and cheaper-or-equal → dominated.
      if (isSubset && otherVol <= candVol) return true;
      // Identical coverage → keep only one (drop the costlier / higher index).
      if (equalCoverage && (otherVol < candVol || (otherVol === candVol && j < i)))
        return true;
      return false;
    }),
  );
}
