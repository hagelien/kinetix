import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DrugPanel } from './DrugPanel';
import { useSimulatorStore } from '@/stores/simulatorStore';
import { useAppStore } from '@/stores/appStore';
import type { DrugComponent } from '@/types';
import type { DrugSimConfig } from '@/types/simulator';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

const component: DrugComponent = {
  id: 'ethanol',
  names: { en: 'Ethanol', nb: 'Etanol' },
  molecularWeight: 46.07,
};

const nonEthanolComponent: DrugComponent = {
  id: '123',
  names: { en: 'Diazepam', nb: 'Diazepam' },
  molecularWeight: 284.74,
};

function baseConfig(overrides: Partial<DrugSimConfig> = {}): DrugSimConfig {
  return {
    id: 'config-1',
    drugId: '702',
    drugName: 'Ethanol',
    label: 'Ethanol',
    events: [],
    route: 'oral',
    questionMode: 'later-from-earlier',
    inputs: {},
    overrides: {},
    display: { visible: true, color: '#2563eb' },
    ...overrides,
  };
}

function renderPanel(
  config: DrugSimConfig,
  drugComponent: DrugComponent = component,
) {
  useSimulatorStore.setState({
    drugs: [config],
    results: {},
    runningDrugIds: new Set(),
    isRunning: false,
  });

  return render(
    <DrugPanel
      config={config}
      drugComponent={drugComponent}
      timeFormat="hours"
      referenceTime="00:00"
    />,
  );
}

afterEach(() => {
  useSimulatorStore.setState({
    drugs: [],
    results: {},
    runningDrugIds: new Set(),
    isRunning: false,
  });
});

