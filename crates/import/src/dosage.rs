//! Building a core [`Dosage`] from what a C-CDA or FHIR medication states,
//! shared by both mappers.
//!
//! A source field is kept only if core would accept it, and is checked by
//! asking core itself (a one-field [`DosageFields`] through [`Dosage::new`])
//! rather than by a copy of its rules that could drift. A field that fails is
//! dropped on its own: an exponent in the period loses the schedule, not the
//! sig text beside it.

use svastha_core::event::{Dosage, DosageFields, PeriodUnit, Quantity};

/// The longest sig text kept, in characters. A real sig is a sentence; the
/// cap only stops a mis-pointed narrative reference (a whole table) from
/// being signed into the record as a "sig".
pub const MAX_SIG_CHARS: usize = 500;

/// A validated `frequency` per `period` `period_unit` triple.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Repeat {
    frequency: String,
    period: String,
    unit: PeriodUnit,
}

/// What a source stated, each field already validated. `None` everywhere a
/// field was absent or dropped.
#[derive(Debug, Default)]
pub struct Parts {
    pub dose: Option<Quantity>,
    pub text: Option<String>,
    pub repeat: Option<Repeat>,
    pub when: Option<String>,
    pub as_needed: Option<bool>,
}

/// The dosage for these parts, or `None` when the source said nothing about
/// how the medication is taken. A dose alone is not enough: that is today's
/// `quantity` value (C-CDA) or bare statement (FHIR), and turning it into a
/// dose-only dosage would move the id of every medication already imported.
pub fn finish(parts: Parts) -> Option<Dosage> {
    let Parts {
        dose,
        text,
        repeat,
        when,
        as_needed,
    } = parts;
    if text.is_none() && repeat.is_none() && when.is_none() && as_needed.is_none() {
        return None;
    }
    let (frequency, period, period_unit) = match repeat {
        Some(r) => (Some(r.frequency), Some(r.period), Some(r.unit)),
        None => (None, None, None),
    };
    // Every field passed core on its own, but `Dosage::new` stays the last
    // word: a refusal falls back to the caller's old shape, never an invalid
    // value.
    Dosage::new(DosageFields {
        dose,
        text,
        frequency,
        period,
        period_unit,
        when,
        as_needed,
    })
    .ok()
}

/// A sig as core will hold it: whitespace runs collapsed to one space, trimmed,
/// cut to [`MAX_SIG_CHARS`]; `None` if nothing is left.
pub fn sig_text(raw: &str) -> Option<String> {
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let capped: String = collapsed.chars().take(MAX_SIG_CHARS).collect();
    let capped = capped.trim_end();
    (!capped.is_empty()).then(|| capped.to_string())
}

/// The UCUM period units core carries. Matched exactly: `w` and `H` are not
/// UCUM, and `min`, `s`, and `a` have no place in core's closed set.
pub fn period_unit(ucum: &str) -> Option<PeriodUnit> {
    match ucum {
        "h" => Some(PeriodUnit::Hour),
        "d" => Some(PeriodUnit::Day),
        "wk" => Some(PeriodUnit::Week),
        "mo" => Some(PeriodUnit::Month),
        _ => None,
    }
}

/// `frequency` per `period` `unit`, if core accepts both literals and the
/// period is not zero. Core allows a `0` period (it is a well-formed decimal),
/// but "once every 0 hours" is not a schedule, so import drops it.
pub fn repeat(frequency: &str, period: &str, unit: PeriodUnit) -> Option<Repeat> {
    let accepted = Dosage::new(DosageFields {
        frequency: Some(frequency.to_string()),
        period: Some(period.to_string()),
        period_unit: Some(unit),
        ..Default::default()
    })
    .is_ok();
    let zero = period.bytes().all(|b| b == b'0' || b == b'.');
    (accepted && !zero).then(|| Repeat {
        frequency: frequency.to_string(),
        period: period.to_string(),
        unit,
    })
}

/// The dose, if core accepts its value literal (no sign, exponent, or leading
/// zero).
pub fn dose(q: Quantity) -> Option<Quantity> {
    Dosage::new(DosageFields {
        dose: Some(q.clone()),
        ..Default::default()
    })
    .is_ok()
    .then_some(q)
}

/// HL7 v3 TimingEvent codes, as FHIR R4's EventTiming value set includes them.
/// The v3 code system also has `IC`, `ICD`, `ICM`, and `ICV`; R4 leaves them
/// out, so they are left out here too, keeping every imported `when` one that
/// a FHIR export's `timing.repeat.when` can carry.
const V3_TIMING_EVENTS: &[&str] = &[
    "HS", "WAKE", "C", "CM", "CD", "CV", "AC", "ACM", "ACD", "ACV", "PC", "PCM", "PCD", "PCV",
];

