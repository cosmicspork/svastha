//! The prompt the model reads and the grounding that maps its reply back to real
//! event ids. This is the citation contract: [`ground`] can only ever return ids
//! drawn from the [`ContextItem`]s it was handed, so no model output can invent a
//! citation, however confidently it numbers one.

use serde::Deserialize;

use crate::ContextItem;

/// The honest reply text when an answer cannot be grounded (nothing retrieved, or
/// the model produced no usable citation). Sent with **empty** citations.
pub const CANT_ANSWER: &str =
    "I couldn't find anything in your record to answer that with a citation.";

/// System instruction: answer strictly from the numbered context, cite what you
/// used, and refuse rather than invent. Not a diagnostician.
pub const SYSTEM_PROMPT: &str = "\
You answer a person's questions using ONLY their own medical records, provided as \
a numbered context list. Draw every statement from that context and cite the item \
numbers you used. Do not diagnose, predict, infer, or add anything not present in \
the context. If the context does not contain the answer, say so plainly. Respond \
with a single JSON object and nothing else.";

/// The user prompt: the question and the numbered context, plus the exact output
/// schema. Numbering is 1-based and maps back to `context` positions in [`ground`].
pub fn build_prompt(question: &str, context: &[ContextItem]) -> String {
    let mut s = String::new();
    s.push_str("Question: ");
    s.push_str(question.trim());
    s.push_str("\n\nContext (numbered records from the person's own vault):\n");
    for (i, item) in context.iter().enumerate() {
        s.push_str(&format!("[{}] {}\n", i + 1, item.text));
    }
    s.push_str(
        "\nRespond with JSON of the form:\n\
         {\"answer\": \"<a plain-language answer drawn only from the context>\", \
         \"used\": [<the item numbers you drew from>]}\n\
         If the context does not answer the question, respond {\"answer\": \"\", \"used\": []}.",
    );
    s
}

/// The model's expected reply: a plain answer plus the 1-based context item
/// numbers it used.
#[derive(Debug, Default, Deserialize)]
struct ModelAnswer {
    #[serde(default)]
    answer: String,
    #[serde(default)]
    used: Vec<u32>,
}

/// Map a model answer back to grounded citations. Returns `(answer, citation_ids)`
/// where each id is the content id of a **supplied** context item (defensive: a
/// number out of range is dropped, duplicates collapse, order preserved). `None`
/// when the output is unparseable or the answer text is empty. The caller still
/// requires the citation list to be non-empty before sending.
pub fn ground(raw: &str, context: &[ContextItem]) -> Option<(String, Vec<String>)> {
    let parsed = parse_json_object::<ModelAnswer>(raw)?;
    let answer = parsed.answer.trim();
    if answer.is_empty() {
        return None;
    }
    let mut citations: Vec<String> = Vec::new();
    for n in parsed.used {
        // 1-based → 0-based; ignore anything outside the supplied context.
        let Some(idx) = (n as usize).checked_sub(1) else {
            continue;
        };
        if let Some(item) = context.get(idx) {
            if !citations.contains(&item.event_id) {
                citations.push(item.event_id.clone());
            }
        }
    }
    Some((answer.to_string(), citations))
}

/// Parse a JSON object out of a model answer, tolerating fenced/prose-wrapped
/// output: a clean parse first, then the substring from the first `{` to the
/// last `}`.
fn parse_json_object<T: for<'de> Deserialize<'de>>(answer: &str) -> Option<T> {
    if let Ok(v) = serde_json::from_str::<T>(answer.trim()) {
        return Some(v);
    }
    let start = answer.find('{')?;
    let end = answer.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str::<T>(&answer[start..=end]).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(ids: &[&str]) -> Vec<ContextItem> {
        ids.iter()
            .enumerate()
            .map(|(i, id)| ContextItem {
                event_id: id.to_string(),
                text: format!("item {i}"),
                score: 1.0,
            })
            .collect()
    }

    #[test]
    fn ground_maps_used_numbers_to_context_ids() {
        let context = ctx(&["aaa", "bbb", "ccc"]);
        let raw = r#"{"answer":"You take aaa and ccc.","used":[1,3]}"#;
        let (answer, cites) = ground(raw, &context).unwrap();
        assert_eq!(answer, "You take aaa and ccc.");
        assert_eq!(cites, vec!["aaa", "ccc"]);
    }

    #[test]
    fn ground_drops_out_of_range_and_dedupes() {
        let context = ctx(&["aaa", "bbb"]);
        // 9 is out of range; 1 repeats.
        let raw = r#"{"answer":"a","used":[1,1,9,0]}"#;
        let (_a, cites) = ground(raw, &context).unwrap();
        assert_eq!(
            cites,
            vec!["aaa"],
            "out-of-range/zero dropped, dupes collapsed"
        );
    }

    #[test]
    fn ground_rejects_empty_answer_and_garbage() {
        let context = ctx(&["aaa"]);
        assert!(ground(r#"{"answer":"","used":[1]}"#, &context).is_none());
        assert!(ground("I cannot read this", &context).is_none());
    }

    #[test]
    fn ground_tolerates_prose_wrapped_json() {
        let context = ctx(&["aaa", "bbb"]);
        let raw = "Sure!\n```json\n{\"answer\":\"ok\",\"used\":[2]}\n```\n";
        let (answer, cites) = ground(raw, &context).unwrap();
        assert_eq!(answer, "ok");
        assert_eq!(cites, vec!["bbb"]);
    }

    #[test]
    fn citations_are_always_a_subset_of_supplied_context() {
        // The model "cites" a number that is not in the two-item context; ground
        // yields no citation for it, so an answer citing only invented items is
        // reported with empty citations (the caller then sends can't-answer).
        let context = ctx(&["aaa", "bbb"]);
        let (_a, cites) = ground(r#"{"answer":"x","used":[5,6]}"#, &context).unwrap();
        assert!(cites.is_empty(), "no invented id can become a citation");
    }

    #[test]
    fn build_prompt_numbers_context_from_one() {
        let context = ctx(&["aaa", "bbb"]);
        let prompt = build_prompt("  what am i taking  ", &context);
        assert!(prompt.contains("Question: what am i taking"));
        assert!(prompt.contains("[1] item 0"));
        assert!(prompt.contains("[2] item 1"));
    }
}
