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

/// Decode bounds for one page. Three of them, and each catches something the
/// others do not.
///
/// The per-edge limit is the *strict* one — the crate enforces it inside the
/// decoder, from the header, before anything is allocated. There were none, so
/// a page declaring 60000 × 60000 was believed all the way to `into_rgb8` asking
/// for ten gigabytes on a node several households may share. 12000 px an edge is
/// past any real page: 600 dpi of a twenty-inch scan.
///
/// The allocation ceiling is what the decoder is allowed to reserve. It is
/// best-effort — some decoders ignore it — and it stops accounting the moment
/// the decoder is done, which is the hole [`PEAK_BYTES_PER_PIXEL`] and
/// [`MAX_PAGE_PIXELS`] exist to close. It is stated here rather than left to the
/// crate default so it cannot drift under us.
///
/// Reading is serial (one page at a time, per owner), so these bound the node's
/// peak rather than being a per-page tax that multiplies.
const MAX_PAGE_DIMENSION: u32 = 12_000;
const MAX_PAGE_ALLOC: u64 = 512 * 1024 * 1024;

/// The most bytes one pixel can occupy at the peak of a read, which is *not*
/// what [`MAX_PAGE_ALLOC`] bounds.
///
/// `image::Limits` accounts for what the decoder allocates. `decode()` hands
/// back a `DynamicImage` in the file's own colour type, and `into_rgb8()` then
/// allocates the RGB buffer while that first one is still alive — after the
/// decoder is finished, so outside its accounting entirely. A compressed
/// 12000 × 12000 *grayscale* page is only 144 MiB of decoded data and passes
/// the allocation limit comfortably, then asks for another 412 MiB to convert:
/// 556 MiB at the peak, past the ceiling this claims to hold.
///
/// So the peak is both buffers at once. The widest `DynamicImage` variant is
/// `Rgba32F` at 16 bytes a pixel (reachable: the `exr` and `hdr` decoders are
/// on by default), plus 3 for the RGB conversion held alongside it.
const PEAK_BYTES_PER_PIXEL: u64 = 16 + 3;

/// Total pixels one page may have — *derived* from the ceiling rather than
/// picked, so the two cannot drift apart (`the_pixel_budget_honours_the_ceiling`
/// pins that). Roughly 28 megapixels.
///
/// This is the bound that actually bites; [`MAX_PAGE_DIMENSION`] stays as the
/// strict per-edge check the decoder itself enforces, which is what stops an
/// absurd single dimension cheaply, from the header. 28 MP is a 400 dpi
/// letter-page scan with room to spare and every phone capture short of the
/// 48-megapixel sensors; a page over it fails onto the unreadable path, which
/// the OCR pass backs off from — a visible, recoverable outcome, rather than
/// taking a node several households share down with it.
const MAX_PAGE_PIXELS: u64 = MAX_PAGE_ALLOC / PEAK_BYTES_PER_PIXEL;

/// The ceiling is a claim about peak memory, so it has to hold arithmetically:
/// the decoded buffer and the RGB one held at once, at the largest page the
/// budget admits, still fit under it. Asserted at compile time rather than in a
/// test — a change to any of the three that breaks the claim should not build.
const _: () = assert!(MAX_PAGE_PIXELS * PEAK_BYTES_PER_PIXEL <= MAX_PAGE_ALLOC);

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
        let image = decode_page(bytes, page_limits(), MAX_PAGE_PIXELS)?;
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

