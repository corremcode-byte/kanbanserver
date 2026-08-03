import sharp from 'sharp';
import fs from 'fs/promises';
import path from 'path';
import { logger } from './logger';

// GIF is skipped — re-encoding to static WebP would drop animation. SVG is
// already tiny/vector and gains nothing from raster re-encoding.
const COMPRESSIBLE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/bmp',
]);

const MAX_DIMENSION = 1600;
const WEBP_QUALITY = 80;

/**
 * Re-encodes an uploaded image to WebP in place, mutating the multer File's
 * filename/path/mimetype/size/originalname so downstream code (which reads
 * those fields to build the stored attachment) picks up the compressed file
 * without any other changes. The pre-compression original is deleted — only
 * the reduced-size copy is kept on disk, since we intentionally don't want to
 * store both. Non-image files, animated GIFs, SVGs, and any compression
 * failure are left untouched — the original upload is never lost on error.
 */
export async function compressUploadedImage(file: Express.Multer.File): Promise<void> {
  if (!COMPRESSIBLE_MIME_TYPES.has(file.mimetype)) {
    return;
  }

  const originalPath = file.path;
  const webpPath = path.join(path.dirname(originalPath), `${path.parse(originalPath).name}.webp`);

  try {
    await sharp(originalPath)
      .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toFile(webpPath);

    const { size } = await fs.stat(webpPath);
    await fs.unlink(originalPath);

    file.filename = path.basename(webpPath);
    file.path = webpPath;
    file.mimetype = 'image/webp';
    file.size = size;
    file.originalname = `${path.parse(file.originalname).name}.webp`;

    logger.info(`🗜️ Compressed image ${path.basename(originalPath)} -> ${file.filename} (${size} bytes)`);
  } catch (error) {
    logger.warn(`Image compression failed for ${originalPath}, keeping original file: ${error instanceof Error ? error.message : error}`);
    // Best-effort cleanup of a partial webp file, if sharp got partway through
    await fs.unlink(webpPath).catch(() => {});
  }
}
