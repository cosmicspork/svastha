// Terminology tables for quick-log. These Code objects go into signed events,
// and `display` is part of the canonical content (see core's `put_opt_code`),
// so every string here is id-affecting: changing one later makes "the same"
// reading hash to a new event id. Treat entries as append-only.

export interface Code {
  system: string
  code: string
  display?: string
}

export const LOINC = 'http://loinc.org'
export const SNOMED = 'http://snomed.info/sct'
export const UCUM = 'http://unitsofmeasure.org'
export const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm'
/** App-local concepts with no LOINC/SNOMED equivalent worth forcing (mood,
 * gratitude). Never leaves this app, so there's no external terminology to
 * defer to. */
export const SVASTHA = 'urn:svastha:codes'

/** Well-known terminology system URIs -> the short label a clinician reads
 * ("LOINC 4548-4"). Imported events carry the full system URI; this is the only
 * place that maps one to its familiar acronym, so the spine hint and the
 * provenance stub agree. Unknown systems fall back to the raw URI. */
const SYSTEM_LABELS: Record<string, string> = {
  [LOINC]: 'LOINC',
  [SNOMED]: 'SNOMED',
  [RXNORM]: 'RxNorm',
  'http://hl7.org/fhir/sid/icd-10-cm': 'ICD-10-CM',
  'http://www.ama-assn.org/go/cpt': 'CPT',
  'http://hl7.org/fhir/sid/cvx': 'CVX',
}

export function shortenSystem(system: string): string {
  return SYSTEM_LABELS[system] ?? system
}

function loinc(code: string, display: string): Code {
  return { system: LOINC, code, display }
}

function snomed(code: string, display: string): Code {
  return { system: SNOMED, code, display }
}

function ucum(code: string): Code {
  return { system: UCUM, code }
}

function svastha(code: string, display: string): Code {
  return { system: SVASTHA, code, display }
}

// --- vitals ---

/** A selectable unit plus its soft plausibility range (used for warnings only,
 * never to block a save — real readings can be extreme). */
export interface VitalUnit {
  unit: Code
  min: number
  max: number
}

export interface VitalDef {
  key: string
  label: string
  loinc: Code
  /** Index 0 is the default; more than one means the user picks (persisted in
   * prefs as `vital-unit-<key>`). */
  units: VitalUnit[]
  /** Input hint: 0 renders an integer field (`inputmode=numeric`). */
  decimals: number
}

export const BP_SYSTOLIC = loinc('8480-6', 'Systolic blood pressure')
export const BP_DIASTOLIC = loinc('8462-4', 'Diastolic blood pressure')
export const MMHG = ucum('mm[Hg]')
export const BP_SYSTOLIC_RANGE = { min: 40, max: 260 }
export const BP_DIASTOLIC_RANGE = { min: 20, max: 160 }

/** The vitals picker, in display order. `bp` is the paired special case: its
 * `loinc` is the systolic code and the form emits a second diastolic event. */
export const VITALS: VitalDef[] = [
  {
    key: 'bp',
    label: 'Blood pressure',
    loinc: BP_SYSTOLIC,
    units: [{ unit: MMHG, ...BP_SYSTOLIC_RANGE }],
    decimals: 0,
  },
  {
    key: 'hr',
    label: 'Heart rate',
    loinc: loinc('8867-4', 'Heart rate'),
    units: [{ unit: ucum('/min'), min: 20, max: 260 }],
    decimals: 0,
  },
  {
    key: 'weight',
    label: 'Weight',
    loinc: loinc('29463-7', 'Body weight'),
    units: [
      { unit: ucum('kg'), min: 1, max: 400 },
      { unit: ucum('[lb_av]'), min: 2, max: 880 },
    ],
    decimals: 1,
  },
  {
    key: 'temp',
    label: 'Temperature',
    loinc: loinc('8310-5', 'Body temperature'),
    units: [
      { unit: ucum('Cel'), min: 30, max: 45 },
      { unit: ucum('[degF]'), min: 86, max: 113 },
    ],
    decimals: 1,
  },
  {
    key: 'spo2',
    label: 'SpO2',
    loinc: loinc('59408-5', 'Oxygen saturation in Arterial blood by Pulse oximetry'),
    units: [{ unit: ucum('%'), min: 50, max: 100 }],
    decimals: 0,
  },
  {
    key: 'height',
    label: 'Height',
    loinc: loinc('8302-2', 'Body height'),
    units: [{ unit: ucum('cm'), min: 30, max: 250 }],
    decimals: 1,
  },
  {
    key: 'glucose',
    label: 'Glucose',
    loinc: loinc('15074-8', 'Glucose [Moles/volume] in Blood'),
    units: [
      { unit: ucum('mmol/L'), min: 1, max: 35 },
      { unit: ucum('mg/dL'), min: 20, max: 630 },
    ],
    decimals: 1,
  },
]

/** Every LOINC code that classifies an observation as a vital — includes the
 * diastolic code, which has no VITALS entry of its own. */
export const VITAL_LOINC_CODES: ReadonlySet<string> = new Set([
  BP_DIASTOLIC.code,
  ...VITALS.map((v) => v.loinc.code),
])

// --- symptoms ---

export interface SymptomDef {
  key: string
  label: string
  snomed: Code
}

/** Starter set of common self-reported symptoms; free text covers the rest. */
export const SYMPTOMS: SymptomDef[] = [
  { key: 'headache', label: 'Headache', snomed: snomed('25064002', 'Headache') },
  { key: 'fatigue', label: 'Fatigue', snomed: snomed('84229001', 'Fatigue') },
  { key: 'nausea', label: 'Nausea', snomed: snomed('422587007', 'Nausea') },
  { key: 'dizziness', label: 'Dizziness', snomed: snomed('404640003', 'Dizziness') },
  { key: 'abdominal-pain', label: 'Abdominal pain', snomed: snomed('21522001', 'Abdominal pain') },
  { key: 'joint-pain', label: 'Joint pain', snomed: snomed('57676002', 'Joint pain') },
  { key: 'back-pain', label: 'Back pain', snomed: snomed('22253000', 'Back pain') },
  { key: 'anxiety', label: 'Anxiety', snomed: snomed('48694002', 'Anxiety') },
  { key: 'insomnia', label: 'Insomnia', snomed: snomed('193462001', 'Insomnia') },
  { key: 'bloating', label: 'Bloating', snomed: snomed('116289008', 'Abdominal bloating') },
  { key: 'itching', label: 'Itching', snomed: snomed('418290006', 'Itching') },
  { key: 'palpitations', label: 'Palpitations', snomed: snomed('80313002', 'Palpitations') },
  {
    key: 'short-of-breath',
    label: 'Shortness of breath',
    snomed: snomed('267036007', 'Dyspnea'),
  },
  { key: 'muscle-cramp', label: 'Muscle cramp', snomed: snomed('55300003', 'Muscle cramp') },
  { key: 'rash', label: 'Rash', snomed: snomed('271807003', 'Eruption of skin') },
]

// --- exercise ---

export const EXERCISE_ACTIVITY = loinc('73985-4', 'Exercise activity')
export const EXERCISE_DURATION = loinc('55411-3', 'Exercise duration')
export const MINUTES = ucum('min')

// --- mindfulness ---

export const MOOD = svastha('mood', 'Mood')
export const MOOD_NOTE = svastha('mood-note', 'Mood note')
export const GRATITUDE = svastha('gratitude', 'Gratitude')
