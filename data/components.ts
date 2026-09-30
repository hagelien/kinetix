interface RangeData {
  min?: number;
  max?: number;
  // Replaces the former standalone `value`; legacy single values are the
  // median. Mean is left for editors to fill in.
  mean?: number;
  median?: number;
  unit?: string;
  // Comparison operator for one-sided bounds only — not a free-text label.
  qualifier?: '<' | '>' | '≤' | '≥';
  note?: string;
}

export interface RawComponent {
  name: string;
  nameEn?: string;
  pubchemCid: number;
  molecularWeight?: number;
  bioavailability?: RangeData;
  volumeOfDistribution?: RangeData;
  bloodPlasmaRatio?: RangeData;
  tmax?: RangeData;
  pKa?: RangeData;
  halfLife?: RangeData;
  proteinBinding?: RangeData;
  metabolism?: {
    enzymes?: string[];
    metabolites?: string[];
    eliminationRoutes?: string[];
  };
  therapeuticRange?: RangeData;
  toxicRange?: RangeData;
  lethalRange?: RangeData;
}

export const embeddedComponents: RawComponent[] = [
  {
    name: '3-klormetkatinon',
    nameEn: '3-Chloromethcathinone (3-CMC)',
    pubchemCid: 50999285,
    molecularWeight: 197.66,
    metabolism: {
      enzymes: [],
      metabolites: ['Doxorubicinol aglycone', '7d-Aon', 'Doxorubicin aglycone', 'Epirubicin glucuronide', 'Epidoxorubicinol, 4\'-epiadriamycinol', 'Epirubicinol glucuronide', '7d-Aolon', 'Metabolite M4', 'Metabolite M2', 'Metabolite M5', 'Metabolite M6'],
      eliminationRoutes: []
    }
  },
  {
    name: '6-monoacetylmorfin',
    nameEn: '6-Monoacetylmorphine (6-MAM)',
    pubchemCid: 5462507,
    molecularWeight: 327.4,
    halfLife: { min: 0.1, max: 0.7, unit: 'h', note: 'rapidly metabolized to morphine; DrugBank' },
    metabolism: {
      enzymes: [],
      metabolites: ['Doxorubicinol aglycone', '7d-Aon', 'Doxorubicin aglycone', 'Epirubicin glucuronide', 'Epidoxorubicinol, 4\'-epiadriamycinol', 'Epirubicinol glucuronide', '7d-Aolon', 'Metabolite M4', 'Metabolite M2', 'Metabolite M5', 'Metabolite M6'],
      eliminationRoutes: []
    }
  },
  {
    name: 'Alimemazin',
    nameEn: 'Alimemazine (Trimeprazine)',
    pubchemCid: 5574,
    molecularWeight: 298.4,
    halfLife: { min: 5, max: 8, unit: 'h', note: 'Hu et al. 1990' },
    metabolism: {
      enzymes: [],
      metabolites: ['Doxorubicinol aglycone', '7d-Aon', 'Doxorubicin aglycone', 'Epirubicin glucuronide', 'Epidoxorubicinol, 4\'-epiadriamycinol', 'Epirubicinol glucuronide', '7d-Aolon', 'Metabolite M4', 'Metabolite M2', 'Metabolite M5', 'Metabolite M6'],
      eliminationRoutes: []
    }
  },
  {
    name: 'Alprazolam',
    nameEn: 'Alprazolam',
    pubchemCid: 2118,
    molecularWeight: 308.8,
    halfLife: { min: 9, max: 16, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { min: 0.8, max: 1.3, unit: 'L/kg', note: 'auto-extracted' },
    bioavailability: { min: 0.88, max: 0.88, median: 0.88, unit: 'fraction' },
    proteinBinding: { median: 0.8, unit: 'fraction', note: 'auto-extracted' },
    bloodPlasmaRatio: { median: 0.6, note: 'benzodiazepine; ~70% protein binding' },
    metabolism: {
      enzymes: ['CYP3A4', 'CYP3A5', 'CYP3A7', 'CYP2C9'],
      metabolites: ['later excreted in urine as glucuronides', 'excreted primarily in the urine', 'less effective metabolites by various CYPs including CYP3A4'],
      eliminationRoutes: ['Renal']
    },
    lethalRange: { median: 1020, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Amfetamin',
    nameEn: 'Amphetamine',
    pubchemCid: 3007,
    molecularWeight: 135.21,
    halfLife: { min: 9, max: 11, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { median: 4, unit: 'L/kg', note: 'auto-extracted' },
    bioavailability: { median: 0.75, unit: 'fraction', note: 'auto-extracted' },
    proteinBinding: { median: 0.2, unit: 'fraction', note: 'auto-extracted' },
    bloodPlasmaRatio: { median: 1, note: 'low protein binding 20%; B/P ~1.0 in vivo' },
    metabolism: { enzymes: ['CYP2D6'], metabolites: [], eliminationRoutes: [] },
    toxicRange: { median: 10, unit: 'mg/kg', note: 'auto-extracted from PubChem' },
    lethalRange: { median: 180, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: '2C-B',
    nameEn: '2C-B (4-bromo-2,5-dimethoxyphenethylamine)',
    pubchemCid: 62065,
    molecularWeight: 260.16,
    halfLife: { min: 2, max: 4, median: 3, unit: 'h', note: 'limited human data; kinetics-core harmonization baseline uses 3.0 h' },
    metabolism: { enzymes: ['MAO', 'CYP2D6'], metabolites: [], eliminationRoutes: [] }
  },
  {
    name: 'Benzoylecgonin',
    nameEn: 'Benzoylecgonine',
    pubchemCid: 448223,
    molecularWeight: 289.33,
    halfLife: { min: 5, max: 12, unit: 'h', note: 'cocaine metabolite; PMC5573903' },
    metabolism: {
      enzymes: [],
      metabolites: ['Doxorubicinol aglycone', '7d-Aon', 'Doxorubicin aglycone', 'Epirubicin glucuronide', 'Epidoxorubicinol, 4\'-epiadriamycinol', 'Epirubicinol glucuronide', '7d-Aolon', 'Metabolite M4', 'Metabolite M2', 'Metabolite M5', 'Metabolite M6'],
      eliminationRoutes: []
    }
  },
  {
    name: 'Betahydroksybutyrat',
    nameEn: 'Beta-hydroxybutyrate (3-hydroxybutyric acid)',
    pubchemCid: 441,
    molecularWeight: 104.1,
    metabolism: {
      enzymes: [],
      metabolites: ['Doxorubicinol aglycone', '7d-Aon', 'Doxorubicin aglycone', 'Epirubicin glucuronide', 'Epidoxorubicinol, 4\'-epiadriamycinol', 'Epirubicinol glucuronide', '7d-Aolon', 'Metabolite M4', 'Metabolite M2', 'Metabolite M5', 'Metabolite M6'],
      eliminationRoutes: []
    }
  },
  {
    name: 'Bromazepam',
    nameEn: 'Bromazepam',
    pubchemCid: 2441,
    molecularWeight: 316.15,
    halfLife: { min: 12, max: 30, unit: 'h', note: 'DrugBank DB01558; Jochemsen 1983' },
    volumeOfDistribution: { min: 0.9, max: 1.4, unit: 'L/kg', note: 'Jochemsen 1983' },
    bioavailability: { min: 0.84, max: 0.84, median: 0.84, unit: 'fraction' },
    metabolism: { enzymes: [], metabolites: [], eliminationRoutes: ['Renal (69%)'] }
  },
  {
    name: 'Bromazolam',
    nameEn: 'Bromazolam',
    pubchemCid: 12562546,
    molecularWeight: 353.2
  },
  {
    name: 'buprenorfin',
    nameEn: 'buprenorphine',
    pubchemCid: 644073,
    molecularWeight: 467.6,
    halfLife: { min: 27.6, max: 27.6, median: 27.6, unit: 'h' },
    volumeOfDistribution: { min: 1.437, max: 2.782, median: 2.1095, unit: 'L/kg' },
    bioavailability: {
      min: 0.46,
      max: 0.65,
      median: 0.28,
      unit: 'fraction',
      note: 'Absolute bioavailability reported for buccal buprenorphine film (BELBUCA); bioavailability is formulation/route dependent.'
    },
    proteinBinding: { min: 0.96, max: 0.96, median: 0.96, unit: 'fraction' },
    bloodPlasmaRatio: { min: 1, max: 1, median: 1, unit: 'ratio' },
    metabolism: {
      enzymes: ['CYP3A4', 'UGT (glucuronidation; isoforms not specified in label)'],
      metabolites: ['Norbuprenorphine', 'Other/unidentified buprenorphine metabolites', 'Unchanged buprenorphine'],
      eliminationRoutes: ['Renal', 'Feces']
    }
  },
  {
    name: 'Koffein',
    nameEn: 'Caffeine',
    pubchemCid: 2519,
    molecularWeight: 194.19,
    halfLife: { min: 3, max: 7, median: 5, unit: 'h' },
    volumeOfDistribution: { min: 0.6, max: 0.6, median: 0.6, unit: 'L/kg' },
    bioavailability: { min: 1, max: 1, median: 0.98, unit: 'fraction', note: '~' },
    proteinBinding: { min: 0.1, max: 0.35, median: 0.225, unit: 'fraction' },
    bloodPlasmaRatio: { min: 0.8, max: 0.8, median: 0.8, unit: 'ratio' },
    metabolism: {
      enzymes: ['CYP1A2'],
      metabolites: ['Paraxanthine', 'theobromine', 'theophylline'],
      eliminationRoutes: ['Renal (metabolites)']
    },
    lethalRange: { median: 200, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Desalkylgidazepam',
    nameEn: 'Desalkylgidazepam',
    pubchemCid: 76167,
    molecularWeight: 315.16
  },
  {
    name: 'Diazepam',
    nameEn: 'Diazepam',
    pubchemCid: 3016,
    molecularWeight: 284.74,
    halfLife: { min: 48, max: 120, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { min: 0.8, max: 1, unit: 'L/kg', note: 'auto-extracted' },
    bioavailability: { min: 0.99, max: 0.99, median: 0.99, unit: 'fraction' },
    bloodPlasmaRatio: { min: 0.51, max: 0.59, note: 'Manchester 2022, PMC9715504' },
    metabolism: {
      enzymes: ['CYP3A4', 'CYP2C19', 'CYP2D1'],
      metabolites: ['excreted mainly in the urine', 'predominantly as their glucuronide conjugates', 'oxazepam'],
      eliminationRoutes: ['Renal']
    },
    lethalRange: { median: 1200, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Dimetyltryptamin (DMT)',
    nameEn: 'N,N-Dimethyltryptamine (DMT)',
    pubchemCid: 6089,
    molecularWeight: 188.27,
    halfLife: { min: 0.08, max: 0.32, unit: 'h', note: 'Heijden 2025; IV t1/2alpha 5-6 min, t1/2beta 14-19 min' },
    volumeOfDistribution: { min: 36, max: 55, unit: 'L/kg', note: 'PMC10122081' },
    metabolism: {
      enzymes: ['MAO-A'],
      metabolites: ['DMT-N-oxide', 'Indole-3-acetic acid'],
      eliminationRoutes: ['Renal']
    },
    lethalRange: { median: 32, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Doksylamin',
    nameEn: 'Doxylamine',
    pubchemCid: 3162,
    molecularWeight: 270.37,
    halfLife: { median: 10, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { median: 2.5, unit: 'L/kg', note: 'StatPearls NBK551646' },
    bioavailability: { min: 0.247, max: 0.247, median: 0.247, unit: 'fraction' },
    bloodPlasmaRatio: { median: 1, note: 'estimated; clinical references' },
    metabolism: {
      enzymes: [],
      metabolites: ['Doxorubicinol aglycone', '7d-Aon', 'Doxorubicin aglycone', 'Epirubicin glucuronide', 'Epidoxorubicinol, 4\'-epiadriamycinol', 'Epirubicinol glucuronide', '7d-Aolon', 'Metabolite M4', 'Metabolite M2', 'Metabolite M5', 'Metabolite M6'],
      eliminationRoutes: []
    }
  },
  {
    name: 'Etizolam',
    nameEn: 'Etizolam',
    pubchemCid: 3307,
    molecularWeight: 342.8,
    halfLife: { median: 8.2, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { min: 0.7, max: 1.1, unit: 'L/kg', note: 'PubMed 2065698' },
    bioavailability: { median: 0.93, unit: 'fraction', note: 'auto-extracted' },
    bloodPlasmaRatio: { median: 0.7, note: 'Manchester 2022, PMC9715504' },
    metabolism: { enzymes: ['CYP3A4', 'CYP2C18', 'CYP2C19'], metabolites: [], eliminationRoutes: [] }
  },
  {
    name: 'Etylmorfin',
    nameEn: 'Ethylmorphine',
    pubchemCid: 5359271,
    molecularWeight: 313.4,
    halfLife: { median: 2, unit: 'h', note: 'Aasmundstad 1995, Br J Clin Pharmacol' },
    metabolism: { enzymes: ['CYP2D6'], metabolites: [], eliminationRoutes: [] }
  },
  {
    name: 'Fenobarbital',
    nameEn: 'Phenobarbital',
    pubchemCid: 4763,
    molecularWeight: 232.24,
    halfLife: { median: 118, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { min: 0.5, max: 1, unit: 'L/kg', note: 'PubMed 7068937' },
    bioavailability: { min: 0.99, max: 0.99, median: 0.99, unit: 'fraction' },
    bloodPlasmaRatio: { median: 1, note: 'moderate protein binding 45-60%' },
    metabolism: { enzymes: ['CYP2C19'], metabolites: [], eliminationRoutes: [] },
    lethalRange: { median: 14, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Fenazepam',
    nameEn: 'Phenazepam',
    pubchemCid: 40113,
    molecularWeight: 349.61,
    halfLife: { min: 60, max: 300, unit: 'h', note: 'DEA Drug Info; mean 140h' },
    volumeOfDistribution: { min: 1, max: 2.2, unit: 'L/kg', note: 'Manchester 2022' },
    bloodPlasmaRatio: { median: 0.57, note: 'Manchester 2022, PMC9715504' },
    metabolism: {
      enzymes: [],
      metabolites: ['Doxorubicinol aglycone', '7d-Aon', 'Doxorubicin aglycone', 'Epirubicin glucuronide', 'Epidoxorubicinol, 4\'-epiadriamycinol', 'Epirubicinol glucuronide', '7d-Aolon', 'Metabolite M4', 'Metabolite M2', 'Metabolite M5', 'Metabolite M6'],
      eliminationRoutes: []
    }
  },
  {
    name: 'Fenytoin',
    nameEn: 'Phenytoin',
    pubchemCid: 1775,
    molecularWeight: 252.27,
    halfLife: { min: 7, max: 42, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { median: 0.75, unit: 'L/kg', note: 'auto-extracted' },
    bioavailability: { min: 0.9, max: 0.9, median: 0.9, unit: 'fraction' },
    proteinBinding: { median: 0.9, unit: 'fraction', note: 'auto-extracted' },
    bloodPlasmaRatio: { median: 0.58, note: 'high protein binding ~90%; Baselt' },
    metabolism: {
      enzymes: ['CYP2C9', 'CYP2C19', 'CYP1A2', 'CYP2A6', 'CYP2C8', 'CYP2D6', 'CYP2E1', 'CYP3A4', 'CYP3A5', 'CYP3A7', 'CYP2B6', 'CYP2C18', 'UGT1A6', 'UGT1A9', 'UGT1A1', 'UGT1A4'],
      metabolites: ['formed by CYP2C9', 'CYP2C19: _(R)-p-HPPH_', '_(S)-p-HPPH_', '5-(4\'-hydroxyphenyl)-5-phenylhydantoin (p-HPPH)'],
      eliminationRoutes: ['Renal']
    },
    lethalRange: { median: 1635, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Fentanyl',
    nameEn: 'Fentanyl',
    pubchemCid: 3345,
    molecularWeight: 336.5,
    halfLife: { min: 5, max: 12, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { min: 3, max: 8, unit: 'L/kg', note: 'auto-extracted' },
    bioavailability: { min: 0.01, max: 0.01, median: 0.01, unit: 'fraction' },
    proteinBinding: { min: 0.8, max: 0.85, unit: 'fraction', note: 'auto-extracted' },
    bloodPlasmaRatio: { median: 2, note: 'auto-extracted from PubChem' },
    metabolism: {
      enzymes: [],
      metabolites: ['a number of inactive metabolites'],
      eliminationRoutes: ['Renal (1%)', 'Fecal']
    },
    toxicRange: { median: 2.7, unit: 'ng/mL', note: 'auto-extracted from PubChem' },
    lethalRange: { median: 3.1, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Flualprazolam',
    nameEn: 'Flualprazolam',
    pubchemCid: 10359044,
    molecularWeight: 326.8
  },
  {
    name: 'Flubromazepam',
    nameEn: 'Flubromazepam',
    pubchemCid: 12947024,
    molecularWeight: 333.15
  },
  {
    name: 'Flubromazolam',
    nameEn: 'Flubromazolam',
    pubchemCid: 21930924,
    molecularWeight: 371.2
  },
  {
    name: 'Flunitrazepam',
    nameEn: 'Flunitrazepam',
    pubchemCid: 3380,
    molecularWeight: 313.28,
    halfLife: { median: 35, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { min: 3.4, max: 4.8, unit: 'L/kg', note: 'PubMed 29954' },
    bioavailability: { min: 0.8, max: 0.8, median: 0.8, unit: 'fraction' },
    bloodPlasmaRatio: { median: 0.6, note: 'estimated from protein binding ~78%' },
    metabolism: { enzymes: ['CYP2C19', 'CYP3A4', 'CYP1A2'], metabolites: [], eliminationRoutes: [] },
    lethalRange: { median: 415, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Gabapentin',
    nameEn: 'Gabapentin',
    pubchemCid: 3446,
    molecularWeight: 171.24,
    halfLife: { min: 2, max: 4, unit: 'h', note: 'auto-extracted' },
    bioavailability: { min: 0.6, max: 0.6, median: 0.6, unit: 'fraction' },
    bloodPlasmaRatio: { median: 1, note: 'negligible protein binding <3%' },
    metabolism: { enzymes: [], metabolites: [], eliminationRoutes: ['Renal'] },
    toxicRange: { median: 500, unit: 'mg/kg', note: 'auto-extracted from PubChem' },
    lethalRange: { median: 8000, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Gammahydroksybutyrat',
    nameEn: 'Gamma-hydroxybutyrate (GHB)',
    pubchemCid: 10413,
    molecularWeight: 104.1,
    halfLife: { median: 0.36666666666666664, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { min: 0.4, max: 0.8, unit: 'L/kg', note: 'PubMed 15538955' },
    bioavailability: { median: 0.25, unit: 'fraction', note: 'auto-extracted' },
    bloodPlasmaRatio: { median: 0.87, note: 'water-soluble, no protein binding; PMC8098080' },
    metabolism: { enzymes: [], metabolites: ['carbon dioxide and water'], eliminationRoutes: ['Renal', 'Fecal'] },
    lethalRange: { median: 2000, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Heksahydrocannabinol',
    nameEn: 'Hexahydrocannabinol (HHC)',
    pubchemCid: 16050328,
    molecularWeight: 316.5,
    metabolism: {
      enzymes: [],
      metabolites: ['Doxorubicinol aglycone', '7d-Aon', 'Doxorubicin aglycone', 'Epirubicin glucuronide', 'Epidoxorubicinol, 4\'-epiadriamycinol', 'Epirubicinol glucuronide', '7d-Aolon', 'Metabolite M4', 'Metabolite M2', 'Metabolite M5', 'Metabolite M6'],
      eliminationRoutes: []
    }
  },
  {
    name: 'Hydroksyzin',
    nameEn: 'Hydroxyzine',
    pubchemCid: 3658,
    molecularWeight: 374.9,
    halfLife: { min: 14, max: 25, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { min: 7, max: 23, unit: 'L/kg', note: 'PubMed 2562944' },
    bioavailability: { min: 0.8, max: 0.8, median: 0.8, unit: 'fraction' },
    bloodPlasmaRatio: { median: 1, note: 'estimated; clinical references' },
    metabolism: {
      enzymes: ['CYP3A4', 'CYP3A5'],
      metabolites: ['excreted in feces via biliary elimination'],
      eliminationRoutes: ['Fecal']
    },
    lethalRange: { median: 840, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Isotonitazen',
    nameEn: 'Isotonitazene',
    pubchemCid: 145721979,
    molecularWeight: 410.5
  },
  {
    name: 'Karfentanil',
    nameEn: 'Carfentanil',
    pubchemCid: 62156,
    molecularWeight: 394.5,
    halfLife: { min: 0.7, max: 5.7, unit: 'h', note: 'Springer s12630-019-01294-y' },
    metabolism: {
      enzymes: [],
      metabolites: ['Doxorubicinol aglycone', '7d-Aon', 'Doxorubicin aglycone', 'Epirubicin glucuronide', 'Epidoxorubicinol, 4\'-epiadriamycinol', 'Epirubicinol glucuronide', '7d-Aolon', 'Metabolite M4', 'Metabolite M2', 'Metabolite M5', 'Metabolite M6'],
      eliminationRoutes: []
    }
  },
  {
    name: 'Ketamin',
    nameEn: 'Ketamine',
    pubchemCid: 3821,
    molecularWeight: 237.72,
    halfLife: { min: 0.16666666666666666, max: 0.25, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { min: 2.3, max: 5, unit: 'L/kg', note: 'PMC6493357' },
    bioavailability: { min: 0.2, max: 0.2, median: 0.2, unit: 'fraction' },
    proteinBinding: { median: 0.535, unit: 'fraction', note: 'auto-extracted' },
    bloodPlasmaRatio: { median: 1, note: 'low protein binding 12%; freely distributes' },
    metabolism: { enzymes: [], metabolites: ['norketamine'], eliminationRoutes: ['Renal'] },
    lethalRange: { median: 400, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Klobazam',
    nameEn: 'Clobazam',
    pubchemCid: 2789,
    molecularWeight: 300.74,
    halfLife: { min: 36, max: 42, unit: 'h', note: 'auto-extracted' },
    bioavailability: { min: 0.9, max: 0.9, median: 0.9, unit: 'fraction' },
    proteinBinding: { min: 0.8, max: 0.9, unit: 'fraction', note: 'auto-extracted' },
    bloodPlasmaRatio: { median: 0.7, note: 'protein binding 80-90%; benzodiazepine class' },
    metabolism: {
      enzymes: ['CYP3A4', 'CYP2C19', 'CYP2B6', 'CYP2C18'],
      metabolites: [],
      eliminationRoutes: ['Renal (1%)', 'Fecal (82%)']
    },
    lethalRange: { median: 109, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Cannabidiol',
    nameEn: 'Cannabidiol',
    pubchemCid: 644019,
    molecularWeight: 314.5,
    halfLife: { median: 1.44, unit: 'h', note: 'auto-extracted' },
    proteinBinding: { median: 0.94, unit: 'fraction', note: 'auto-extracted from OpenFDA' },
    metabolism: {
      enzymes: ['CYP2C9', 'CYP2C19', 'CYP2D6', 'CYP3A4'],
      metabolites: [],
      eliminationRoutes: ['Renal', 'Fecal']
    }
  },
  {
    name: 'Delta-8-Tetrahydrocannabinol',
    nameEn: 'Delta-8-Tetrahydrocannabinol',
    pubchemCid: 638026,
    molecularWeight: 314.5,
    halfLife: { min: 24, max: 36, unit: 'h', note: 'estimated; similar to delta-9-THC' },
    metabolism: {
      enzymes: [],
      metabolites: ['Doxorubicinol aglycone', '7d-Aon', 'Doxorubicin aglycone', 'Epirubicin glucuronide', 'Epidoxorubicinol, 4\'-epiadriamycinol', 'Epirubicinol glucuronide', '7d-Aolon', 'Metabolite M4', 'Metabolite M2', 'Metabolite M5', 'Metabolite M6'],
      eliminationRoutes: []
    }
  },
  {
    name: 'Aceton',
    nameEn: 'Acetone',
    pubchemCid: 180,
    molecularWeight: 58.08,
    halfLife: { min: 3, max: 5, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { median: 0.6, unit: 'L/kg', note: 'distributes in body water; clinical toxicology' },
    proteinBinding: { median: 0.025, unit: 'fraction', note: 'from Wikidata' },
    bloodPlasmaRatio: { min: 0.84, max: 0.92, note: 'water-soluble; similar to small alcohols' },
    metabolism: {
      enzymes: ['CYP2E1'],
      metabolites: ['several bioactive substances that could play a role'],
      eliminationRoutes: ['Renal']
    },
    toxicRange: { min: 200, max: 300, unit: 'ug/mL', note: 'auto-extracted' },
    lethalRange: { median: -7138, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Etanol',
    nameEn: 'Ethanol',
    pubchemCid: 702,
    molecularWeight: 46.07,
    halfLife: { median: 0.25, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { min: 0.53, max: 0.6, unit: 'L/kg', note: 'total body water; Springer BF00280133' },
    proteinBinding: { median: 0.033, unit: 'fraction', note: 'from Wikidata' },
    bloodPlasmaRatio: { min: 0.84, max: 0.92, note: 'Jones 2023, PubMed 36317846' },
    metabolism: {
      enzymes: ['CYP2E1'],
      metabolites: ['acetaldehyde', 'acetaldehyde by three enzymes: 1'],
      eliminationRoutes: ['Renal', 'Pulmonary']
    },
    lethalRange: { median: 5628, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Isopropanol',
    nameEn: 'Isopropanol',
    pubchemCid: 3776,
    molecularWeight: 60.1,
    halfLife: { min: 2.5, max: 3.2, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { median: 0.6, unit: 'L/kg', note: 'total body water distribution' },
    proteinBinding: { median: 0.02, unit: 'fraction', note: 'from Wikidata' },
    bloodPlasmaRatio: { min: 0.84, max: 0.92, note: 'water-soluble alcohol; B/P similar to ethanol' },
    metabolism: { enzymes: [], metabolites: ['acetate', 'acetone'], eliminationRoutes: ['Renal', 'Pulmonary'] },
    toxicRange: { median: 150, unit: 'mg/l', note: 'auto-extracted from PubChem' },
    lethalRange: { median: 300, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Metanol',
    nameEn: 'Methanol',
    pubchemCid: 887,
    molecularWeight: 32.042,
    halfLife: { min: 2.5, max: 3, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { min: 0.6, max: 0.7, unit: 'L/kg', note: 'total body water distribution' },
    proteinBinding: { median: 0.06, unit: 'fraction', note: 'from Wikidata' },
    bloodPlasmaRatio: { min: 0.84, max: 0.92, note: 'water-soluble alcohol; B/P similar to ethanol' },
    metabolism: {
      enzymes: [],
      metabolites: ['formaldehyde by alcohol dehydrogenase'],
      eliminationRoutes: ['Renal', 'Pulmonary']
    },
    lethalRange: { median: 5628, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Deksamfetamin',
    nameEn: 'Dextroamphetamine',
    pubchemCid: 5826,
    molecularWeight: 135.21,
    halfLife: { median: 16, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { median: 4, unit: 'L/kg', note: 'FDA label' },
    bloodPlasmaRatio: { median: 1, note: 'low protein binding; same as racemic amphetamine' },
    metabolism: { enzymes: ['CYP2D6', 'CYP1A2'], metabolites: [], eliminationRoutes: ['Renal'] },
    lethalRange: { median: 96.8, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Levoamfetamine',
    nameEn: 'Levamphetamine',
    pubchemCid: 32893,
    molecularWeight: 135.21,
    halfLife: { min: 11, max: 14, unit: 'h', note: 'FDA Adderall label' },
    metabolism: {
      enzymes: [],
      metabolites: ['Doxorubicinol aglycone', '7d-Aon', 'Doxorubicin aglycone', 'Epirubicin glucuronide', 'Epidoxorubicinol, 4\'-epiadriamycinol', 'Epirubicinol glucuronide', '7d-Aolon', 'Metabolite M4', 'Metabolite M2', 'Metabolite M5', 'Metabolite M6'],
      eliminationRoutes: []
    }
  },
  {
    name: 'Fensyklidin',
    nameEn: 'Phencyclidine',
    pubchemCid: 6468,
    molecularWeight: 243.4,
    halfLife: { min: 7, max: 26, unit: 'h', note: 'auto-extracted from PubChem' },
    volumeOfDistribution: { median: 6.2, unit: 'L/kg', note: 'PubMed 7075111' },
    bloodPlasmaRatio: { median: 1, note: 'PubMed 7075111' },
    metabolism: { enzymes: [], metabolites: [], eliminationRoutes: ['Renal'] },
    lethalRange: { median: 76.5, unit: 'mg/kg', note: 'LD50 - auto-extracted from PubChem' }
  },
  {
    name: 'Remifentanil',
    nameEn: 'Remifentanil',
    pubchemCid: 60815,
    molecularWeight: 376.4,
    halfLife: { min: 0.16666666666666666, max: 0.3333333333333333, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { median: 7.6, unit: 'L/kg', note: 'auto-extracted' },
    proteinBinding: { median: 0.7, unit: 'fraction', note: 'auto-extracted from OpenFDA' },
    bloodPlasmaRatio: { median: 0.87, note: 'rapidly cleaved by esterases; clinical PK' },
    metabolism: { enzymes: [], metabolites: [], eliminationRoutes: ['Pulmonary'] },
    toxicRange: { median: 308, unit: 'ug/mL', note: 'auto-extracted from PubChem' }
  },
  {
    name: 'Sufentanil',
    nameEn: 'Sufentanil',
    pubchemCid: 41693,
    molecularWeight: 386.6,
    halfLife: { min: 0.012, max: 0.02, unit: 'h', note: 'auto-extracted' },
    bioavailability: { median: 0.52, unit: 'fraction', note: 'auto-extracted' },
    bloodPlasmaRatio: { median: 0.76, note: 'very high protein binding ~93%' },
    metabolism: { enzymes: [], metabolites: ['a number of inactive metabolites'], eliminationRoutes: [] },
    lethalRange: { median: 18.7, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Klometiazol',
    nameEn: 'Clomethiazole',
    pubchemCid: 10783,
    molecularWeight: 161.65,
    halfLife: { min: 3.6, max: 5, unit: 'h', note: 'Jostell 1978; PMC1874494' },
    volumeOfDistribution: { min: 1.1, max: 4.7, unit: 'L/kg', note: 'PMC1874494' },
    bioavailability: { min: 0.25, max: 0.25, median: 0.25, unit: 'fraction' },
    metabolism: {
      enzymes: [],
      metabolites: ['Doxorubicinol aglycone', '7d-Aon', 'Doxorubicin aglycone', 'Epirubicin glucuronide', 'Epidoxorubicinol, 4\'-epiadriamycinol', 'Epirubicinol glucuronide', '7d-Aolon', 'Metabolite M4', 'Metabolite M2', 'Metabolite M5', 'Metabolite M6'],
      eliminationRoutes: []
    }
  },
  {
    name: 'Klonazepam',
    nameEn: 'Clonazepam',
    pubchemCid: 2802,
    molecularWeight: 315.71,
    halfLife: { min: 30, max: 40, unit: 'h', note: 'auto-extracted from OpenFDA' },
    volumeOfDistribution: { median: 3, unit: 'L/kg', note: 'auto-extracted' },
    bioavailability: { min: 0.98, max: 0.98, median: 0.98, unit: 'fraction' },
    proteinBinding: { min: 0.82, max: 0.86, unit: 'fraction', note: 'auto-extracted' },
    bloodPlasmaRatio: { median: 0.65, note: 'Manchester 2022, PMC9715504' },
    metabolism: {
      enzymes: ['CYP3A5', 'CYP3A4'],
      metabolites: ['excreted in urine by first-order kinetics', 'principally as their glucuronide and/or sulfate conjugates'],
      eliminationRoutes: ['Renal']
    },
    therapeuticRange: { min: 0.02, max: 0.08, unit: 'mcg/mL', note: 'auto-extracted' },
    lethalRange: { median: 15000, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Kodein',
    nameEn: 'Codeine',
    pubchemCid: 5284371,
    molecularWeight: 299.4,
    halfLife: { min: 2.5, max: 3.5, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { min: 3, max: 6, unit: 'L/kg', note: 'auto-extracted' },
    bioavailability: { min: 0.5, max: 0.5, median: 0.5, unit: 'fraction' },
    proteinBinding: { min: 0.07, max: 0.25, unit: 'fraction', note: 'auto-extracted' },
    bloodPlasmaRatio: { median: 1, note: 'low protein binding 7-25%; Baselt' },
    metabolism: {
      enzymes: ['CYP2D6', 'CYP2B6', 'CYP3A4', 'UGT2B7', 'UGT2B4'],
      metabolites: [],
      eliminationRoutes: ['Renal']
    },
    toxicRange: { median: 50, unit: 'mg/kg', note: 'auto-extracted from PubChem' },
    lethalRange: { median: 427, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Kokain',
    nameEn: 'Cocaine',
    pubchemCid: 446220,
    molecularWeight: 303.35,
    halfLife: { min: 0.5, max: 1.5, unit: 'h', note: 'auto-extracted' },
    bioavailability: { min: 0.57, max: 0.57, median: 0.57, unit: 'fraction' },
    proteinBinding: { min: 0.84, max: 0.92, unit: 'fraction', note: 'auto-extracted from OpenFDA' },
    bloodPlasmaRatio: { median: 0.76, note: 'Menzies 2019, PubMed 31150569' },
    metabolism: {
      enzymes: [],
      metabolites: ['therefore benzoylecgonine', 'ecgonine methyl ester', 'ecgonine itself', 'which are inactive;', 'norcocaine which is active', 'may be relevant after acute intoxication', 'benzoylecgonine and ecgonine methyl ester', 'EME'],
      eliminationRoutes: ['Renal']
    },
    toxicRange: { median: 10, unit: 'mg/L', note: 'auto-extracted from PubChem' },
    lethalRange: { median: 95.1, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Lorazepam',
    nameEn: 'Lorazepam',
    pubchemCid: 3958,
    molecularWeight: 321.2,
    halfLife: { median: 14, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { median: 1.3, unit: 'L/kg', note: 'auto-extracted' },
    bioavailability: { min: 0.93, max: 0.93, median: 0.93, unit: 'fraction' },
    proteinBinding: { median: 0.85, unit: 'fraction', note: 'auto-extracted from OpenFDA' },
    bloodPlasmaRatio: { min: 0.6, max: 1.14, note: 'Manchester 2022, PMC9715504' },
    metabolism: { enzymes: [], metabolites: [], eliminationRoutes: ['Renal (2%)', 'Fecal'] },
    lethalRange: { median: 1850, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'LSD',
    nameEn: 'Lysergic acid diethylamide (LSD)',
    pubchemCid: 5761,
    molecularWeight: 323.4,
    halfLife: { median: 2.9166666666666665, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { median: 0.47, unit: 'L/kg', note: 'Dolder 2017, PMC5591798' },
    bloodPlasmaRatio: { median: 1, note: 'estimated; moderate protein binding' },
    metabolism: {
      enzymes: [],
      metabolites: ['2-oxy-LSD', 'LAE', 'nor-LSD', 'di-hydroxy-LSD', '13-', '14-hydroxy-LSD as glucoronides', 'lysergic acid ethyl-2-hydroxyethylamide (LEO)', 'trioxylated LSD'],
      eliminationRoutes: ['Renal', 'Fecal']
    },
    lethalRange: { median: 1, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'MDMA (ecstasy)',
    nameEn: '3,4-Methylenedioxymethamphetamine (MDMA)',
    pubchemCid: 1615,
    molecularWeight: 193.24,
    halfLife: { median: 8.6, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { min: 4, max: 6, unit: 'L/kg', note: 'De la Torre 2004, PMC2663855' },
    bloodPlasmaRatio: { median: 1, note: 'low protein binding ~34%' },
    metabolism: {
      enzymes: ['CYP2D6', 'CYP3A4', 'CYP2D8', 'CYP1A2'],
      metabolites: [],
      eliminationRoutes: ['Renal']
    },
    lethalRange: { median: 97, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Mefedron',
    nameEn: 'Mephedrone (4-MMC)',
    pubchemCid: 45266826,
    molecularWeight: 177.24,
    halfLife: { min: 1.6, max: 2.2, unit: 'h', note: 'Papaseit 2016, PMC5026738' },
    metabolism: {
      enzymes: [],
      metabolites: ['partly excreted as glucuronides', 'sulfates', 'partly excreted as glucuronide', 'sulfate conjugates'],
      eliminationRoutes: ['Renal']
    }
  },
  {
    name: 'Metadon',
    nameEn: 'Methadone',
    pubchemCid: 4095,
    molecularWeight: 309.4,
    halfLife: { min: 15, max: 207, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { min: 1, max: 8, unit: 'L/kg', note: 'auto-extracted' },
    bioavailability: { min: 0.92, max: 0.92, median: 0.92, unit: 'fraction' },
    bloodPlasmaRatio: { median: 0.75, note: 'high protein binding 85-90%; Baselt' },
    metabolism: {
      enzymes: ['CYP3A4', 'CYP2B6', 'CYP2C19', 'CYP2C9', 'CYP2C8', 'CYP2D6', 'CYP3A7', 'CYP2C18', 'CYP3A5', 'CYP1A2'],
      metabolites: ['EDDP', 'excreted in urine to a variable degree'],
      eliminationRoutes: ['Renal', 'Fecal']
    },
    lethalRange: { median: 86, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Metamfetamin',
    nameEn: 'Methamphetamine',
    pubchemCid: 10836,
    molecularWeight: 149.23,
    halfLife: { min: 4, max: 5, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { min: 3.2, max: 4.2, unit: 'L/kg', note: 'PMC2998419' },
    bioavailability: { min: 0.67, max: 0.67, median: 0.67, unit: 'fraction' },
    bloodPlasmaRatio: { median: 1, note: 'low protein binding; freely distributes' },
    metabolism: {
      enzymes: [],
      metabolites: ['amphetamine (active)', '4-hydroxymethamphetamine', '4-hydroxyamphetamine', 'norephedrine', '4-hydroxynorephedrine', 'benzoic acid & its glycine & glucuronic acid conjugates'],
      eliminationRoutes: ['Renal (15%)']
    },
    toxicRange: { min: 2, max: 6, unit: 'mg/kg', note: 'auto-extracted' },
    lethalRange: { median: 70, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Metonitazen',
    nameEn: 'Metonitazene',
    pubchemCid: 53316366,
    molecularWeight: 382.5
  },
  {
    name: 'Metylfenidat',
    nameEn: 'Methylphenidate',
    pubchemCid: 4158,
    molecularWeight: 233.31,
    halfLife: { median: 2.4, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { median: 2.23, unit: 'L/kg', note: 'auto-extracted' },
    bioavailability: { min: 0.22, max: 0.22, median: 0.22, unit: 'fraction' },
    proteinBinding: { median: 0.15, unit: 'fraction', note: 'auto-extracted' },
    bloodPlasmaRatio: { median: 1, note: 'low protein binding 15%' },
    metabolism: { enzymes: [], metabolites: [], eliminationRoutes: ['Renal (1%)', 'Fecal'] },
    lethalRange: { median: 190, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Midazolam',
    nameEn: 'Midazolam',
    pubchemCid: 4192,
    molecularWeight: 325.8,
    halfLife: { min: 1.8, max: 6.4, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { min: 1.24, max: 2.02, unit: 'L/kg', note: 'auto-extracted' },
    bioavailability: { min: 0.44, max: 0.44, median: 0.44, unit: 'fraction' },
    proteinBinding: { median: 0.97, unit: 'fraction', note: 'auto-extracted' },
    bloodPlasmaRatio: { median: 0.55, note: 'very high protein binding 97%' },
    metabolism: {
      enzymes: ['CYP3A4', 'UGT1A4'],
      metabolites: ['reportedly pharmacologically active', 'excreted mainly as conjugates'],
      eliminationRoutes: ['Renal']
    },
    lethalRange: { median: 825, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Morfin',
    nameEn: 'Morphine',
    pubchemCid: 5288826,
    molecularWeight: 285.34,
    halfLife: { min: 2, max: 3, median: 2.5, unit: 'h' },
    volumeOfDistribution: { min: 3, max: 5, median: 4, unit: 'L/kg' },
    bioavailability: { min: 0.2, max: 0.4, median: 0.24, unit: 'fraction', note: 'oral' },
    proteinBinding: { min: 0.3, max: 0.4, median: 0.35, unit: 'fraction' },
    bloodPlasmaRatio: { min: 1.1, max: 1.1, median: 1.1, unit: 'ratio' },
    metabolism: {
      enzymes: ['UGT2B7'],
      metabolites: ['Morphine-3-glucuronide', 'morphine-6-glucuronide'],
      eliminationRoutes: ['Renal']
    },
    lethalRange: { median: 461, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'N-desmetyldiazepam',
    nameEn: 'Nordazepam (N-desmethyldiazepam; Nordiazepam)',
    pubchemCid: 2997,
    molecularWeight: 270.71,
    halfLife: { min: 36, max: 200, unit: 'h', note: 'commonly 50-120h; wide range' },
    volumeOfDistribution: { min: 0.8, max: 1.4, unit: 'L/kg', note: 'Springer BF00426477' },
    metabolism: {
      enzymes: [],
      metabolites: ['Doxorubicinol aglycone', '7d-Aon', 'Doxorubicin aglycone', 'Epirubicin glucuronide', 'Epidoxorubicinol, 4\'-epiadriamycinol', 'Epirubicinol glucuronide', '7d-Aolon', 'Metabolite M4', 'Metabolite M2', 'Metabolite M5', 'Metabolite M6'],
      eliminationRoutes: []
    }
  },
  {
    name: 'N-pyrrolidinmetonitazen',
    nameEn: 'N-Pyrrolidino metonitazene',
    pubchemCid: 168323127,
    molecularWeight: 380.4,
    metabolism: {
      enzymes: [],
      metabolites: ['Doxorubicinol aglycone', '7d-Aon', 'Doxorubicin aglycone', 'Epirubicin glucuronide', 'Epidoxorubicinol, 4\'-epiadriamycinol', 'Epirubicinol glucuronide', '7d-Aolon', 'Metabolite M4', 'Metabolite M2', 'Metabolite M5', 'Metabolite M6'],
      eliminationRoutes: []
    }
  },
  {
    name: 'N-pyrrolidinprotonitazen',
    nameEn: 'N-Pyrrolidino protonitazene',
    pubchemCid: 168322728,
    molecularWeight: 408.5,
    metabolism: {
      enzymes: [],
      metabolites: ['Doxorubicinol aglycone', '7d-Aon', 'Doxorubicin aglycone', 'Epirubicin glucuronide', 'Epidoxorubicinol, 4\'-epiadriamycinol', 'Epirubicinol glucuronide', '7d-Aolon', 'Metabolite M4', 'Metabolite M2', 'Metabolite M5', 'Metabolite M6'],
      eliminationRoutes: []
    }
  },
  {
    name: 'Naloxon',
    nameEn: 'Naloxone',
    pubchemCid: 5284596,
    molecularWeight: 327.4,
    halfLife: { min: 1.8, max: 2.7, unit: 'h', note: 'auto-extracted' },
    bioavailability: { min: 0.02, max: 0.02, median: 0.02, unit: 'fraction' },
    proteinBinding: { median: 0.45, unit: 'fraction', note: 'auto-extracted' },
    bloodPlasmaRatio: { median: 1, note: 'moderate protein binding ~45%' },
    metabolism: { enzymes: [], metabolites: [], eliminationRoutes: ['Renal', 'Fecal'] },
    toxicRange: { median: 10, unit: 'mg/kg', note: 'auto-extracted from PubChem' },
    lethalRange: { median: 90, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Nitrazepam',
    nameEn: 'Nitrazepam',
    pubchemCid: 4506,
    molecularWeight: 281.27,
    halfLife: { median: 26, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { min: 2, max: 5, unit: 'L/kg', note: 'clinical pharmacology' },
    bioavailability: { min: 0.78, max: 0.78, median: 0.78, unit: 'fraction' },
    bloodPlasmaRatio: { median: 0.63, note: 'Manchester 2022, PMC9715504' },
    metabolism: {
      enzymes: [],
      metabolites: ['Doxorubicinol aglycone', '7d-Aon', 'Doxorubicin aglycone', 'Epirubicin glucuronide', 'Epidoxorubicinol, 4\'-epiadriamycinol', 'Epirubicinol glucuronide', '7d-Aolon', 'Metabolite M4', 'Metabolite M2', 'Metabolite M5', 'Metabolite M6'],
      eliminationRoutes: []
    }
  },
  {
    name: 'Oksykodon',
    nameEn: 'Oxycodone',
    pubchemCid: 5284603,
    molecularWeight: 315.4,
    halfLife: { median: 3.2, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { median: 2.6, unit: 'L/kg', note: 'auto-extracted' },
    bioavailability: { min: 0.42, max: 0.42, median: 0.42, unit: 'fraction' },
    bloodPlasmaRatio: { median: 1, note: 'Poyhia 1992; B/P ~1.0' },
    metabolism: {
      enzymes: ['CYP3A4', 'CYP2D6', 'CYP3A5', 'UGT2B7', 'UGT2B4', 'UGT1A3', 'UGT1A6'],
      metabolites: ['excreted primarily via the kidney'],
      eliminationRoutes: []
    },
    lethalRange: { median: 320, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Oxazepam',
    nameEn: 'Oxazepam',
    pubchemCid: 4616,
    molecularWeight: 286.71,
    halfLife: { min: 3, max: 21, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { min: 0.6, max: 2, unit: 'L/kg', note: 'clinical pharmacology' },
    bioavailability: { min: 0.97, max: 0.97, median: 0.97, unit: 'fraction' },
    proteinBinding: { median: 0.89, unit: 'fraction', note: 'auto-extracted' },
    bloodPlasmaRatio: { median: 0.6, note: 'estimated from protein binding 89%' },
    metabolism: {
      enzymes: ['UGT2B15', 'UGT2B7', 'UGT1A9'],
      metabolites: [],
      eliminationRoutes: ['Renal', 'Fecal']
    }
  },
  {
    name: 'para-Metoksymetamfetamin',
    // Keep the "PMMA" acronym inside a name (repo idiom, cf. "3-CMC", "6-MAM"):
    // seed-drugs and the embedded-catalog fallback build search_key from names
    // only, so without it a freshly seeded / offline database can't find "PMMA".
    nameEn: 'para-Methoxymethamphetamine (PMMA)',
    pubchemCid: 90766,
    molecularWeight: 179.26,
    metabolism: {
      enzymes: [],
      metabolites: [],
      eliminationRoutes: []
    }
  },
  {
    name: 'Pregabalin',
    nameEn: 'Pregabalin',
    pubchemCid: 5486971,
    molecularWeight: 159.23,
    halfLife: { median: 6.3, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { median: 0.5, unit: 'L/kg', note: 'auto-extracted' },
    bioavailability: { min: 0.9, max: 0.9, median: 0.9, unit: 'fraction' },
    bloodPlasmaRatio: { median: 1, note: 'no protein binding; freely distributes' },
    metabolism: { enzymes: [], metabolites: [], eliminationRoutes: ['Renal'] },
    toxicRange: { median: 100, unit: 'mg/kg', note: 'auto-extracted from PubChem' }
  },
  {
    name: 'Prometazin',
    nameEn: 'Promethazine',
    pubchemCid: 4927,
    molecularWeight: 284.42,
    halfLife: { min: 12, max: 15, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { median: 30, unit: 'L/kg', note: 'auto-extracted' },
    bioavailability: { min: 0.25, max: 0.25, median: 0.25, unit: 'fraction' },
    proteinBinding: { median: 0.93, unit: 'fraction', note: 'auto-extracted' },
    bloodPlasmaRatio: { median: 1, note: 'estimated; protein binding 93%' },
    metabolism: { enzymes: ['CYP2D6'], metabolites: ['promethazine sulfoxide'], eliminationRoutes: ['Renal'] },
    lethalRange: { median: 19, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Protonitazen',
    nameEn: 'Protonitazene',
    pubchemCid: 156589001,
    molecularWeight: 410.5
  },
  {
    name: 'Psilocin',
    nameEn: 'Psilocin',
    pubchemCid: 4980,
    molecularWeight: 204.27,
    halfLife: { min: 1.2, max: 4.8, unit: 'h', note: 'PMC12030428, Holze 2023' },
    volumeOfDistribution: { min: 4, max: 18, unit: 'L/kg', note: 'PMC12030428' },
    metabolism: {
      enzymes: [],
      metabolites: ['Doxorubicinol aglycone', '7d-Aon', 'Doxorubicin aglycone', 'Epirubicin glucuronide', 'Epidoxorubicinol, 4\'-epiadriamycinol', 'Epirubicinol glucuronide', '7d-Aolon', 'Metabolite M4', 'Metabolite M2', 'Metabolite M5', 'Metabolite M6'],
      eliminationRoutes: []
    }
  },
  {
    name: 'Psilocinglukuronid',
    nameEn: 'Psilocin glucuronide',
    pubchemCid: 101264121,
    molecularWeight: 380.4,
    metabolism: {
      enzymes: [],
      metabolites: ['Doxorubicinol aglycone', '7d-Aon', 'Doxorubicin aglycone', 'Epirubicin glucuronide', 'Epidoxorubicinol, 4\'-epiadriamycinol', 'Epirubicinol glucuronide', '7d-Aolon', 'Metabolite M4', 'Metabolite M2', 'Metabolite M5', 'Metabolite M6'],
      eliminationRoutes: []
    }
  },
  {
    name: 'Skopolamin',
    nameEn: 'Scopolamine',
    // Was 3000322, a depositor record ("Boro-Scopol") rather than scopolamine's
    // parent entry — one of the non-canonical CIDs `audit:pubchem-identity`
    // reports as a variant record, and the reason the catalog carried two
    // scopolamine rows. Repointed at the canonical CID the merge adopts.
    pubchemCid: 5184,
    molecularWeight: 303.35,
    halfLife: { median: 3.55, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { median: 1.4, unit: 'L/kg', note: 'PubMed 2762223' },
    bioavailability: { min: 0.27, max: 0.27, median: 0.27, unit: 'fraction' },
    proteinBinding: { median: 0.1, unit: 'fraction', note: 'auto-extracted' },
    bloodPlasmaRatio: { median: 1, note: 'low protein binding; freely distributes' },
    metabolism: {
      enzymes: ['CYP3A4'],
      metabolites: ['various glucuronide', 'sulphide conjugates'],
      eliminationRoutes: ['Renal']
    },
    toxicRange: { median: 10, unit: 'mg/kg', note: 'auto-extracted from PubChem' }
  },
  {
    name: 'Tapentadol',
    nameEn: 'Tapentadol',
    pubchemCid: 9838022,
    molecularWeight: 221.34,
    halfLife: { median: 4, unit: 'h', note: 'auto-extracted' },
    bioavailability: { median: 0.32, unit: 'fraction', note: 'auto-extracted from OpenFDA' },
    proteinBinding: { median: 0.2, unit: 'fraction', note: 'auto-extracted' },
    bloodPlasmaRatio: { median: 1, note: 'low protein binding ~20%' },
    metabolism: {
      enzymes: ['CYP2C9', 'CYP2C19', 'CYP2D6'],
      metabolites: ['excreted almost exclusively (99%) via the kidneys'],
      eliminationRoutes: ['Renal']
    },
    toxicRange: { median: 10, unit: 'mg/kg', note: 'auto-extracted from PubChem' },
    lethalRange: { median: 40, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'THC',
    nameEn: 'Δ9-Tetrahydrocannabinol (THC)',
    pubchemCid: 16078,
    molecularWeight: 314.5,
    halfLife: { min: 25, max: 36, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { median: 10, unit: 'L/kg', note: 'auto-extracted' },
    proteinBinding: { median: 0.97, unit: 'fraction', note: 'auto-extracted' },
    bloodPlasmaRatio: { median: 0.55, note: 'very high protein binding 97%; Launiainen 2014' },
    metabolism: { enzymes: [], metabolites: [], eliminationRoutes: ['Renal', 'Fecal'] },
    toxicRange: { median: 30, unit: 'mg/kg', note: 'auto-extracted from PubChem' },
    lethalRange: { median: 1270, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Tramadol',
    nameEn: 'Tramadol',
    pubchemCid: 33741,
    molecularWeight: 263.37,
    halfLife: { min: 5, max: 6, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { min: 2.6, max: 2.9, unit: 'L/kg', note: 'auto-extracted' },
    bioavailability: { min: 0.725, max: 0.725, median: 0.725, unit: 'fraction' },
    bloodPlasmaRatio: { median: 1, note: 'moderate protein binding 20%; Baselt' },
    metabolism: {
      enzymes: ['CYP2D6', 'CYP3A4', 'CYP2B6'],
      metabolites: ['excreted primarily by the kidneys'],
      eliminationRoutes: ['Renal (60%)', 'Pulmonary']
    },
    therapeuticRange: { min: 0.1, max: 0.3, unit: 'mg/l', note: 'auto-extracted' },
    lethalRange: { median: 350, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Zolpidem',
    nameEn: 'Zolpidem',
    pubchemCid: 5732,
    molecularWeight: 307.4,
    halfLife: { median: 9.9, unit: 'h', note: 'auto-extracted from OpenFDA' },
    volumeOfDistribution: { median: 0.54, unit: 'L/kg', note: 'FDA label' },
    bioavailability: { min: 0.72, max: 0.72, median: 0.72, unit: 'fraction' },
    bloodPlasmaRatio: { median: 0.6, note: 'high protein binding 92%' },
    metabolism: { enzymes: ['CYP3A4', 'CYP1A2', 'CYP2C9'], metabolites: ['inactive'], eliminationRoutes: [] }
  },
  {
    name: 'Zopiclon',
    nameEn: 'Zopiclone',
    pubchemCid: 5735,
    molecularWeight: 388.8,
    halfLife: { min: 3.8, max: 6.5, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { min: 1.3, max: 1.6, unit: 'L/kg', note: 'PubMed 8787948' },
    bloodPlasmaRatio: { median: 1, note: 'moderate protein binding 45%' },
    metabolism: {
      enzymes: [],
      metabolites: ['an N-desmethyl metabolite (inactive; approximately 16%)'],
      eliminationRoutes: []
    }
  },
  {
    name: 'Amitriptylin',
    nameEn: 'Amitriptyline',
    pubchemCid: 2160,
    molecularWeight: 277.4,
    halfLife: { min: 10, max: 50, unit: 'h', note: 'auto-extracted' },
    bioavailability: { min: 0.48, max: 0.48, median: 0.48, unit: 'fraction' },
    bloodPlasmaRatio: { median: 1.3, note: 'Baselt; erythrocyte partitioning' },
    metabolism: {
      enzymes: ['CYP2C19', 'CYP3A4', 'CYP2D6', 'CYP1A2', 'CYP2C9', 'CYP3A1'],
      metabolites: [],
      eliminationRoutes: ['Renal', 'Fecal']
    },
    therapeuticRange: { min: 1, max: 2, unit: 'mg/dL', note: 'auto-extracted' },
    toxicRange: { min: 1, max: 2, unit: 'mg/dL', note: 'auto-extracted' },
    lethalRange: { median: 350, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Aripiprazol',
    nameEn: 'Aripiprazole',
    pubchemCid: 60795,
    molecularWeight: 448.39,
    halfLife: { median: 146, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { median: 4.9, unit: 'L/kg', note: 'PMC2675764' },
    bioavailability: { min: 0.87, max: 0.87, median: 0.87, unit: 'fraction' },
    proteinBinding: { median: 0.99, unit: 'fraction', note: 'auto-extracted' },
    bloodPlasmaRatio: { median: 1, note: 'high protein binding >99%; estimated' },
    metabolism: { enzymes: ['CYP3A4', 'CYP2D6'], metabolites: [], eliminationRoutes: ['Renal (18%)', 'Fecal'] },
    toxicRange: { median: 2, unit: 'mg/kg', note: 'auto-extracted from PubChem' }
  },
  {
    name: 'Baklofen',
    nameEn: 'Baclofen',
    pubchemCid: 2284,
    molecularWeight: 213.66,
    halfLife: { min: 2, max: 6, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { median: 0.7, unit: 'L/kg', note: 'auto-extracted' },
    bioavailability: { min: 0.9, max: 0.9, median: 0.9, unit: 'fraction' },
    proteinBinding: { median: 0.3, unit: 'fraction', note: 'auto-extracted' },
    bloodPlasmaRatio: { median: 1, note: 'low protein binding 30%' },
    metabolism: { enzymes: [], metabolites: [], eliminationRoutes: ['Renal', 'Fecal'] },
    lethalRange: { median: 45, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Citalopram',
    nameEn: 'Citalopram',
    pubchemCid: 2771,
    molecularWeight: 324.39,
    halfLife: { median: 35, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { median: 12, unit: 'L/kg', note: 'auto-extracted' },
    bioavailability: { median: 0.8, unit: 'fraction', note: 'auto-extracted' },
    bloodPlasmaRatio: { median: 1, note: 'moderate protein binding ~80%; in-vivo ~1.0' },
    metabolism: {
      enzymes: ['CYP2C19', 'CYP3A4', 'CYP2D6', 'CYP1A2', 'CYP2C9', 'MAO'],
      metabolites: ['_didemethylcitalopram_ via CYP2D6 metabolism', '_citalopram <i>N</i>-oxide_', 'propionic acid derivative via monoamine oxidase enzymes A', 'aldehyde oxidase', 'not active', 'didemethylcitalopram', 'citalopram <i>N</i>-oxide', 'a deaminated propionic acid derivative'],
      eliminationRoutes: ['Renal (10%)', 'Fecal']
    },
    toxicRange: { median: 0.045, unit: 'mg/L', note: 'auto-extracted from PubChem' }
  },
  {
    name: 'Deksklorfeniramin',
    nameEn: 'Dexchlorpheniramine',
    pubchemCid: 33036,
    molecularWeight: 274.79,
    halfLife: { median: 20, unit: 'h', note: 'DrugBank DB09555; Paton & Webster 1985' },
    volumeOfDistribution: { min: 2.5, max: 3.8, unit: 'L/kg', note: 'clinical references' },
    metabolism: {
      enzymes: [],
      metabolites: ['Doxorubicinol aglycone', '7d-Aon', 'Doxorubicin aglycone', 'Epirubicin glucuronide', 'Epidoxorubicinol, 4\'-epiadriamycinol', 'Epirubicinol glucuronide', '7d-Aolon', 'Metabolite M4', 'Metabolite M2', 'Metabolite M5', 'Metabolite M6'],
      eliminationRoutes: []
    },
    lethalRange: { median: 306, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Diltiazem',
    nameEn: 'Diltiazem',
    pubchemCid: 39186,
    molecularWeight: 414.52,
    halfLife: { min: 3, max: 4.5, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { median: 5.3, unit: 'L/kg', note: 'auto-extracted' },
    bioavailability: { min: 0.38, max: 0.38, median: 0.38, unit: 'fraction' },
    proteinBinding: { min: 0.7, max: 0.8, unit: 'fraction', note: 'auto-extracted' },
    bloodPlasmaRatio: { median: 1, note: 'protein binding 70-80%; Launiainen 2014' },
    metabolism: { enzymes: ['CYP3A4', 'CYP2D6'], metabolites: ['deacetyl N'], eliminationRoutes: [] },
    therapeuticRange: { min: 50, max: 200, unit: 'ng/mL', note: 'auto-extracted from OpenFDA' }
  },
  {
    name: 'Doxepin',
    nameEn: 'Doxepin',
    pubchemCid: 3158,
    molecularWeight: 279.38,
    halfLife: { median: 15, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { median: 20, unit: 'L/kg', note: 'auto-extracted' },
    bioavailability: { min: 0.3, max: 0.3, median: 0.3, unit: 'fraction' },
    proteinBinding: { median: 0.755, unit: 'fraction', note: 'auto-extracted' },
    bloodPlasmaRatio: { median: 1, note: 'TCA; in-vivo ~1.0; Launiainen 2014' },
    metabolism: { enzymes: ['CYP2C19', 'CYP2D6', 'CYP1A2', 'CYP2C9'], metabolites: [], eliminationRoutes: [] },
    lethalRange: { median: 26, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Duloksetin',
    nameEn: 'Duloxetine',
    pubchemCid: 60835,
    molecularWeight: 297.42,
    halfLife: { min: 8, max: 17, unit: 'h', note: 'auto-extracted' },
    bioavailability: { min: 0.5, max: 0.5, median: 0.5, unit: 'fraction' },
    proteinBinding: { median: 0.9, unit: 'fraction', note: 'auto-extracted' },
    bloodPlasmaRatio: { median: 1, note: 'high protein binding >90%; estimated' },
    metabolism: {
      enzymes: ['CYP1A2', 'CYP2D6', 'CYP2C9'],
      metabolites: [],
      eliminationRoutes: ['Renal', 'Fecal (5%)']
    }
  },
  {
    name: 'Fenazon',
    nameEn: 'Phenazone (Antipyrine)',
    pubchemCid: 2206,
    molecularWeight: 188.23,
    halfLife: { min: 8, max: 20, unit: 'h', note: 'PubMed 7201837; mean ~12h' },
    bioavailability: { min: 0.99, max: 0.99, median: 0.99, unit: 'fraction' },
    metabolism: {
      enzymes: [],
      metabolites: ['Doxorubicinol aglycone', '7d-Aon', 'Doxorubicin aglycone', 'Epirubicin glucuronide', 'Epidoxorubicinol, 4\'-epiadriamycinol', 'Epirubicinol glucuronide', '7d-Aolon', 'Metabolite M4', 'Metabolite M2', 'Metabolite M5', 'Metabolite M6'],
      eliminationRoutes: []
    }
  },
  {
    name: 'Fluoxetin',
    nameEn: 'Fluoxetine',
    pubchemCid: 3386,
    molecularWeight: 309.33,
    halfLife: { min: 24, max: 72, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { min: 20, max: 42, unit: 'L/kg', note: 'auto-extracted' },
    bioavailability: { min: 0.6, max: 0.6, median: 0.6, unit: 'fraction' },
    proteinBinding: { median: 0.945, unit: 'fraction', note: 'auto-extracted from OpenFDA' },
    bloodPlasmaRatio: { median: 1, note: 'protein binding 94.5%; estimated in-vivo ~1.0' },
    metabolism: {
      enzymes: ['CYP1A2', 'CYP2B6', 'CYP2C9', 'CYP2C19', 'CYP2D6', 'CYP3A4', 'CYP3A5'],
      metabolites: ['norfluoxetine by CYP1A2', 'hippuric acid'],
      eliminationRoutes: ['Pulmonary']
    }
  },
  {
    name: 'Haloperidol',
    nameEn: 'Haloperidol',
    pubchemCid: 3559,
    molecularWeight: 375.86,
    halfLife: { min: 14.5, max: 36.7, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { min: 9.5, max: 21.7, unit: 'L/kg', note: 'auto-extracted' },
    bioavailability: { min: 0.6, max: 0.6, median: 0.6, unit: 'fraction' },
    bloodPlasmaRatio: { median: 1, note: 'protein binding ~92%; Launiainen 2014' },
    metabolism: {
      enzymes: ['CYP3A4', 'CYP2D6'],
      metabolites: ['p-fluorophenaceturic acid', 'beta-p-fluorobenzoylpropionic acid', 'several unidentified acids (A637', 'A566', 'A637)'],
      eliminationRoutes: ['Renal', 'Pulmonary']
    },
    toxicRange: { median: 2.5, unit: 'mg/kg', note: 'auto-extracted from PubChem' },
    lethalRange: { median: 128, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Hydroksybupropion',
    nameEn: 'Hydroxybupropion',
    pubchemCid: 446,
    molecularWeight: 255.74,
    halfLife: { min: 15, max: 25, unit: 'h', note: 'FDA Wellbutrin label' },
    metabolism: {
      enzymes: [],
      metabolites: ['Doxorubicinol aglycone', '7d-Aon', 'Doxorubicin aglycone', 'Epirubicin glucuronide', 'Epidoxorubicinol, 4\'-epiadriamycinol', 'Epirubicinol glucuronide', '7d-Aolon', 'Metabolite M4', 'Metabolite M2', 'Metabolite M5', 'Metabolite M6'],
      eliminationRoutes: []
    }
  },
  {
    name: 'Klomipramin',
    nameEn: 'Clomipramine',
    pubchemCid: 2801,
    molecularWeight: 314.86,
    halfLife: { min: 19, max: 37, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { median: 17, unit: 'L/kg', note: 'PubMed 2044329' },
    bioavailability: { min: 0.51, max: 0.51, median: 0.51, unit: 'fraction' },
    proteinBinding: { min: 0.97, max: 0.98, unit: 'fraction', note: 'auto-extracted' },
    bloodPlasmaRatio: { median: 1, note: 'estimated from similar TCAs' },
    metabolism: {
      enzymes: ['CYP2C19', 'CYP2D6', 'CYP1A2'],
      metabolites: ['8-hydroxydesmethylclomipramine and didesmethylclomipramine'],
      eliminationRoutes: ['Renal (60%)', 'Fecal (32%)', 'Pulmonary']
    }
  },
  {
    name: 'Klozapin',
    nameEn: 'Clozapine',
    pubchemCid: 135398737,
    molecularWeight: 326.83,
    halfLife: { min: 4, max: 12, unit: 'h', note: 'auto-extracted' },
    bioavailability: { min: 0.55, max: 0.55, median: 0.55, unit: 'fraction' },
    proteinBinding: { median: 0.97, unit: 'fraction', note: 'auto-extracted' },
    bloodPlasmaRatio: { median: 1, note: 'protein binding 97%; Launiainen 2014' },
    metabolism: {
      enzymes: ['CYP1A2', 'CYP2D6', 'CYP3A4'],
      metabolites: ['N-oxideclozapine and N-desmethylclozapine'],
      eliminationRoutes: ['Renal (30%)', 'Fecal']
    },
    lethalRange: { median: 41.6, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Klorprotixen',
    nameEn: 'Chlorprothixene',
    pubchemCid: 667467,
    molecularWeight: 315.86,
    halfLife: { min: 12, max: 40, unit: 'h', note: 'Brosen 1996, PubMed 8901143' },
    bioavailability: { min: 0.41, max: 0.41, median: 0.41, unit: 'fraction' },
    metabolism: { enzymes: [], metabolites: [], eliminationRoutes: ['Renal', 'Fecal'] },
    lethalRange: { median: 380, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Lamotrigin',
    nameEn: 'Lamotrigine',
    pubchemCid: 3878,
    molecularWeight: 256.09,
    halfLife: { min: 14, max: 59, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { min: 0.9, max: 1.3, unit: 'L/kg', note: 'auto-extracted' },
    bioavailability: { min: 0.976, max: 0.976, median: 0.976, unit: 'fraction' },
    proteinBinding: { median: 0.55, unit: 'fraction', note: 'auto-extracted' },
    bloodPlasmaRatio: { median: 1, note: 'moderate protein binding 55%; Launiainen 2014' },
    metabolism: { enzymes: [], metabolites: [], eliminationRoutes: ['Renal', 'Fecal (10%)'] },
    therapeuticRange: { min: 1.6, max: 7.6, unit: 'mg/kg', note: 'auto-extracted' }
  },
  {
    name: 'Levomepromazin',
    nameEn: 'Levomepromazine',
    pubchemCid: 72287,
    molecularWeight: 328.47,
    halfLife: { min: 15, max: 78, unit: 'h', note: 'Dahl 1977; PubMed 1269194' },
    volumeOfDistribution: { min: 23, max: 42, unit: 'L/kg', note: 'PubMed 1269194' },
    bioavailability: { min: 0.5, max: 0.5, median: 0.5, unit: 'fraction' },
    metabolism: {
      enzymes: [],
      metabolites: ['Doxorubicinol aglycone', '7d-Aon', 'Doxorubicin aglycone', 'Epirubicin glucuronide', 'Epidoxorubicinol, 4\'-epiadriamycinol', 'Epirubicinol glucuronide', '7d-Aolon', 'Metabolite M4', 'Metabolite M2', 'Metabolite M5', 'Metabolite M6'],
      eliminationRoutes: []
    }
  },
  {
    name: 'Metoprolol',
    nameEn: 'Metoprolol',
    pubchemCid: 4171,
    molecularWeight: 267.36,
    halfLife: { min: 3, max: 7, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { median: 4.2, unit: 'L/kg', note: 'auto-extracted' },
    bioavailability: { min: 0.38, max: 0.38, median: 0.38, unit: 'fraction' },
    bloodPlasmaRatio: { median: 1, note: 'low-moderate protein binding; Launiainen 2014' },
    metabolism: { enzymes: ['CYP2D6', 'CYP3A4'], metabolites: [], eliminationRoutes: ['Renal'] },
    lethalRange: { median: 4670, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Mianserin',
    nameEn: 'Mianserin',
    pubchemCid: 4184,
    molecularWeight: 264.37,
    halfLife: { min: 10, max: 61, unit: 'h', note: 'PubMed 6824562, PMC1379723' },
    bioavailability: { min: 0.22, max: 0.22, median: 0.22, unit: 'fraction' },
    metabolism: { enzymes: [], metabolites: [], eliminationRoutes: ['Renal'] },
    therapeuticRange: { median: 100, unit: 'ng/ml', note: 'auto-extracted' },
    lethalRange: { median: 365, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Mirtazapin',
    nameEn: 'Mirtazapine',
    pubchemCid: 4205,
    molecularWeight: 265.35,
    halfLife: { min: 20, max: 40, unit: 'h', note: 'auto-extracted from OpenFDA' },
    bioavailability: { min: 0.5, max: 0.5, median: 0.5, unit: 'fraction' },
    proteinBinding: { median: 0.85, unit: 'fraction', note: 'auto-extracted' },
    bloodPlasmaRatio: { median: 1, note: 'protein binding ~85%; Launiainen 2014' },
    metabolism: {
      enzymes: ['CYP2D6', 'CYP1A2', 'CYP3A4'],
      metabolites: ['eliminated predominantly (75%) via urine with 15% in feces'],
      eliminationRoutes: ['Renal (15%)', 'Fecal']
    },
    lethalRange: { median: 720, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Nortriptylin',
    nameEn: 'Nortriptyline',
    pubchemCid: 4543,
    molecularWeight: 263.38,
    halfLife: { median: 26, unit: 'h', note: 'auto-extracted' },
    bioavailability: { min: 0.51, max: 0.51, median: 0.51, unit: 'fraction' },
    proteinBinding: { median: 0.93, unit: 'fraction', note: 'auto-extracted' },
    bloodPlasmaRatio: { median: 1.3, note: 'TCA; erythrocyte partitioning; clinical references' },
    metabolism: {
      enzymes: ['CYP2D6', 'CYP1A2', 'CYP2C19', 'CYP3A4', 'CYP3A1'],
      metabolites: ['conjugated', 'are less potent'],
      eliminationRoutes: ['Renal', 'Fecal']
    },
    lethalRange: { median: 17, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'O-desmetyltramadol',
    nameEn: 'O-Desmethyltramadol',
    pubchemCid: 9838803,
    molecularWeight: 249.35,
    halfLife: { min: 6, max: 9, unit: 'h', note: 'active metabolite of tramadol; population PK' },
    metabolism: {
      enzymes: [],
      metabolites: ['Doxorubicinol aglycone', '7d-Aon', 'Doxorubicin aglycone', 'Epirubicin glucuronide', 'Epidoxorubicinol, 4\'-epiadriamycinol', 'Epirubicinol glucuronide', '7d-Aolon', 'Metabolite M4', 'Metabolite M2', 'Metabolite M5', 'Metabolite M6'],
      eliminationRoutes: []
    }
  },
  {
    name: 'Olanzapin',
    nameEn: 'Olanzapine',
    pubchemCid: 135398745,
    molecularWeight: 312.43,
    halfLife: { min: 21, max: 54, unit: 'h', note: 'auto-extracted' },
    bioavailability: { min: 0.6, max: 0.6, median: 0.6, unit: 'fraction' },
    proteinBinding: { median: 0.93, unit: 'fraction', note: 'auto-extracted from OpenFDA' },
    bloodPlasmaRatio: { median: 1, note: 'protein binding 93%; Launiainen 2014' },
    metabolism: { enzymes: ['CYP1A2', 'CYP2D6', 'UGT1A4'], metabolites: [], eliminationRoutes: ['Renal', 'Fecal'] },
    toxicRange: { min: 1, unit: 'mg/L', note: 'auto-extracted' }
  },
  {
    name: 'Paracetamol',
    nameEn: 'Paracetamol (Acetaminophen)',
    pubchemCid: 1983,
    molecularWeight: 151.16,
    halfLife: { min: 4, max: 8, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { median: 0.9, unit: 'L/kg', note: 'auto-extracted' },
    bioavailability: { min: 0.88, max: 0.88, median: 0.88, unit: 'fraction' },
    bloodPlasmaRatio: { median: 1, note: 'low protein binding; Launiainen 2014' },
    metabolism: {
      enzymes: ['CYP2E1', 'CYP3A4', 'UGT1A1', 'UGT1A6', 'UGT1A9', 'UGT2B15', 'UGT1A10'],
      metabolites: ['produce both cysteine and mercapturic acid conjugates'],
      eliminationRoutes: ['Renal (3%)']
    },
    toxicRange: { median: 900, unit: 'μg/mL', note: 'auto-extracted from PubChem' },
    lethalRange: { median: 338, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Paroxetin',
    nameEn: 'Paroxetine',
    pubchemCid: 43815,
    molecularWeight: 329.37,
    halfLife: { median: 21, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { min: 3, max: 28, unit: 'L/kg', note: 'PubMed 2530793' },
    bioavailability: { min: 0.5, max: 0.5, median: 0.5, unit: 'fraction' },
    proteinBinding: { median: 0.95, unit: 'fraction', note: 'auto-extracted' },
    metabolism: {
      enzymes: ['CYP2D6', 'CYP3A4'],
      metabolites: ['polar', 'conjugated products of oxidation', 'methylation', 'which are readily cleared by the body', 'which are readily cleared', 'which are readily eliminated by the body', 'glucuronic acid', 'sulfate conjugates'],
      eliminationRoutes: ['Renal (2%)', 'Fecal']
    },
    toxicRange: { median: 0.045, unit: 'mg/L', note: 'auto-extracted from PubChem' },
    lethalRange: { median: 500, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Pentobarbital',
    nameEn: 'Pentobarbital',
    pubchemCid: 4737,
    molecularWeight: 226.27,
    halfLife: { min: 35, max: 50, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { median: 1, unit: 'L/kg', note: 'StatPearls NBK545288' },
    bioavailability: { min: 0.8, max: 0.8, median: 0.8, unit: 'fraction' },
    metabolism: { enzymes: [], metabolites: [], eliminationRoutes: ['Renal', 'Fecal'] },
    lethalRange: { median: 118, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Petidin',
    nameEn: 'Pethidine (Meperidine)',
    pubchemCid: 4058,
    molecularWeight: 247.33,
    halfLife: { min: 0.03333333333333333, max: 0.18333333333333332, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { min: 3.2, max: 4.3, unit: 'L/kg', note: 'PubMed 6953738' },
    bioavailability: { min: 0.52, max: 0.52, median: 0.52, unit: 'fraction' },
    proteinBinding: { min: 0.6, max: 0.8, unit: 'fraction', note: 'auto-extracted' },
    metabolism: {
      enzymes: [],
      metabolites: ['N-methyl-4-phenylpiperidine-4-carboxylic acid in rat'],
      eliminationRoutes: ['Renal (30%)']
    },
    toxicRange: { min: 0.85, max: 2.5, unit: 'mg/kg', note: 'auto-extracted' },
    lethalRange: { median: 170, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Proklorperazin',
    nameEn: 'Prochlorperazine',
    pubchemCid: 4917,
    molecularWeight: 373.94,
    halfLife: { min: 7, max: 9, unit: 'h', note: 'Taylor 1987, PMC1386060' },
    volumeOfDistribution: { median: 12.9, unit: 'L/kg', note: 'PMC1386060' },
    bioavailability: { min: 0.15, max: 0.15, median: 0.15, unit: 'fraction' },
    metabolism: { enzymes: ['CYP2D6', 'CYP3A4'], metabolites: [], eliminationRoutes: [] },
    toxicRange: { median: 25, unit: 'mg/kg', note: 'auto-extracted from PubChem' },
    lethalRange: { median: 1800, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Propranolol',
    nameEn: 'Propranolol',
    pubchemCid: 4946,
    molecularWeight: 259.34,
    halfLife: { min: 3, max: 6, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { median: 4, unit: 'L/kg', note: 'auto-extracted' },
    bioavailability: { min: 0.26, max: 0.26, median: 0.26, unit: 'fraction' },
    bloodPlasmaRatio: { median: 1, note: 'Launiainen 2014; erythrocyte uptake' },
    metabolism: {
      enzymes: [],
      metabolites: ['Doxorubicinol aglycone', '7d-Aon', 'Doxorubicin aglycone', 'Epirubicin glucuronide', 'Epidoxorubicinol, 4\'-epiadriamycinol', 'Epirubicinol glucuronide', '7d-Aolon', 'Metabolite M4', 'Metabolite M2', 'Metabolite M5', 'Metabolite M6'],
      eliminationRoutes: []
    }
  },
  {
    name: 'Quetiapin',
    nameEn: 'Quetiapine',
    pubchemCid: 5002,
    molecularWeight: 383.51,
    halfLife: { min: 6, max: 7, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { median: 4, unit: 'L/kg', note: 'auto-extracted' },
    bioavailability: { min: 0.09, max: 0.09, median: 0.09, unit: 'fraction' },
    proteinBinding: { median: 0.83, unit: 'fraction', note: 'auto-extracted' },
    bloodPlasmaRatio: { median: 1, note: 'protein binding 83%; Launiainen 2014' },
    metabolism: { enzymes: ['CYP2D6', 'CYP3A4'], metabolites: [], eliminationRoutes: ['Renal', 'Fecal'] },
    toxicRange: { median: 1500, unit: 'ng/mL', note: 'auto-extracted from PubChem' }
  },
  {
    name: 'Salisylsyre',
    nameEn: 'Salicylic Acid',
    pubchemCid: 338,
    molecularWeight: 138.12,
    halfLife: { min: 2, max: 30, unit: 'h', note: 'dose-dependent; PubMed 3888490' },
    bioavailability: { min: 0.99, max: 0.99, median: 0.99, unit: 'fraction' },
    metabolism: { enzymes: [], metabolites: [], eliminationRoutes: ['Renal'] },
    therapeuticRange: { min: 150, max: 300, unit: 'ug/mL', note: 'auto-extracted' },
    lethalRange: { median: 891, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Sertralin',
    nameEn: 'Sertraline',
    pubchemCid: 68617,
    molecularWeight: 306.23,
    halfLife: { min: 22, max: 36, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { median: 20, unit: 'L/kg', note: 'auto-extracted' },
    bioavailability: { min: 0.44, max: 0.44, median: 0.44, unit: 'fraction' },
    bloodPlasmaRatio: { median: 1, note: 'protein binding ~98%; Launiainen 2014' },
    metabolism: {
      enzymes: ['CYP3A4', 'CYP2B6', 'CYP2C19', 'CYP2D6'],
      metabolites: [],
      eliminationRoutes: ['Renal']
    }
  },
  {
    name: 'Teofyllin',
    nameEn: 'Theophylline',
    pubchemCid: 2153,
    molecularWeight: 180.16,
    halfLife: { min: 4, max: 5, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { median: 0.45, unit: 'L/kg', note: 'auto-extracted from OpenFDA' },
    bioavailability: { median: 0.988, unit: 'fraction', note: 'auto-extracted from OpenFDA' },
    bloodPlasmaRatio: { median: 1, note: 'protein binding 40%; Launiainen 2014' },
    metabolism: {
      enzymes: [],
      metabolites: ['excreted mainly by the kidneys'],
      eliminationRoutes: ['Renal', 'Fecal']
    },
    therapeuticRange: { min: 10, max: 20, unit: 'mcg/mL', note: 'auto-extracted from OpenFDA' },
    toxicRange: { min: 37, max: 60, unit: 'ug/mL', note: 'auto-extracted' },
    lethalRange: { median: 272, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Tiopental',
    nameEn: 'Thiopental',
    pubchemCid: 3000715,
    molecularWeight: 242.34,
    halfLife: { min: 3, max: 22, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { min: 0.4, max: 4, unit: 'L/kg', note: 'auto-extracted' },
    bloodPlasmaRatio: { median: 0.9, note: 'protein binding 83%; clinical references' },
    metabolism: {
      enzymes: [],
      metabolites: ['excreted in large', 'approximately equal quantities', 'whereas small amounts of thiopental were recovered'],
      eliminationRoutes: ['Renal']
    },
    lethalRange: { median: 120, unit: 'mg/kg', note: 'LD50 - auto-extracted' }
  },
  {
    name: 'Trimipramin',
    nameEn: 'Trimipramine',
    pubchemCid: 5584,
    molecularWeight: 294.43,
    halfLife: { min: 8, max: 24, unit: 'h', note: 'PubMed 6697642; DrugBank DB00726' },
    volumeOfDistribution: { median: 31, unit: 'L/kg', note: 'PubMed 6697642' },
    bioavailability: { min: 0.4, max: 0.4, median: 0.4, unit: 'fraction' },
    metabolism: {
      enzymes: [],
      metabolites: ['Doxorubicinol aglycone', '7d-Aon', 'Doxorubicin aglycone', 'Epirubicin glucuronide', 'Epidoxorubicinol, 4\'-epiadriamycinol', 'Epirubicinol glucuronide', '7d-Aolon', 'Metabolite M4', 'Metabolite M2', 'Metabolite M5', 'Metabolite M6'],
      eliminationRoutes: []
    }
  },
  {
    name: 'Venlafaxin',
    nameEn: 'Venlafaxine',
    pubchemCid: 5656,
    molecularWeight: 277.4,
    halfLife: { median: 2, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { min: 4.4, max: 7.5, unit: 'L/kg', note: 'StatPearls NBK535363' },
    bioavailability: { min: 0.45, max: 0.45, median: 0.45, unit: 'fraction' },
    proteinBinding: { median: 0.3, unit: 'fraction', note: 'auto-extracted' },
    metabolism: {
      enzymes: ['CYP2D6', 'CYP2C9', 'CYP2C19', 'CYP3A4', 'CYP3A1'],
      metabolites: ['form N'],
      eliminationRoutes: ['Renal']
    },
    toxicRange: { median: 16, unit: 'mg/kg', note: 'auto-extracted from PubChem' }
  },
  {
    name: 'Zuklopentixol',
    nameEn: 'Zuclopenthixol',
    pubchemCid: 5311507,
    molecularWeight: 400.97,
    halfLife: { min: 12, max: 28, unit: 'h', note: 'Lundbeck product monograph' },
    volumeOfDistribution: { median: 20, unit: 'L/kg', note: 'Lundbeck monograph' },
    bioavailability: { min: 0.49, max: 0.49, median: 0.49, unit: 'fraction' },
    metabolism: { enzymes: [], metabolites: ['devoid of pharmacological activity'], eliminationRoutes: [] }
  },
  {
    name: '10-OH-karbazepin (MHD)',
    nameEn: '10-Hydroxycarbamazepine (MHD)',
    pubchemCid: 114709,
    molecularWeight: 254.28,
    halfLife: { min: 7, max: 20, unit: 'h', note: 'FDA Trileptal label' },
    metabolism: {
      enzymes: [],
      metabolites: ['Doxorubicinol aglycone', '7d-Aon', 'Doxorubicin aglycone', 'Epirubicin glucuronide', 'Epidoxorubicinol, 4\'-epiadriamycinol', 'Epirubicinol glucuronide', '7d-Aolon', 'Metabolite M4', 'Metabolite M2', 'Metabolite M5', 'Metabolite M6'],
      eliminationRoutes: []
    }
  },
  {
    name: '7-aminoflunitrazepam',
    nameEn: '7-Aminoflunitrazepam',
    pubchemCid: 92294,
    molecularWeight: 283.3,
    metabolism: {
      enzymes: [],
      metabolites: ['Doxorubicinol aglycone', '7d-Aon', 'Doxorubicin aglycone', 'Epirubicin glucuronide', 'Epidoxorubicinol, 4\'-epiadriamycinol', 'Epirubicinol glucuronide', '7d-Aolon', 'Metabolite M4', 'Metabolite M2', 'Metabolite M5', 'Metabolite M6'],
      eliminationRoutes: []
    }
  },
  {
    name: '7-aminoklonazepam',
    nameEn: '7-Aminoclonazepam',
    pubchemCid: 188298,
    molecularWeight: 285.73,
    metabolism: {
      enzymes: [],
      metabolites: ['Doxorubicinol aglycone', '7d-Aon', 'Doxorubicin aglycone', 'Epirubicin glucuronide', 'Epidoxorubicinol, 4\'-epiadriamycinol', 'Epirubicinol glucuronide', '7d-Aolon', 'Metabolite M4', 'Metabolite M2', 'Metabolite M5', 'Metabolite M6'],
      eliminationRoutes: []
    }
  },
  {
    name: '7-aminonitrazepam',
    nameEn: '7-Aminonitrazepam',
    pubchemCid: 78641,
    molecularWeight: 251.28,
    metabolism: {
      enzymes: [],
      metabolites: ['Doxorubicinol aglycone', '7d-Aon', 'Doxorubicin aglycone', 'Epirubicin glucuronide', 'Epidoxorubicinol, 4\'-epiadriamycinol', 'Epirubicinol glucuronide', '7d-Aolon', 'Metabolite M4', 'Metabolite M2', 'Metabolite M5', 'Metabolite M6'],
      eliminationRoutes: []
    }
  },
  {
    name: 'Paliperidon',
    nameEn: 'Paliperidone',
    pubchemCid: 115237,
    molecularWeight: 426.49,
    halfLife: { median: 23, unit: 'h', note: 'auto-extracted' },
    bioavailability: { min: 0.28, max: 0.28, median: 0.28, unit: 'fraction' },
    proteinBinding: { median: 0.74, unit: 'fraction', note: 'auto-extracted' },
    bloodPlasmaRatio: { median: 1, note: 'moderate protein binding 77%; clinical references' },
    metabolism: { enzymes: ['CYP2D6', 'CYP3A4'], metabolites: [], eliminationRoutes: [] }
  },
  {
    name: 'Ketobemidon',
    nameEn: 'Ketobemidone',
    pubchemCid: 10101,
    molecularWeight: 247.33,
    halfLife: { min: 2, max: 4.4, unit: 'h', note: 'PMC1874494, PubMed 7215421' },
    volumeOfDistribution: { min: 2.4, max: 5.9, unit: 'L/kg', note: 'PMC1874494' },
    bioavailability: { min: 0.34, max: 0.34, median: 0.34, unit: 'fraction' },
    metabolism: {
      enzymes: [],
      metabolites: ['Doxorubicinol aglycone', '7d-Aon', 'Doxorubicin aglycone', 'Epirubicin glucuronide', 'Epidoxorubicinol, 4\'-epiadriamycinol', 'Epirubicinol glucuronide', '7d-Aolon', 'Metabolite M4', 'Metabolite M2', 'Metabolite M5', 'Metabolite M6'],
      eliminationRoutes: []
    }
  },
  {
    name: 'Karbamazepin',
    nameEn: 'Carbamazepine',
    pubchemCid: 2554,
    molecularWeight: 236.27,
    halfLife: { min: 35, max: 40, unit: 'h', note: 'auto-extracted' },
    volumeOfDistribution: { min: 0.7, max: 1.4, unit: 'L/kg', note: 'auto-extracted' },
    bioavailability: { min: 0.7, max: 0.7, median: 0.7, unit: 'fraction' },
    proteinBinding: { median: 0.8, unit: 'fraction', note: 'auto-extracted' },
    bloodPlasmaRatio: { median: 1, note: 'protein binding 75-80%; Launiainen 2014' },
    metabolism: {
      enzymes: ['CYP3A4', 'CYP2C8', 'CYP3A5', 'CYP2B6', 'UGT2B7'],
      metabolites: ['largely what was recovered in the urine', 'its trans-diol form by the enzyme epoxide hydrolase'],
      eliminationRoutes: ['Renal (28%)', 'Fecal']
    },
    therapeuticRange: { median: 12, unit: 'mcg/mL', note: 'auto-extracted from OpenFDA' },
    lethalRange: { median: 8.2, unit: 'mg/L', note: 'auto-extracted from PubChem' }
  },
  {
    name: 'Amisulprid',
    nameEn: 'Amisulpride',
    pubchemCid: 2159,
    molecularWeight: 369.48,
  },
  {
    name: 'Atomoksetin',
    nameEn: 'Atomoxetine',
    pubchemCid: 54841,
    molecularWeight: 255.36,
  },
  {
    name: 'Brekspiprazol',
    nameEn: 'Brexpiprazole',
    pubchemCid: 11978813,
    molecularWeight: 433.56,
  },
  {
    name: 'Bupropion',
    nameEn: 'Bupropion',
    pubchemCid: 444,
    molecularWeight: 239.74,
  },
  {
    name: 'Escitalopram',
    nameEn: 'Escitalopram',
    pubchemCid: 146570,
    molecularWeight: 324.39,
  },
  {
    name: 'Eslikarbazepin',
    nameEn: 'Eslicarbazepine',
    // Was 195085, which is a GlyTouCan glycan record (C22H36N2O17) and not
    // this substance at all — one of the wrong CIDs `audit:pubchem-identity`
    // turned up. The molecular weight beside it was always eslicarbazepine's
    // (C15H14N2O2, 254.29), so only the number was wrong. Repointed rather
    // than deleted: this file is both the offline fallback catalog and a
    // `seed:drugs` input, so a stale CID here recreates the bad row.
    pubchemCid: 9881504,
    molecularWeight: 254.28,
  },
  {
    name: 'Flupentiksol',
    nameEn: 'Flupentixol',
    pubchemCid: 5281881,
    molecularWeight: 434.52,
  },
  {
    name: 'Fluvoksamin',
    nameEn: 'Fluvoxamine',
    pubchemCid: 5324346,
    molecularWeight: 318.33,
  },
  {
    name: 'Kariprazin',
    nameEn: 'Cariprazine',
    pubchemCid: 11154555,
    molecularWeight: 427.41,
  },
  {
    name: 'Levetiracetam',
    nameEn: 'Levetiracetam',
    pubchemCid: 5284583,
    molecularWeight: 170.21,
  },
  {
    name: 'Litium',
    nameEn: 'Lithium',
    pubchemCid: 3028194,
    molecularWeight: 6.94,
  },
  {
    name: 'Lurasidon',
    nameEn: 'Lurasidone',
    pubchemCid: 213046,
    molecularWeight: 492.68,
  },
  {
    name: 'Okskarbazepin',
    nameEn: 'Oxcarbazepine',
    pubchemCid: 34312,
    molecularWeight: 252.27,
  },
  {
    name: 'Perfenazin',
    nameEn: 'Perphenazine',
    pubchemCid: 4748,
    molecularWeight: 403.97,
  },
  {
    name: 'Risperidon',
    nameEn: 'Risperidone',
    pubchemCid: 5073,
    molecularWeight: 410.49,
  },
  {
    name: 'Sertindol',
    nameEn: 'Sertindole',
    pubchemCid: 60149,
    molecularWeight: 440.95,
  },
  {
    name: 'Topiramat',
    nameEn: 'Topiramate',
    pubchemCid: 5284627,
    molecularWeight: 339.36,
  },
  {
    name: 'Valproat',
    nameEn: 'Valproic acid',
    pubchemCid: 3121,
    molecularWeight: 144.21,
  },
  {
    name: 'Vortioksetin',
    nameEn: 'Vortioxetine',
    pubchemCid: 9966051,
    molecularWeight: 298.45,
  },
  {
    name: 'Ziprasidon',
    nameEn: 'Ziprasidone',
    pubchemCid: 60854,
    molecularWeight: 412.94,
  },
  {
    name: 'MDA',
    nameEn: '3,4-Methylenedioxyamphetamine (MDA)',
    pubchemCid: 1614,
    molecularWeight: 179.22,
  },
  {
    name: 'Efedrin',
    nameEn: 'Ephedrine',
    // Was CID 9294 ((1R,2S)-ephedrine) until that row was merged into CID 5032
    // (DL-ephedrine); the catalog now carries one ephedrine, keyed by 5032.
    // The fixture has to follow, because `seed:drugs` upserts on pubchem_cid —
    // left at 9294 it would recreate the merged-away row on the next seed run,
    // and the exporter keeps fixture-only entries so it would not even show up
    // as drift. Same molecular weight either way: same formula, C10H15NO.
    pubchemCid: 5032,
    molecularWeight: 165.23,
  },
  {
    name: 'Pseudoefedrin',
    nameEn: 'Pseudoephedrine',
    pubchemCid: 7028,
    molecularWeight: 165.23,
  },
  {
    name: 'Norefedrin',
    nameEn: 'Norephedrine (Phenylpropanolamine)',
    pubchemCid: 10297,
    molecularWeight: 151.21,
  },
  {
    name: 'Norpseudoefedrin',
    nameEn: 'Norpseudoephedrine (Cathine)',
    pubchemCid: 441457,
    molecularWeight: 151.21,
  },
  {
    name: 'Katinon',
    nameEn: 'Cathinone',
    pubchemCid: 62258,
    molecularWeight: 149.19,
  },
  {
    name: 'Ritalinsyre',
    nameEn: 'Ritalinic acid',
    pubchemCid: 86863,
    molecularWeight: 219.28,
  },
  {
    name: 'EDDP',
    nameEn: '2-Ethylidene-1,5-dimethyl-3,3-diphenylpyrrolidine (EDDP)',
    pubchemCid: 5352621,
    molecularWeight: 277.4,
  },
  {
    name: 'Buprenorfinglukuronid',
    nameEn: 'Buprenorphine glucuronide',
    pubchemCid: 92131860,
    molecularWeight: 643.8,
  },
  {
    name: 'Norbuprenorfinglukuronid',
    nameEn: 'Norbuprenorphine glucuronide',
    pubchemCid: 91800110,
    molecularWeight: 589.7,
  },
  {
    name: 'Norfentanyl',
    nameEn: 'Norfentanyl',
    pubchemCid: 259381,
    molecularWeight: 232.32,
  },
  {
    name: 'Norketamin',
    nameEn: 'Norketamine',
    pubchemCid: 123767,
    molecularWeight: 223.70,
  },
  {
    name: 'Dehydronorketamin',
    nameEn: 'Dehydronorketamine',
    pubchemCid: 162835,
    molecularWeight: 221.68,
  },
  {
    name: 'Alfentanil',
    nameEn: 'Alfentanil',
    pubchemCid: 51263,
    molecularWeight: 416.5,
  },
  {
    name: 'Norpetidin',
    nameEn: 'Norpethidine (Normeperidine)',
    pubchemCid: 32414,
    molecularWeight: 233.31,
  },
  {
    name: 'Remifentanilsyre',
    nameEn: 'Remifentanil acid',
    pubchemCid: 131560,
    molecularWeight: 362.4,
  },
  {
    name: 'Kotinin',
    nameEn: 'Cotinine',
    pubchemCid: 854019,
    molecularWeight: 176.21,
  },
  {
    name: 'Lakosamid',
    nameEn: 'Lacosamide',
    pubchemCid: 219078,
    molecularWeight: 250.29,
  },
  {
    name: '3-OH Diazepam',
    nameEn: '3-Hydroxydiazepam (Temazepam)',
    pubchemCid: 5391,
    molecularWeight: 300.74,
  },
  {
    name: '3-OH-fenazepam',
    nameEn: '3-Hydroxyphenazepam',
    pubchemCid: 125820,
    molecularWeight: 365.61,
  },
  {
    name: 'Alfa-OH-alprazolam',
    nameEn: 'alpha-Hydroxyalprazolam',
    pubchemCid: 162244,
    molecularWeight: 324.8,
  },
  {
    name: 'Zopiclon-N-oksid',
    nameEn: 'Zopiclone N-oxide',
    pubchemCid: 162548,
    molecularWeight: 404.8,
  },
  {
    name: 'Zolpidem-fenyl-4-karboksylsyre',
    nameEn: 'Zolpidem phenyl-4-carboxylic acid',
    pubchemCid: 11966044,
    molecularWeight: 337.4,
  },
  {
    name: '1-OH midazolam',
    nameEn: 'alpha-Hydroxymidazolam (1-Hydroxymidazolam)',
    pubchemCid: 107917,
    molecularWeight: 341.8,
  },
  {
    name: 'Alfa-hydroksyetizolam',
    nameEn: 'alpha-Hydroxyetizolam',
    pubchemCid: 15135972,
    molecularWeight: 358.8,
  },
  {
    name: 'Alfa-hydroksyflualprazolam',
    nameEn: 'alpha-Hydroxyflualprazolam',
    pubchemCid: 19865837,
    molecularWeight: 342.8,
  },
  {
    name: 'Valproinsyre',
    nameEn: 'Valproic acid',
    pubchemCid: 3121,
    molecularWeight: 144.21,
  },
  {
    name: 'Etylglukuronid',
    nameEn: 'Ethyl glucuronide',
    pubchemCid: 26333,
    molecularWeight: 222.19,
  },
  {
    name: 'Etylsulfat',
    nameEn: 'Ethyl sulfate',
    pubchemCid: 24561,
    molecularWeight: 126.13,
  }
];
