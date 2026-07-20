import sharp from 'sharp';

/**
 * Automatically knock out a logo's background so it sits cleanly over a photo or
 * video hero, then trim it tight so it's "properly placed" with no dead margin.
 *
 * This is deliberately the SAFE, offline version — a colour-key from the corners, not
 * an AI matte:
 *
 *  - Restaurant logos are overwhelmingly a mark on a SOLID background (white, or a
 *    flat brand colour). Sampling the four corners tells us that background colour,
 *    and every pixel close to it becomes transparent. That handles the real-world
 *    case (the boxed-white-logo-over-a-food-photo problem) with no external service.
 *  - When the corners are NOT uniform, the background is a photograph or gradient, or
 *    the image already has transparency — anything an AI would be needed for — and we
 *    return null and keep the original untouched rather than punching holes in it.
 *
 * Returns a PNG buffer when it changed something, or null to mean "leave the upload
 * exactly as it was".
 */
export async function autoKnockoutLogo(input: Buffer): Promise<Buffer | null> {
  let raw: { data: Buffer; info: sharp.OutputInfo };
  try {
    raw = await sharp(input)
      // Bound the work and normalise to RGBA. A wordmark doesn't need 4000px.
      .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    // Not an image sharp can decode (svg without raster, corrupt, etc.) — leave it.
    return null;
  }

  const { data, info } = raw;
  const { width, height, channels } = info;
  if (channels !== 4 || width < 2 || height < 2) return null;

  const at = (x: number, y: number) => {
    const i = (y * width + x) * channels;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]] as const;
  };
  const corners = [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)];

  // Already has transparent corners → someone already removed the background.
  if (corners.some((c) => c[3] < 250)) return null;

  // How uniform are the corners? If they disagree, it's not a flat backdrop.
  const avg = [0, 1, 2].map((k) => corners.reduce((s, c) => s + c[k], 0) / 4);
  const spread = Math.max(...corners.flatMap((c) => [0, 1, 2].map((k) => Math.abs(c[k] - avg[k]))));
  if (spread > 26) return null;

  // Colour-key: everything within tolerance of the corner colour goes transparent.
  const tol = 44;
  const tol2 = tol * tol;
  let cleared = 0;
  const total = width * height;
  for (let p = 0; p < total; p++) {
    const i = p * channels;
    const dr = data[i] - avg[0];
    const dg = data[i + 1] - avg[1];
    const db = data[i + 2] - avg[2];
    if (dr * dr + dg * dg + db * db <= tol2) {
      data[i + 3] = 0;
      cleared++;
    }
  }

  // If we cleared almost nothing (a logo that fills the frame) or almost everything
  // (a near-blank image), the knockout isn't helping — don't bother.
  const ratio = cleared / total;
  if (ratio < 0.02 || ratio > 0.97) return null;

  try {
    return await sharp(data, { raw: { width, height, channels } })
      .png()
      // Crop away the now-transparent border so the mark is placed tight and centred.
      .trim()
      .png()
      .toBuffer();
  } catch {
    return null;
  }
}
