//! Stage A on the node: turning a captured page into text, in-process.
//!
//! The node used to send the page *image* to a vision model, which both read and
//! coded it in one pass — so nothing could check what it claimed. Now the page is
//! transcribed here and only the text is sent, which means every coded finding
//! must quote back the numbered line it came from (see
//! [`svastha_import::extract::parse_lines`]) or it is dropped. The page bytes no
//! longer leave the node at all.
//!
//! **Pure Rust, deliberately.** `crates/node/README.md` advertises a container
//! with no OpenSSL and no C toolchain; `ocrs` (with `rten` underneath) keeps that
//! true where a Tesseract binding would not.
//!
//! ## Why there is no column-aligned rendering here
//!
//! The browser assembles lines itself from positioned runs, so it renders a
//! column-aligned view to stop a lab panel's rows being read across each other.
//! `ocrs` groups words into lines from the page geometry before recognition, so
//! the lines this produces are already rows. Sending them numbered — and making
//! the extractor verify each finding against the line it cites — is the same
//! protection without a second copy of the layout code in a second language.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use ocrs::{ImageSource, OcrEngine, OcrEngineParams};
use rten::Model;

/// Where the recognition models live inside the image. Baked in at build time
/// (see `Dockerfile.node`) rather than fetched at boot: a node that downloads its
/// reader on first use is a node that phones out before it has read anything, and
/// one that cannot start when that host is down.
pub const DEFAULT_MODELS_DIR: &str = "/models";

const DETECTION_MODEL: &str = "text-detection.rten";
const RECOGNITION_MODEL: &str = "text-recognition.rten";

/// Decode bounds for one page.
///
/// `image` already defaults to a 512 MiB allocation ceiling, but that one is
/// best-effort and a decoder may ignore it; the *dimension* limits are the ones
/// the crate treats as strict, and there were none — so a page header declaring
/// 60000 × 60000 was believed all the way to `into_rgb8`, which then asked for
/// ten gigabytes on a node several households may share.
///
/// 12000 px an edge is past any real page — 600 dpi of a twenty-inch scan, and
/// a 108-megapixel phone photo is 12000 × 9000 — and 12000 × 12000 × 3 ≈ 412 MiB
/// of output sits under the allocation ceiling, so the two bounds agree instead
/// of one quietly making the other unreachable. Reading is serial (one page at a
/// time, per owner), so this is the node's peak rather than a per-page tax that
/// multiplies.
const MAX_PAGE_DIMENSION: u32 = 12_000;
const MAX_PAGE_ALLOC: u64 = 512 * 1024 * 1024;

/// Stage A as the OCR pass sees it.
///
/// A trait rather than a concrete type so the pass can be exercised without
/// model files — which matters more than usual here, since the recognizer itself
/// cannot be unit-tested: a stub reader lets every branch around it (empty page,
/// read failure, the source-line guard downstream) be covered anyway.
pub trait PageReader {
    /// Transcribe one page into its lines, top to bottom. Empty means nothing
    /// was recognized, which callers must treat as "couldn't read this page".
    fn transcribe(&self, bytes: &[u8]) -> Result<Vec<String>>;
}

/// The in-process page reader. Loading the models costs a few hundred milliseconds
/// and a chunk of memory, so a single instance is built once and reused for every
/// page — never per job.
pub struct Transcriber {
    engine: OcrEngine,
}

impl Transcriber {
    /// Load the detection and recognition models from `dir`.
    ///
    /// Fails loudly when they are absent. The alternative — starting and silently
    /// proposing nothing from every page — looks exactly like "these pages have
    /// nothing on them", which is the wrong thing for a record to conclude
    /// quietly.
    pub fn load(dir: &Path) -> Result<Self> {
        let detection = load_model(dir, DETECTION_MODEL)?;
        let recognition = load_model(dir, RECOGNITION_MODEL)?;
        let engine = OcrEngine::new(OcrEngineParams {
            detection_model: Some(detection),
            recognition_model: Some(recognition),
            ..Default::default()
        })
        .map_err(|e| anyhow!("could not start the page reader: {e}"))?;
        Ok(Self { engine })
    }

