/** In-memory image cache keyed by URL.
 *
 * Character assets are served from an authenticated endpoint, so these cannot be
 * loaded by assigning a URL to `img.src` — a plain image load sends no
 * Authorization header and would come back 401. The bytes are fetched with the
 * token attached and handed to the image as an object URL instead.
 */

import { storage } from '../../utils/storage';

const cache = new Map<string, HTMLImageElement>();
const objectUrls = new Set<string>();

export async function getCachedImage(url: string): Promise<HTMLImageElement> {
  const cached = cache.get(url);
  if (cached) return cached;

  const token = storage.getToken();
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    throw new Error(`Failed to load image: ${url} (${response.status})`);
  }

  const objectUrl = URL.createObjectURL(await response.blob());
  objectUrls.add(objectUrl);

  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`Failed to decode image: ${url}`));
      image.src = objectUrl;
    });
    cache.set(url, img);
    return img;
  } catch (error) {
    // Nothing will reference this blob, so do not leak it.
    URL.revokeObjectURL(objectUrl);
    objectUrls.delete(objectUrl);
    throw error;
  }
}

export function clearImageCache(): void {
  cache.clear();
  for (const objectUrl of objectUrls) {
    URL.revokeObjectURL(objectUrl);
  }
  objectUrls.clear();
}
