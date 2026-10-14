import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConcentrationText } from './ConcentrationText';

describe('ConcentrationText', () => {
  // Issue #249: the unit is canonicalised for conversion (`mg/l` → `mg/L`,
  // `ug/L` → `µg/L`), but the trigger must be found by the AUTHORED spelling —
  // otherwise the whole concentration becomes the trigger instead of its unit.
  it.each([
    { authored: '5 mg/l', unit: 'mg/l', converted: '16.7 µmol/L' },
    { authored: '5 ug/L', unit: 'ug/L', converted: '0.0167 µmol/L' },
  ])(
    'makes only the authored unit of "$authored" the trigger and converts it',
    ({ authored, unit, converted }) => {
      const { container } = render(
        <p>
          <ConcentrationText text={`Cut-off ${authored} in blood`} molecularWeight={300} />
        </p>,
      );

      const triggers = container.querySelectorAll('[tabindex]');
      expect(triggers).toHaveLength(1);
      const trigger = triggers[0] as HTMLElement;
      expect(trigger.textContent).toBe(unit);
      expect(trigger.className).toContain('cursor-help');
      // The figure sits beside the trigger, as written, not inside it.
      expect(trigger.parentElement?.textContent).toBe(authored);

      const tooltip = container.querySelector('[role="tooltip"]') as HTMLElement;
      expect(trigger.getAttribute('aria-describedby')).toBe(tooltip.id);
      expect(tooltip.textContent?.replace(/\s+/g, ' ')).toContain(converted);
    },
  );
});