    /// Load from the configured directory, or [`DEFAULT_MODELS_DIR`].
    pub fn from_env() -> Result<Self> {
        let dir = std::env::var("SVASTHA_NODE_OCR_MODELS_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(DEFAULT_MODELS_DIR));
        Self::load(&dir)
    }

    fn read(&self, bytes: &[u8]) -> Result<Vec<String>> {
        let image = decode_page(bytes, page_limits())?;
        let source = ImageSource::from_bytes(image.as_raw(), image.dimensions())
            .map_err(|e| anyhow!("could not prepare this page for reading: {e}"))?;
        let input = self
            .engine
            .prepare_input(source)
            .map_err(|e| anyhow!("could not prepare this page for reading: {e}"))?;

        let words = self
            .engine
            .detect_words(&input)
            .map_err(|e| anyhow!("could not find text on this page: {e}"))?;
        let lines = self.engine.find_text_lines(&input, &words);
        let recognized = self
            .engine
            .recognize_text(&input, &lines)
            .map_err(|e| anyhow!("could not read the text on this page: {e}"))?;

        Ok(recognized
            .into_iter()
            .flatten()
            .map(|line| line.to_string().trim().to_string())
            .filter(|line| !line.is_empty())
            .collect())
    }
}

impl PageReader for Transcriber {
    fn transcribe(&self, bytes: &[u8]) -> Result<Vec<String>> {
        self.read(bytes)
    }
}

/// The bounds every page is decoded under. See [`MAX_PAGE_DIMENSION`].
fn page_limits() -> image::Limits {
    let mut limits = image::Limits::no_limits();
    limits.max_image_width = Some(MAX_PAGE_DIMENSION);
    limits.max_image_height = Some(MAX_PAGE_DIMENSION);
    limits.max_alloc = Some(MAX_PAGE_ALLOC);
    limits
}

/// Decode one page's bytes under `limits`. A page that exceeds them fails on the
/// same path as a corrupt one: from the caller's side it is a page that could
/// not be read, which the OCR pass already knows how to back off from.
fn decode_page(bytes: &[u8], limits: image::Limits) -> Result<image::RgbImage> {
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .context("could not decode this page as an image")?;
    reader.limits(limits);
    Ok(reader
        .decode()
        .context("could not decode this page as an image")?
        .into_rgb8())
}

fn load_model(dir: &Path, name: &str) -> Result<Model> {
    let path = dir.join(name);
    Model::load_file(&path).with_context(|| {
        format!(
            "could not load the page-reading model at {}",
            path.display()
        )
    })
}

/// The numbered transcript the extractor asks the model to cite against —
/// `[1] Sodium 139 mmol/L 135-145`, one row per line.
pub fn numbered(lines: &[String]) -> String {
    lines
        .iter()
        .enumerate()
        .map(|(i, line)| format!("[{}] {}", i + 1, line))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbering_is_one_based_and_matches_the_guard() {
        // `parse_lines` indexes `lines[source_line - 1]`, so a finding citing
        // line 2 must land on the second entry.
        let lines = vec!["Sodium 139".to_string(), "Potassium 4.1".to_string()];
        assert_eq!(numbered(&lines), "[1] Sodium 139\n[2] Potassium 4.1");
        assert_eq!(lines[2 - 1], "Potassium 4.1");
    }

    #[test]
    fn an_empty_transcript_numbers_to_nothing() {
        assert_eq!(numbered(&[]), "");
    }

    /// A real PNG of the given size. One pixel tall keeps it cheap: the point is
    /// the size the *header* declares, which is what the limits check.
    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut out = std::io::Cursor::new(Vec::new());
        image::RgbImage::new(width, height)
            .write_to(&mut out, image::ImageFormat::Png)
            .expect("encode png");
        out.into_inner()
    }

    #[test]
    fn a_page_past_the_dimension_limit_is_refused_rather_than_allocated() {
        let oversized = png(MAX_PAGE_DIMENSION + 1, 1);
        let err = decode_page(&oversized, page_limits())
            .expect_err("an oversized page must be refused, not decoded");
        assert!(
            matches!(
                err.downcast_ref::<image::ImageError>(),
                Some(image::ImageError::Limits(_))
            ),
            "must fail on the declared size before anything is allocated: {err:#}"
        );
        // ...and it reaches the caller as an unreadable page, which the OCR pass
        // already backs off from.
        assert!(
            format!("{err:#}").contains("could not decode this page"),
            "got: {err:#}"
        );
        // The same bytes decode without the bounds, so it is the limits doing
        // the refusing and not something else wrong with the fixture.
        assert!(decode_page(&oversized, image::Limits::no_limits()).is_ok());
    }

    #[test]
    fn a_page_the_size_of_a_real_scan_still_reads() {
        assert!(decode_page(&png(1200, 1600), page_limits()).is_ok());
    }

    #[test]
    fn a_corrupt_page_is_an_error_not_a_panic() {
        let err = decode_page(b"not an image at all", page_limits())
            .expect_err("garbage bytes are not a page");
        assert!(
            format!("{err:#}").contains("could not decode this page"),
            "got: {err:#}"
        );
    }

    #[test]
    fn missing_models_fail_loudly_rather_than_reading_nothing() {
        let Err(err) = Transcriber::load(Path::new("/nonexistent")) else {
            panic!("loading from a missing directory must fail");
        };
        assert!(
            format!("{err:#}").contains("page-reading model"),
            "got: {err:#}"
        );
    }
}
