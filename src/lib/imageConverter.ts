import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

/**
 * Converts any image (local upload, base64 data URL, or external URL) to WebP format.
 * Returns the updated .webp URL/path.
 */
export async function convertToWebP(imageUrl: string): Promise<string> {
  if (!imageUrl || typeof imageUrl !== 'string') {
    return imageUrl;
  }

  const trimmed = imageUrl.trim();

  // Already a WebP file?
  if (
    (trimmed.toLowerCase().endsWith('.webp') || trimmed.toLowerCase().includes('.webp?')) &&
    !trimmed.startsWith('data:')
  ) {
    return trimmed;
  }

  const articlesDir = path.join(process.cwd(), 'public', 'uploads', 'articles');
  if (!fs.existsSync(articlesDir)) {
    fs.mkdirSync(articlesDir, { recursive: true });
  }

  // Case 1: Base64 Data URL (data:image/...;base64,...)
  if (trimmed.startsWith('data:image/')) {
    try {
      const match = trimmed.match(/^data:image\/[a-zA-Z0-9+]+;base64,(.+)$/);
      const base64Data = match ? match[1] : trimmed.split(',')[1];
      if (base64Data) {
        const buffer = Buffer.from(base64Data, 'base64');
        const filename = `article_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.webp`;
        const filePath = path.join(articlesDir, filename);

        const webpBuffer = await sharp(buffer).webp({ quality: 85 }).toBuffer();
        try {
          await sharp(webpBuffer).toFile(filePath);
        } catch {}

        try {
          const { uploadToFolder } = await import('@/lib/b2Storage');
          const b2Url = await uploadToFolder('articles', filename, webpBuffer, 'image/webp');
          return b2Url;
        } catch (b2Err) {
          console.warn('[imageConverter] Backblaze B2 upload failed for base64, using local fallback:', b2Err);
          return `/uploads/articles/${filename}`;
        }
      }
    } catch (err) {
      console.error('[imageConverter] Failed to convert base64 image to webp:', err);
      return trimmed;
    }
  }

  // Case 2: Local uploaded file path (e.g. /uploads/articles/abc.jpg or uploads/articles/abc.png)
  if (trimmed.startsWith('/uploads/') || trimmed.startsWith('uploads/')) {
    try {
      const cleanRelativePath = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
      const fullDiskPath = path.join(process.cwd(), 'public', cleanRelativePath);

      const ext = path.extname(fullDiskPath);
      if (ext.toLowerCase() === '.webp') {
        return trimmed;
      }

      const baseDiskPath = fullDiskPath.slice(0, fullDiskPath.length - ext.length);
      const newDiskPath = `${baseDiskPath}.webp`;

      const basePublicPath = trimmed.slice(0, trimmed.length - ext.length);
      const newPublicUrl = `${basePublicPath}.webp`;

      // If the .webp file was already generated (e.g. earlier in the same publish call), return it
      if (fs.existsSync(newDiskPath)) {
        try {
          const { uploadToFolder } = await import('@/lib/b2Storage');
          const webpBuf = fs.readFileSync(newDiskPath);
          const b2Filename = path.basename(newDiskPath);
          return await uploadToFolder('articles', b2Filename, webpBuf, 'image/webp');
        } catch {
          return newPublicUrl;
        }
      }

      if (fs.existsSync(fullDiskPath)) {
        const webpBuffer = await sharp(fullDiskPath).webp({ quality: 85 }).toBuffer();
        await sharp(webpBuffer).toFile(newDiskPath);

        // Remove old non-webp file to keep disk tidy
        if (fs.existsSync(fullDiskPath) && fullDiskPath !== newDiskPath) {
          try {
            fs.unlinkSync(fullDiskPath);
          } catch (unlinkErr) {
            console.warn('[imageConverter] Could not delete original image file:', unlinkErr);
          }
        }

        try {
          const { uploadToFolder } = await import('@/lib/b2Storage');
          const b2Filename = path.basename(newDiskPath);
          const b2Url = await uploadToFolder('articles', b2Filename, webpBuffer, 'image/webp');
          return b2Url;
        } catch (b2Err) {
          console.warn('[imageConverter] Backblaze B2 upload failed for local file, using local fallback:', b2Err);
          return newPublicUrl;
        }
      }
    } catch (err) {
      console.error('[imageConverter] Failed to convert local file to webp:', err);
      return trimmed;
    }
  }

  // Case 3: External image URL (http:// or https://)
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    // If already hosted on our Backblaze bucket, return as is
    if (trimmed.includes('backblazeb2.com') && (trimmed.endsWith('.webp') || trimmed.includes('.webp?'))) {
      return trimmed;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 7000);
      const res = await fetch(trimmed, { signal: controller.signal });
      clearTimeout(timeout);

      if (res.ok) {
        const arrayBuf = await res.arrayBuffer();
        const buffer = Buffer.from(arrayBuf);
        const filename = `article_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.webp`;
        const filePath = path.join(articlesDir, filename);

        const webpBuffer = await sharp(buffer).webp({ quality: 85 }).toBuffer();
        try {
          await sharp(webpBuffer).toFile(filePath);
        } catch {}

        try {
          const { uploadToFolder } = await import('@/lib/b2Storage');
          const b2Url = await uploadToFolder('articles', filename, webpBuffer, 'image/webp');
          return b2Url;
        } catch (b2Err) {
          console.warn('[imageConverter] Backblaze B2 upload failed for external URL, using local fallback:', b2Err);
          return `/uploads/articles/${filename}`;
        }
      }
    } catch (err) {
      console.warn('[imageConverter] Could not fetch/convert external image to webp, keeping original URL:', err);
      return trimmed;
    }
  }

  return trimmed;
}

