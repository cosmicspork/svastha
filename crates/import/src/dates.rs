//! HL7 v3 `TS` (timestamp) values, as found in C-CDA `effectiveTime/@value`,
//! converted to ISO-8601.

/// An HL7 timestamp that isn't a run of 4/6/8/10/12/14 digits (optionally with
/// a trailing decimal fraction and/or a `±ZZZZ` offset).
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("malformed HL7 timestamp: {0:?}")]
pub struct DateError(pub String);

/// Convert an HL7 v3 `TS` value to ISO-8601, preserving the source's precision
/// **exactly** — never padding to a full timestamp, never truncating a real
/// one. This determinism is not just cosmetic: the returned string becomes
/// part of an event's canonical content (`crates/core/src/event.rs`), so
/// re-importing the same document must reproduce byte-identical output, or
/// the same fact would silently mint a different event id every import.
///
/// Precision is preserved by length: `YYYY` -> `YYYY`, `YYYYMM` -> `YYYY-MM`,
/// `YYYYMMDD` -> `YYYY-MM-DD`, and `YYYYMMDD[HH[MM[SS]]]` -> the matching
/// `YYYY-MM-DDTHH:MM:SS` prefix. A trailing `±ZZZZ` offset (only meaningful
/// once a time component is present) becomes `±ZZ:ZZ`; its absence in the
/// source means no offset in the output, not an assumed UTC/local zone.
pub fn hl7_ts_to_iso(ts: &str) -> Result<String, DateError> {
    let ts = ts.trim();
    let bad = || DateError(ts.to_string());

    let (body, offset) = split_offset(ts);
    // Fractional seconds (e.g. "...12.500") are rarer than whole seconds in
    // C-CDA effectiveTime and aren't part of any documented precision level
    // here; drop them rather than fail on well-formed input we don't need.
    let digits = body.split('.').next().unwrap_or(body);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad());
    }

    match digits.len() {
        4 => Ok(digits.to_string()),
        6 => Ok(format!("{}-{}", &digits[0..4], &digits[4..6])),
        8 => Ok(format!(
            "{}-{}-{}",
            &digits[0..4],
            &digits[4..6],
            &digits[6..8]
        )),
        10 | 12 | 14 => {
            let date = format!("{}-{}-{}", &digits[0..4], &digits[4..6], &digits[6..8]);
            let hh = &digits[8..10];
            let mm = if digits.len() >= 12 {
                &digits[10..12]
            } else {
                "00"
            };
            let ss = if digits.len() >= 14 {
                &digits[12..14]
            } else {
                "00"
            };
            let mut out = format!("{date}T{hh}:{mm}:{ss}");
            if let Some((sign, ohh, omm)) = offset {
                out.push_str(sign);
                out.push_str(ohh);
                out.push(':');
                out.push_str(omm);
            }
            Ok(out)
        }
        _ => Err(bad()),
    }
}

/// Split a trailing `±ZZZZ` (sign + 4 digits) off the end, if present. Returns
/// the sign as a `&str` so it drops straight into the output without a
/// separate `char` -> `&str` conversion.
fn split_offset(ts: &str) -> (&str, Option<(&str, &str, &str)>) {
    if ts.len() >= 5 {
        let idx = ts.len() - 5;
        let candidate = &ts[idx..];
        let sign = candidate.as_bytes()[0];
        if (sign == b'+' || sign == b'-') && candidate[1..].bytes().all(|b| b.is_ascii_digit()) {
            return (
                &ts[..idx],
                Some((&candidate[0..1], &candidate[1..3], &candidate[3..5])),
            );
        }
    }
    (ts, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn date_only() {
        assert_eq!(hl7_ts_to_iso("20230615").unwrap(), "2023-06-15");
    }

    #[test]
    fn month_precision_passes_through() {
        assert_eq!(hl7_ts_to_iso("202306").unwrap(), "2023-06");
    }

    #[test]
    fn year_precision_passes_through() {
        assert_eq!(hl7_ts_to_iso("2023").unwrap(), "2023");
    }

    #[test]
    fn full_datetime_with_offset() {
        assert_eq!(
            hl7_ts_to_iso("20230615143022-0500").unwrap(),
            "2023-06-15T14:30:22-05:00"
        );
    }

    #[test]
    fn full_datetime_with_positive_offset() {
        assert_eq!(
            hl7_ts_to_iso("20230615143022+0530").unwrap(),
            "2023-06-15T14:30:22+05:30"
        );
    }

    #[test]
    fn full_datetime_no_offset() {
        // No offset in the source means no offset in the output — never an
        // assumed zone.
        assert_eq!(
            hl7_ts_to_iso("20230615143022").unwrap(),
            "2023-06-15T14:30:22"
        );
    }

    #[test]
    fn hour_minute_precision_no_seconds() {
        assert_eq!(
            hl7_ts_to_iso("202306151430").unwrap(),
            "2023-06-15T14:30:00"
        );
    }

    #[test]
    fn hour_only_precision() {
        assert_eq!(hl7_ts_to_iso("2023061514").unwrap(), "2023-06-15T14:00:00");
    }

    #[test]
    fn fractional_seconds_are_dropped() {
        assert_eq!(
            hl7_ts_to_iso("20230615143022.500-0500").unwrap(),
            "2023-06-15T14:30:22-05:00"
        );
    }

    #[test]
    fn rejects_non_digit_garbage() {
        assert!(hl7_ts_to_iso("not-a-date").is_err());
    }

    #[test]
    fn rejects_odd_length_runs() {
        assert!(hl7_ts_to_iso("202306159").is_err());
    }

    #[test]
    fn rejects_empty_string() {
        assert!(hl7_ts_to_iso("").is_err());
    }
}