/// FHIR's own event-timing codes, the rest of R4's EventTiming value set.
const FHIR_EVENT_TIMINGS: &[&str] = &[
    "MORN",
    "MORN.early",
    "MORN.late",
    "NOON",
    "AFT",
    "AFT.early",
    "AFT.late",
    "EVE",
    "EVE.early",
    "EVE.late",
    "NIGHT",
    "PHS",
];

/// A C-CDA `EIVL_TS` event code, kept verbatim if it is a known v3 code.
pub fn v3_when(code: &str) -> Option<String> {
    V3_TIMING_EVENTS.contains(&code).then(|| code.to_string())
}

/// A FHIR `timing.repeat.when` code, kept verbatim if it is in R4's
/// EventTiming value set (the v3 codes plus FHIR's own).
pub fn fhir_when(code: &str) -> Option<String> {
    (V3_TIMING_EVENTS.contains(&code) || FHIR_EVENT_TIMINGS.contains(&code))
        .then(|| code.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sig_text_collapses_trims_and_drops_blank() {
        assert_eq!(
            sig_text("  Take 1\n\ttablet   daily "),
            Some("Take 1 tablet daily".into())
        );
        assert_eq!(sig_text(" \n\t "), None);
        assert_eq!(sig_text(""), None);
    }

    #[test]
    fn sig_text_is_capped_on_a_char_boundary() {
        // Multi-byte characters, so a byte cap would split one.
        let long = "é".repeat(MAX_SIG_CHARS + 50);
        let capped = sig_text(&long).unwrap();
        assert_eq!(capped.chars().count(), MAX_SIG_CHARS);
        // A cut that lands after a space must not leave it trailing.
        let spaced = format!("{} tail", "a".repeat(MAX_SIG_CHARS - 1));
        assert_eq!(sig_text(&spaced).unwrap(), "a".repeat(MAX_SIG_CHARS - 1));
    }

    #[test]
    fn period_unit_maps_only_the_four_exact_ucum_names() {
        assert_eq!(period_unit("h"), Some(PeriodUnit::Hour));
        assert_eq!(period_unit("d"), Some(PeriodUnit::Day));
        assert_eq!(period_unit("wk"), Some(PeriodUnit::Week));
        assert_eq!(period_unit("mo"), Some(PeriodUnit::Month));
        for bad in ["min", "s", "a", "w", "H", "D", "hr", "", " h"] {
            assert_eq!(period_unit(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn repeat_refuses_what_core_refuses_and_a_zero_period() {
        assert!(repeat("1", "8", PeriodUnit::Hour).is_some());
        assert!(repeat("2", "0.5", PeriodUnit::Day).is_some());
        for (f, p) in [
            ("1", "1e1"),
            ("1", "-8"),
            ("1", "+8"),
            ("1", "08"),
            ("1", " 8"),
            ("1", "8."),
            ("0", "8"),
            ("1.5", "8"),
            ("01", "8"),
            ("1", "0"),
            ("1", "0.0"),
        ] {
            assert_eq!(repeat(f, p, PeriodUnit::Hour), None, "{f:?} per {p:?}");
        }
    }

    #[test]
    fn dose_refuses_exponents_signs_and_garbage() {
        let q = |v: &str| Quantity {
            value: v.into(),
            unit: None,
        };
        assert!(dose(q("0.5")).is_some());
        for bad in ["1e2", "-1", "+1", "01", ".5", "five", "", "1,000"] {
            assert_eq!(dose(q(bad)), None, "{bad:?}");
        }
    }

    #[test]
    fn when_codes_are_a_closed_list() {
        assert_eq!(v3_when("AC").as_deref(), Some("AC"));
        assert_eq!(v3_when("MORN"), None, "FHIR-only code in a v3 slot");
        assert_eq!(v3_when("IC"), None, "outside R4's EventTiming");
        assert_eq!(v3_when("ac"), None);
        assert_eq!(fhir_when("MORN.early").as_deref(), Some("MORN.early"));
        assert_eq!(fhir_when("HS").as_deref(), Some("HS"));
        assert_eq!(fhir_when("BEDTIME"), None);
    }

    #[test]
    fn finish_needs_more_than_a_dose() {
        let dose_only = Parts {
            dose: Some(Quantity {
                value: "10".into(),
                unit: None,
            }),
            ..Default::default()
        };
        assert!(finish(dose_only).is_none());
        assert!(finish(Parts::default()).is_none());
        let prn = Parts {
            as_needed: Some(true),
            ..Default::default()
        };
        assert_eq!(finish(prn).unwrap().fields().as_needed, Some(true));
    }
}
