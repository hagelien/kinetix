export interface EthanolIntake {
  id: string;
  /** Hour offset from reference time (t=0) */
  timeHour: number;
  /** Pure ethanol amount in grams */
  ethanolGrams: number;
}

export interface EthanolPersonParams {
  weightKg: number;
  biologicalSex: 'female' | 'male';
  /** Elimination slope in g/dL/hour. Typical: 0.015 */
  eliminationRateGdlPerHour: number;
  /** Optional Widmark distribution ratio override */
  distributionRatioOverride?: number;
}

export interface EthanolSimulationPoint {
  t: number;
  bacGdl: number;
}

export interface EthanolSimulationOutput {
  points: EthanolSimulationPoint[];
  peakBacGdl: number;
  peakTimeHour: number;
  bacAtReference: number;
}