describe('DrugPanel engine controls', () => {
  it('persists the selected ethanol engine with default Widmark params', () => {
    renderPanel(baseConfig());

    fireEvent.change(
      screen.getByDisplayValue('simulator.engine.pkMonteCarlo'),
      { target: { value: 'ethanol-widmark' } },
    );

    const updated = useSimulatorStore.getState().drugs[0]!;
    expect(updated.engine).toBe('ethanol-widmark');
    expect(updated.ethanol).toMatchObject({
      weightKg: 70,
      biologicalSex: 'male',
      eliminationRateGdlPerHour: 0.015,
    });
  });

  it('persists the selected KineLab engine with default inference params', () => {
    renderPanel(baseConfig(), nonEthanolComponent);

    fireEvent.change(
      screen.getByDisplayValue('simulator.engine.pkMonteCarlo'),
      { target: { value: 'kinelab-bayes' } },
    );

    const updated = useSimulatorStore.getState().drugs[0]!;
    expect(updated.engine).toBe('kinelab-bayes');
    expect(updated.kinelab).toMatchObject({
      assayCV: 0.15,
      drawCount: 2000,
    });
  });

  it('defaults KineLab doses to a dose prior and intake window', () => {
    renderPanel(
      baseConfig({
        drugId: nonEthanolComponent.id,
        drugName: 'Diazepam',
        label: 'Diazepam',
        engine: 'kinelab-bayes',
        kinelab: { assayCV: 0.15, drawCount: 2000 },
      }),
      nonEthanolComponent,
    );

    expect(screen.getByText('simulator.engine.kinelabParams')).toBeTruthy();
    expect(
      screen.getByText('simulator.events.statusKinelabIncomplete'),
    ).toBeTruthy();

    fireEvent.click(screen.getByText('simulator.events.addDose'));

    const dose = useSimulatorStore.getState().drugs[0]!.events[0];
    expect(dose).toMatchObject({
      type: 'dose',
      unit: 'mg',
      route: 'oral',
      t: 0,
      amountRange: { min: 50, max: 500 },
      tRange: [0, 1],
    });
  });

  it('shows ethanol fields and defaults new doses to grams by oral route', () => {
    renderPanel(
      baseConfig({
        engine: 'ethanol-widmark',
        ethanol: {
          weightKg: 82,
          biologicalSex: 'female',
          eliminationRateGdlPerHour: 0.014,
        },
      }),
    );

    expect(screen.getByText('simulator.engine.ethanolParams')).toBeTruthy();
    expect(
      screen.getByText('simulator.events.statusEthanolIncomplete'),
    ).toBeTruthy();

    fireEvent.click(screen.getByText('simulator.events.addDose'));

    const dose = useSimulatorStore.getState().drugs[0]!.events[0];
    expect(dose).toMatchObject({
      type: 'dose',
      unit: 'g',
      route: 'oral',
      t: 0,
    });
  });

  it('hides the Widmark engine for non-ethanol components', () => {
    renderPanel(
      baseConfig({
        drugId: nonEthanolComponent.id,
        drugName: 'Diazepam',
        label: 'Diazepam',
        engine: 'ethanol-widmark',
      }),
      nonEthanolComponent,
    );

    const picker = screen.getByRole('combobox') as HTMLSelectElement;
    expect(picker.value).toBe('pk-montecarlo');
    expect(screen.queryByText('simulator.engine.ethanolWidmark')).toBeNull();
    expect(screen.getByText('simulator.engine.kinelabBayes')).toBeTruthy();
  });

  it('uses a parseable hours placeholder for prediction time in hours mode', () => {
    renderPanel(
      baseConfig({
        engine: 'pk-montecarlo',
        drugId: nonEthanolComponent.id,
        drugName: 'Diazepam',
        label: 'Diazepam',
        events: [{ id: 'q', type: 'query', t: 2, solveFor: 'concentration' }],
      }),
      nonEthanolComponent,
    );

    // The relative "+1:30" hint must not appear in hours mode, where the
    // numeric field cannot parse it and would silently reset the value.
    expect(
      screen.queryByPlaceholderText('simulator.events.relativeTimePlaceholder'),
    ).toBeNull();
    expect(
      screen.getAllByPlaceholderText('simulator.events.hoursPlaceholder').length,
    ).toBeGreaterThan(0);
  });

  it('scopes timeline selection by config, not just the shared event id', () => {
    const config = baseConfig({
      id: 'config-2',
      drugId: nonEthanolComponent.id,
      drugName: 'Diazepam',
      label: 'Diazepam',
      engine: 'kinelab-bayes',
      kinelab: { assayCV: 0.15, drawCount: 2000 },
      // KineLab builders reuse fixed event ids across configs.
      events: [
        {
          id: 'legacy-kinelab-dose',
          type: 'dose',
          t: 0,
          amount: 10,
          unit: 'mg',
          route: 'oral',
        },
      ],
    });
    useSimulatorStore.setState({
      drugs: [config],
      results: {},
      runningDrugIds: new Set(),
      isRunning: false,
    });

    const { container } = render(
      <DrugPanel
        config={config}
        drugComponent={nonEthanolComponent}
        timeFormat="hours"
        referenceTime="00:00"
        // A marker selected in a *different* config that shares the event id.
        selectedMarkerId="config-1:legacy-kinelab-dose"
      />,
    );

    const row = container.querySelector(
      '[data-event-id="legacy-kinelab-dose"]',
    );
    expect(row).not.toBeNull();
    expect(row?.className).not.toContain('ring-2');
  });

  it('reports unsupported ethanol dose-solving queries explicitly', () => {
    renderPanel(
      baseConfig({
        engine: 'ethanol-widmark',
        events: [
          { id: 'd', type: 'dose', t: 0, amount: 20, unit: 'g', route: 'oral' },
          { id: 'q', type: 'query', t: 2, solveFor: 'dose' },
        ],
      }),
    );

    expect(
      screen.getByText('simulator.events.statusEthanolDoseSolvingUnsupported'),
    ).toBeTruthy();
  });
});

