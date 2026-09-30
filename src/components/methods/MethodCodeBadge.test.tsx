import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { MethodCodeBadge } from './MethodCodeBadge';
import { MATRIX_COLORS, matrixBorderColor } from '@/lib/methodMeta';

describe('matrixBorderColor', () => {
  it('tints the border with the first matrix colour', () => {
    expect(matrixBorderColor(['blood'])).toBe(`${MATRIX_COLORS.blood}b3`);
    expect(matrixBorderColor(['saliva'])).toBe(`${MATRIX_COLORS.saliva}b3`);
  });

  it('returns no override when there are no matrices', () => {
    expect(matrixBorderColor([])).toBe('');
  });
});

describe('MethodCodeBadge', () => {
  it('renders the code', () => {
    const { getByText } = render(<MethodCodeBadge code="9005" matrices={['blood']} />);
    expect(getByText('9005')).toBeInTheDocument();
  });

  it('colour-codes a blood method with the blood gradient + border', () => {
    const { getByText } = render(<MethodCodeBadge code="9005" matrices={['blood']} />);
    const badge = getByText('9005');
    // single matrix → flat tint at the matrix colour (jsdom normalises the
    // hex+alpha tint to rgba: #dc2626 → rgb(220, 38, 38)).
    expect(badge.style.background).toContain('220, 38, 38');
    // border tints with the same colour at ~70% alpha (b3 → 0.7).
    expect(badge.style.borderColor).toContain('220, 38, 38');
  });

  it('colour-codes a saliva method differently from a blood method', () => {
    const { getByText: blood } = render(
      <MethodCodeBadge code="9001" matrices={['blood']} />,
    );
    const { getByText: saliva } = render(
      <MethodCodeBadge code="9006" matrices={['saliva']} />,
    );
    expect(blood('9001').style.borderColor).not.toBe(
      saliva('9006').style.borderColor,
    );
  });

  it('applies no inline colour when the method has no matrices', () => {
    const { getByText } = render(<MethodCodeBadge code="42" />);
    const badge = getByText('42');
    expect(badge.style.background).toBe('');
    expect(badge.style.borderColor).toBe('');
  });
});
