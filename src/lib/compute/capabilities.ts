import type { ComputeCapability } from './types';

export const LITE_CAPABILITIES: ComputeCapability[] = [
  'analytic-pk',
  'grid-inference',
  'browser-monte-carlo',
  'basic-scenario-comparison',
];

export const FULL_CAPABILITIES: ComputeCapability[] = [
  ...LITE_CAPABILITIES,
  'ode-solver',
  'hmc-nuts',
  'hierarchical-pop-pk',
  'postmortem-model',
  'model-averaging',
];