describe('a new concentration event honours the unit preference', () => {
  // The "+ Legg til konsentrasjon" button used to seed a hardcoded mg/L, so a
  // user whose primary display unit is µmol/L got a field in the wrong unit
  // every single time.
  function addConcentrationTo(drugComponent: DrugComponent) {
    const config = baseConfig();
    renderPanel(config, drugComponent);
    fireEvent.click(screen.getByText('simulator.events.addConcentration'));
    const events = useSimulatorStore.getState().drugs[0]!.events;
    return events[events.length - 1]!;
  }

  it('starts in the primary unit when the drug can express it', () => {
    useAppStore.setState({ enabledUnits: ['µmol/L', 'mg/L'] });
    expect(addConcentrationTo(nonEthanolComponent)).toMatchObject({
      type: 'measurement',
      unit: 'µmol/L',
    });
  });

  it('falls back to mg/L when a molar unit cannot be converted', () => {
    useAppStore.setState({ enabledUnits: ['µmol/L', 'mg/L'] });
    const noMw: DrugComponent = {
      id: '999',
      names: { en: 'Unknown', nb: 'Ukjent' },
    } as DrugComponent;
    expect(addConcentrationTo(noMw)).toMatchObject({ unit: 'mg/L' });
  });

  it('follows a mass-unit preference too', () => {
    useAppStore.setState({ enabledUnits: ['ng/mL', 'mg/L'] });
    expect(addConcentrationTo(nonEthanolComponent)).toMatchObject({
      unit: 'ng/mL',
    });
  });
});

describe('DrugPanel advanced parameter overrides', () => {
  function openAdvanced(
    config: DrugSimConfig,
    drugComponent: DrugComponent = nonEthanolComponent,
  ) {
    renderPanel(config, drugComponent);
    fireEvent.click(screen.getByText('simulator.events.advanced'));
  }

  function inputFor(labelKey: string) {
    const label = screen.getByText(labelKey);
    return label.parentElement!.querySelector('input') as HTMLInputElement;
  }

  it('overrides half-life as a fixed distribution', () => {
    openAdvanced(
      baseConfig({
        drugId: nonEthanolComponent.id,
        drugName: 'Diazepam',
        label: 'Diazepam',
      }),
    );

    fireEvent.change(inputFor('simulator.events.halfLife'), {
      target: { value: '12' },
    });

    const { overrides } = useSimulatorStore.getState().drugs[0]!;
    expect(overrides.halfLife).toEqual({ type: 'fixed', value: 12 });
  });

  it('overrides Vd as a fixed distribution', () => {
    openAdvanced(
      baseConfig({
        drugId: nonEthanolComponent.id,
        drugName: 'Diazepam',
        label: 'Diazepam',
      }),
    );

    fireEvent.change(inputFor('simulator.events.volumeOfDistribution'), {
      target: { value: '80' },
    });

    const { overrides } = useSimulatorStore.getState().drugs[0]!;
    expect(overrides.vd).toEqual({ type: 'fixed', value: 80 });
  });

  it('overrides bioavailability as a fixed distribution', () => {
    openAdvanced(
      baseConfig({
        drugId: nonEthanolComponent.id,
        drugName: 'Diazepam',
        label: 'Diazepam',
      }),
    );

    fireEvent.change(inputFor('simulator.events.bioavailability'), {
      target: { value: '0.9' },
    });

    const { overrides } = useSimulatorStore.getState().drugs[0]!;
    expect(overrides.f).toEqual({ type: 'fixed', value: 0.9 });
  });

  it('clears an override back to the literature default when the field is emptied', () => {
    openAdvanced(
      baseConfig({
        drugId: nonEthanolComponent.id,
        drugName: 'Diazepam',
        label: 'Diazepam',
        overrides: { halfLife: { type: 'fixed', value: 12 } },
      }),
    );

    fireEvent.change(inputFor('simulator.events.halfLife'), {
      target: { value: '' },
    });

    expect(
      useSimulatorStore.getState().drugs[0]!.overrides.halfLife,
    ).toBeUndefined();
  });

  it('hides the PK parameter overrides for the ethanol and KineLab engines', () => {
    renderPanel(
      baseConfig({
        engine: 'ethanol-widmark',
        ethanol: {
          weightKg: 70,
          biologicalSex: 'male',
          eliminationRateGdlPerHour: 0.015,
        },
      }),
    );
    fireEvent.click(screen.getByText('simulator.events.advanced'));

    expect(screen.queryByText('simulator.events.halfLife')).toBeNull();
    expect(
      screen.queryByText('simulator.events.volumeOfDistribution'),
    ).toBeNull();
    expect(
      screen.queryByText('simulator.events.bioavailability'),
    ).toBeNull();
  });
});