/**
 * Scans article HTML content and converts all embedded <img> src attributes to WebP.
 */
export async function convertArticleContentImagesToWebP(htmlContent: string): Promise<string> {
  if (!htmlContent || typeof htmlContent !== 'string') {
    return htmlContent;
  }

  // Match all img tags with src
  const imgRegex = /<img\s+([^>]*?)src=["']([^"']+)["']([^>]*?)>/gi;
  const matches: { fullMatch: string; src: string; pre: string; post: string }[] = [];

  let match: RegExpExecArray | null;
  while ((match = imgRegex.exec(htmlContent)) !== null) {
    matches.push({
      fullMatch: match[0],
      pre: match[1],
      src: match[2],
      post: match[3],
    });
  }

  if (matches.length === 0) {
    return htmlContent;
  }

  let updatedContent = htmlContent;

  for (const item of matches) {
    if (
      (item.src.toLowerCase().endsWith('.webp') || item.src.toLowerCase().includes('.webp?')) &&
      !item.src.startsWith('data:')
    ) {
      continue;
    }

    try {
      const webpUrl = await convertToWebP(item.src);
      if (webpUrl && webpUrl !== item.src) {
        // Replace exact src in this img tag
        const newImgTag = `<img ${item.pre}src="${webpUrl}"${item.post}>`;
        updatedContent = updatedContent.replace(item.fullMatch, newImgTag);
      }
    } catch (err) {
      console.warn('[imageConverter] Error converting content image to webp:', err);
    }
  }

  return updatedContent;
}

/**
 * Processes an article object on publish/approval, converting lead image and content images to WebP.
 */
export async function processArticleImagesForPublish(article: {
  image?: string;
  content?: string;
}): Promise<{
  image?: string;
  content?: string;
}> {
  let convertedImage = article.image;
  let convertedContent = article.content;

  if (article.image) {
    convertedImage = await convertToWebP(article.image);
  }

  if (article.content) {
    convertedContent = await convertArticleContentImagesToWebP(article.content);
  }

  return {
    image: convertedImage,
    content: convertedContent,
  };
}
