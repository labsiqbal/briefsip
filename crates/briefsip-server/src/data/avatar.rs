use crate::web::Failure;
use crate::AppState;
use image::ImageDecoder;
use rusqlite::Connection;
use std::io::Cursor;
use std::sync::atomic::{AtomicUsize, Ordering};

static ACTIVE: AtomicUsize = AtomicUsize::new(0);

#[derive(Default)]
pub struct Prepared {
    input: Option<Vec<u8>>,
    output: Option<Vec<u8>>,
}
impl Prepared {
    pub fn get(&mut self, input: Option<Vec<u8>>) -> Result<Option<Vec<u8>>, Failure> {
        let Some(bytes) = input else {
            return Ok(None);
        };
        if let Some(output) = &self.output {
            return Ok(Some(output.clone()));
        }
        self.input = Some(bytes);
        Err(Failure::storage())
    }
}
struct Slot;
impl Drop for Slot {
    fn drop(&mut self) {
        ACTIVE.fetch_sub(1, Ordering::Release);
    }
}
async fn decode(bytes: Vec<u8>) -> Result<Vec<u8>, Failure> {
    if ACTIVE
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
            (n < 2).then_some(n + 1)
        })
        .is_err()
    {
        return Err(Failure::new(
            429,
            "avatar_busy",
            "Image processing is busy. Try again.",
        ));
    }
    let slot = Slot;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    let task = tokio::task::spawn_blocking(move || {
        let _slot = slot;
        normalize(&bytes, deadline)
    });
    tokio::time::timeout(std::time::Duration::from_secs(3), task)
        .await
        .map_err(|_| failed())?
        .map_err(|_| failed())?
}
fn failed() -> Failure {
    Failure::new(
        400,
        "invalid_avatar",
        "Cannot read the image. Use a static PNG, JPEG, or WebP up to 16 megapixels.",
    )
}
fn normalize(bytes: &[u8], deadline: std::time::Instant) -> Result<Vec<u8>, Failure> {
    let failed = || {
        Failure::new(
            400,
            "invalid_avatar",
            "Cannot read the image. Use a static PNG, JPEG, or WebP up to 16 megapixels.",
        )
    };
    let reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| failed())?;
    let format = image::guess_format(bytes).map_err(|_| failed())?;
    if !matches!(
        format,
        image::ImageFormat::Png | image::ImageFormat::Jpeg | image::ImageFormat::WebP
    ) {
        return Err(failed());
    }
    let mut decoder = reader.into_decoder().map_err(|_| failed())?;
    let orientation = decoder.orientation().map_err(|_| failed())?;
    let profile = decoder.icc_profile().map_err(|_| failed())?;
    if u64::from(decoder.dimensions().0) * u64::from(decoder.dimensions().1) > 16 * 1024 * 1024 {
        return Err(failed());
    }
    if format == image::ImageFormat::WebP
        && image::codecs::webp::WebPDecoder::new(Cursor::new(bytes))
            .map_err(|_| failed())?
            .has_animation()
    {
        return Err(failed());
    }
    let mut image = image::DynamicImage::from_decoder(decoder).map_err(|_| failed())?;
    if std::time::Instant::now() >= deadline {
        return Err(failed());
    }
    if let Some(profile_bytes) = profile {
        let profile = moxcms::ColorProfile::new_from_slice(&profile_bytes).map_err(|_| failed())?;
        let mut rgba = image.to_rgba8();
        let transform = profile
            .create_transform_8bit(
                moxcms::Layout::Rgba,
                &moxcms::ColorProfile::new_srgb(),
                moxcms::Layout::Rgba,
                moxcms::TransformOptions::default(),
            )
            .map_err(|_| failed())?;
        let mut output = vec![0; rgba.len()];
        let stride = rgba.width() as usize * 4;
        for (src, dst) in rgba
            .chunks_exact(stride)
            .zip(output.chunks_exact_mut(stride))
        {
            if std::time::Instant::now() >= deadline {
                return Err(failed());
            }
            transform.transform(src, dst).map_err(|_| failed())?;
        }
        rgba.as_mut().copy_from_slice(&output);
        image = if image.has_alpha() {
            image::DynamicImage::ImageRgba8(rgba)
        } else {
            image::DynamicImage::ImageRgb8(image::DynamicImage::ImageRgba8(rgba).to_rgb8())
        };
    }
    image.apply_orientation(orientation);
    let scale = 256.0 / f64::from(image.width().min(image.height()));
    let width = (f64::from(image.width()) * scale).round() as u32;
    let height = (f64::from(image.height()) * scale).round() as u32;
    let alpha = matches!(
        image.color(),
        image::ColorType::Rgba8
            | image::ColorType::Rgba16
            | image::ColorType::La8
            | image::ColorType::La16
    );
    let mut rgba = image.to_rgba32f();
    if alpha {
        for pixel in rgba.pixels_mut() {
            for c in 0..3 {
                pixel[c] *= pixel[3];
            }
        }
    }
    let mut resized =
        image::imageops::resize(&rgba, width, height, image::imageops::FilterType::Lanczos3);
    if alpha {
        for pixel in resized.pixels_mut() {
            if pixel[3] > 0.0 {
                for c in 0..3 {
                    pixel[c] = (pixel[c] / pixel[3]).clamp(0.0, 1.0);
                }
            }
        }
    }
    let cropped = image::imageops::crop_imm(
        &resized,
        (width - 256).div_ceil(2),
        (height - 256).div_ceil(2),
        256,
        256,
    )
    .to_image();
    let resized = if alpha {
        image::DynamicImage::ImageRgba8(image::DynamicImage::ImageRgba32F(cropped).to_rgba8())
    } else {
        image::DynamicImage::ImageRgb8(image::DynamicImage::ImageRgba32F(cropped).to_rgb8())
    };
    let mut output = Vec::new();
    resized
        .write_to(&mut Cursor::new(&mut output), image::ImageFormat::Png)
        .map_err(|_| failed())?;
    if std::time::Instant::now() >= deadline {
        return Err(failed());
    }
    Ok(output)
}
pub async fn run<T>(
    state: &AppState,
    mut work: impl FnMut(&Connection, &mut Prepared) -> Result<T, Failure>,
) -> Result<T, Failure> {
    let mut prepared = Prepared::default();
    let result = {
        let guard = state.database.lock().map_err(|_| Failure::storage())?;
        work(&guard.connection, &mut prepared)
    };
    let Some(input) = prepared.input.take() else {
        return result;
    };
    prepared.output = Some(decode(input).await?);
    let guard = state.database.lock().map_err(|_| Failure::storage())?;
    work(&guard.connection, &mut prepared)
}
