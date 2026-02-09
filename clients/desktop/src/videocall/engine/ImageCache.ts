/** In-memory image cache keyed by URL */
const cache = new Map<string, HTMLImageElement>();

export async function getCachedImage(url: string): Promise<HTMLImageElement> {
  const cached = cache.get(url);
  if (cached) return cached;

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      cache.set(url, img);
      resolve(img);
    };
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    img.src = url;
  });
}

export function clearImageCache(): void {
  cache.clear();
}
