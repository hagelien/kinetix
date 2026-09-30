import { describe, expect, it } from 'vitest';
import type { MethodMatrix, MethodRow, MethodType } from './drugApi';
import {
  isConfirmatoryMethod,
  methodCoversComponent,
  suggestConfirmatoryMethods,
  type BasketComponent,
} from './methodSuggester';

let nextId = 1;
function method(overrides: Partial<MethodRow>): MethodRow {
  const id = overrides.id ?? nextId++;
  return {
    id,
    code: `M${id}`,
    name: `Method ${id}`,
    description: null,
    matrices: ['blood'] as MethodMatrix[],
    volumeMl: 1,
    methodType: 'confirmatory' as MethodType,
    componentCount: overrides.drugIds?.length ?? 0,
    drugIds: [],
    pubchemCids: [],
    ...overrides,
  };
}

function comp(drugId: number, pubchemCid: number | null = null): BasketComponent {
  return { drugId, pubchemCid, drugName: `Drug ${drugId}` };
}

function defined<T>(value: T | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}

describe('isConfirmatoryMethod', () => {
  it('accepts confirmatory and screening_confirmatory only', () => {
    expect(isConfirmatoryMethod(method({ methodType: 'confirmatory' }))).toBe(
      true,
    );
    expect(
      isConfirmatoryMethod(method({ methodType: 'screening_confirmatory' })),
    ).toBe(true);
    expect(isConfirmatoryMethod(method({ methodType: 'screening' }))).toBe(
      false,
    );
    expect(isConfirmatoryMethod(method({ methodType: null }))).toBe(false);
  });
});

describe('methodCoversComponent', () => {
  it('matches on drugId or pubchemCid', () => {
    const m = method({ drugIds: [10], pubchemCids: [555] });
    expect(methodCoversComponent(m, comp(10))).toBe(true);
    expect(methodCoversComponent(m, comp(99, 555))).toBe(true);
    expect(methodCoversComponent(m, comp(99, 1))).toBe(false);
  });
});

describe('suggestConfirmatoryMethods', () => {
  it('returns nothing for an empty basket', () => {
    const result = suggestConfirmatoryMethods([], [method({ drugIds: [1] })]);
    expect(result.matrices).toHaveLength(0);
    expect(result.globallyUncoverable).toHaveLength(0);
  });

  it('ignores screening-only methods', () => {
    const result = suggestConfirmatoryMethods(
      [comp(1)],
      [method({ drugIds: [1], methodType: 'screening' })],
    );
    expect(result.matrices).toHaveLength(0);
    expect(result.globallyUncoverable).toEqual([comp(1)]);
  });

  it('finds a single covering method', () => {
    const result = suggestConfirmatoryMethods(
      [comp(1), comp(2)],
      [method({ drugIds: [1, 2], volumeMl: 2 })],
    );
    expect(result.matrices).toHaveLength(1);
    const solutions = defined(result.matrices[0]).solutions;
    expect(solutions).toHaveLength(1);
    expect(solutions[0]).toMatchObject({ methodCount: 1, totalVolumeMl: 2 });
  });

  it('prefers fewer methods and exposes the volume tradeoff as Pareto options', () => {
    // One method covers everything but needs a big sample; two small methods
    // together cover the same with less total volume.
    const big = method({ code: 'BIG', drugIds: [1, 2], volumeMl: 10 });
    const a = method({ code: 'A', drugIds: [1], volumeMl: 2 });
    const b = method({ code: 'B', drugIds: [2], volumeMl: 3 });
    const result = suggestConfirmatoryMethods([comp(1), comp(2)], [big, a, b]);
    const solutions = defined(result.matrices[0]).solutions;
    // Both are non-dominated: 1 method @ 10 ml, and 2 methods @ 5 ml.
    expect(solutions).toHaveLength(2);
    expect(solutions[0]).toMatchObject({ methodCount: 1, totalVolumeMl: 10 });
    expect(solutions[1]).toMatchObject({ methodCount: 2, totalVolumeMl: 5 });
  });

  it('drops a dominated combination (more methods AND more volume)', () => {
    const big = method({ code: 'BIG', drugIds: [1, 2], volumeMl: 4 });
    const a = method({ code: 'A', drugIds: [1], volumeMl: 3 });
    const b = method({ code: 'B', drugIds: [2], volumeMl: 3 });
    const result = suggestConfirmatoryMethods([comp(1), comp(2)], [big, a, b]);
    const solutions = defined(result.matrices[0]).solutions;
    // The 2-method @ 6 ml combo is dominated by the 1-method @ 4 ml combo.
    expect(solutions).toHaveLength(1);
    expect(solutions[0]).toMatchObject({ methodCount: 1, totalVolumeMl: 4 });
  });

  it('solves independently per matrix and reports per-matrix uncoverable', () => {
    const blood = method({
      code: 'BLOOD',
      drugIds: [1, 2],
      matrices: ['blood'],
      volumeMl: 5,
    });
    const urine = method({
      code: 'URINE',
      drugIds: [1],
      matrices: ['urine'],
      volumeMl: 1,
    });
    const result = suggestConfirmatoryMethods([comp(1), comp(2)], [
      blood,
      urine,
    ]);
    const bloodMatrix = defined(
      result.matrices.find((m) => m.matrix === 'blood'),
    );
    const urineMatrix = defined(
      result.matrices.find((m) => m.matrix === 'urine'),
    );
    expect(defined(bloodMatrix.solutions[0]).methodCount).toBe(1);
    expect(bloodMatrix.uncoverableComponents).toHaveLength(0);
    // Urine only covers component 1; component 2 is uncoverable in urine.
    expect(urineMatrix.uncoverableComponents).toEqual([comp(2)]);
    // Component 2 is still globally coverable (via blood).
    expect(result.globallyUncoverable).toHaveLength(0);
  });

  it('flags components no confirmatory method covers anywhere', () => {
    const result = suggestConfirmatoryMethods(
      [comp(1), comp(2)],
      [method({ drugIds: [1] })],
    );
    expect(result.globallyUncoverable).toEqual([comp(2)]);
    expect(defined(result.matrices[0]).uncoverableComponents).toEqual([
      comp(2),
    ]);
  });

  it('marks unknown volume when a chosen method has no recorded volume', () => {
    const result = suggestConfirmatoryMethods(
      [comp(1)],
      [method({ drugIds: [1], volumeMl: null })],
    );
    const solution = defined(defined(result.matrices[0]).solutions[0]);
    expect(solution.hasUnknownVolume).toBe(true);
    expect(solution.totalVolumeMl).toBeNull();
  });
});
