//! Work history shared by both mappers: a job, its industry, and its
//! occupational hazards, as the one-event-per-component group the web summary
//! reads back (see "Concept key" in `docs/ARCHITECTURE.md`).
//!
//! The employer is deliberately not representable here. ODH carries it as an
//! extension or participant, and a signed record of where someone worked is
//! something the owner should add by choice, never something an import mints.

use svastha_core::event::{Code, EventKind, EventValue};

use crate::systems::LOINC;
use crate::{EventDraft, ImportResult};

pub const OCCUPATION: &str = "11341-5";
pub const INDUSTRY: &str = "86188-0";
pub const HAZARD: &str = "87729-0";

pub struct Job {
    pub value: EventValue,
    /// Verbatim from the source; shared by every event of the job, which is
    /// what ties its industry and hazards to it.
    pub start: Option<String>,
    pub industry: Option<EventValue>,
    pub hazards: Vec<String>,
}

fn loinc(code: &str, display: &str) -> Code {
    Code {
        system: LOINC.into(),
        code: code.into(),
        display: Some(display.into()),
    }
}

fn observation(code: Code, start: &Option<String>, value: EventValue) -> EventDraft {
    EventDraft {
        kind: EventKind::Observation,
        code: Some(code),
        effective_at: start.clone(),
        value: Some(value),
    }
}

/// Emit every job's events, and warn about the two cases where the timestamp
/// tie cannot hold. The importer reports them rather than inventing offsets:
/// the signed history must say what the source said.
pub fn flush(jobs: Vec<Job>, result: &mut ImportResult) {
    for (i, job) in jobs.iter().enumerate() {
        if job.start.is_none() && (job.industry.is_some() || !job.hazards.is_empty()) {
            result.warnings.push(
                "occupation without a start date: its industry and hazards cannot be tied to it \
                 and will show on their own"
                    .into(),
            );
        }
        if let Some(start) = &job.start {
            let shares = jobs
                .iter()
                .skip(i + 1)
                .any(|other| other.start.as_ref() == Some(start) && other.value != job.value);
            if shares {
                result.warnings.push(format!(
                    "two occupations start on {start}: their industry and hazards cannot be told \
                     apart and will show under both"
                ));
            }
        }
    }

    for job in jobs {
        result.events.push(observation(
            loinc(OCCUPATION, "History of Occupation"),
            &job.start,
            job.value,
        ));
        if let Some(industry) = job.industry {
            result.events.push(observation(
                loinc(INDUSTRY, "History of Occupation industry"),
                &job.start,
                industry,
            ));
        }
        for hazard in job.hazards {
            result.events.push(observation(
                loinc(HAZARD, "History of Occupational hazard"),
                &job.start,
                EventValue::Text(hazard),
            ));
        }
    }
}