/// Decode one page's bytes to RGB under `limits` and a `max_pixels` budget. A
/// page that exceeds either fails on the same path as a corrupt one: from the
/// caller's side it is a page that could not be read, which the OCR pass already
/// knows how to back off from.
fn decode_page(bytes: &[u8], limits: image::Limits, max_pixels: u64) -> Result<image::RgbImage> {
    let reader = |limits: image::Limits| -> Result<_> {
        let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
            .with_guessed_format()
            .context("could not decode this page as an image")?;
        reader.limits(limits);
        Ok(reader)
    };

    // Read the declared size from the header and budget against it *before*
    // decoding, because the conversion below allocates outside anything
    // `Limits` accounts for — see PEAK_BYTES_PER_PIXEL.
    let (width, height) = reader(limits.clone())?
        .into_dimensions()
        .context("could not decode this page as an image")?;
    if u64::from(width) * u64::from(height) > max_pixels {
        return Err(image::ImageError::Limits(
            image::error::LimitError::from_kind(image::error::LimitErrorKind::DimensionError),
        ))
        .context("could not decode this page as an image");
    }

    Ok(reader(limits)?
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

    /// A real RGB PNG of the given size. One pixel tall keeps it cheap: the
    /// point is the size the *header* declares, which is what the bounds check.
    fn png(width: u32, height: u32) -> Vec<u8> {
        encode(image::RgbImage::new(width, height).into())
    }

    /// A real grayscale PNG — one byte a pixel decoded, three after the RGB
    /// conversion the reader needs. The colour type is the whole point: it is
    /// the cheap-to-decode, expensive-to-convert case the budget is sized for.
    fn gray_png(width: u32, height: u32) -> Vec<u8> {
        encode(image::GrayImage::new(width, height).into())
    }

    fn encode(image: image::DynamicImage) -> Vec<u8> {
        let mut out = std::io::Cursor::new(Vec::new());
        image
            .write_to(&mut out, image::ImageFormat::Png)
            .expect("encode png");
        out.into_inner()
    }

    fn is_limit_error(err: &anyhow::Error) -> bool {
        matches!(
            err.downcast_ref::<image::ImageError>(),
            Some(image::ImageError::Limits(_))
        )
    }

    #[test]
    fn a_page_past_the_dimension_limit_is_refused_rather_than_allocated() {
        let oversized = png(MAX_PAGE_DIMENSION + 1, 1);
        // Matched rather than `expect_err`: the Ok side is a whole decoded
        // page, and panicking on it would dump the pixels into the output.
        let Err(err) = decode_page(&oversized, page_limits(), MAX_PAGE_PIXELS) else {
            panic!("an oversized page must be refused, not decoded");
        };
        assert!(
            is_limit_error(&err),
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
        assert!(decode_page(&oversized, image::Limits::no_limits(), u64::MAX).is_ok());
    }

    /// The case the per-edge limit alone lets through. This page is inside every
    /// dimension bound and only 1 byte a pixel to decode, so the allocation
    /// limit sees nothing wrong with it — and then the RGB conversion asks for
    /// three times as much again, on top of a buffer still held.
    #[test]
    fn a_grayscale_page_within_the_dimension_limits_is_refused_on_total_pixels() {
        let height = (MAX_PAGE_PIXELS / u64::from(MAX_PAGE_DIMENSION)) as u32 + 1;
        assert!(
            height < MAX_PAGE_DIMENSION,
            "must be inside the per-edge bound"
        );

        let page = gray_png(MAX_PAGE_DIMENSION, height);
        let Err(err) = decode_page(&page, page_limits(), MAX_PAGE_PIXELS) else {
            panic!("a page over the pixel budget must be refused");
        };
        assert!(is_limit_error(&err), "got: {err:#}");
        assert!(
            format!("{err:#}").contains("could not decode this page"),
            "got: {err:#}"
        );

        // Nothing but the budget rejects it: the allocation limit alone lets it
        // straight through, which is the hole this closes.
        let mut alloc_only = image::Limits::no_limits();
        alloc_only.max_alloc = Some(MAX_PAGE_ALLOC);
        assert!(
            decode_page(&page, alloc_only, u64::MAX).is_ok(),
            "the allocation ceiling does not see the conversion coming"
        );
    }

    #[test]
    fn a_page_the_size_of_a_real_scan_still_reads() {
        assert!(decode_page(&png(1200, 1600), page_limits(), MAX_PAGE_PIXELS).is_ok());
        // Grayscale reaches the reader as RGB, converted.
        let read = decode_page(&gray_png(1200, 1600), page_limits(), MAX_PAGE_PIXELS)
            .expect("a grayscale scan is a page like any other");
        assert_eq!(read.dimensions(), (1200, 1600));
    }

    #[test]
    fn a_corrupt_page_is_an_error_not_a_panic() {
        let Err(err) = decode_page(b"not an image at all", page_limits(), MAX_PAGE_PIXELS) else {
            panic!("garbage bytes are not a page");
        };
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
