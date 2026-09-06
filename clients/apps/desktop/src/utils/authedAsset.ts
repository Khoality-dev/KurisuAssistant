/** Load an authenticated asset for use in an <img> or <video> tag.
 *
 * Character assets are served from an authenticated endpoint. A browser image
 * load sends no Authorization header, so the bytes have to be fetched with the
 * token and handed over as an object URL.
 */

import { useEffect, useState } from 'react';
import { storage } from './storage';

export async function fetchAuthedObjectUrl(url: string): Promise<string> {
  const token = storage.getToken();
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    throw new Error(`Failed to load asset: ${url} (${response.status})`);
  }
  return URL.createObjectURL(await response.blob());
}

/**
 * Resolve `url` to a displayable object URL, revoking it when the URL changes
 * or the component unmounts. Returns null while loading or on failure.
 */
export function useAuthedAssetUrl(url: string | null): string | null {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!url) {
      setObjectUrl(null);
      return;
    }

    let cancelled = false;
    let created: string | null = null;

    fetchAuthedObjectUrl(url)
      .then((next) => {
        if (cancelled) {
          URL.revokeObjectURL(next);
          return;
        }
        created = next;
        setObjectUrl(next);
      })
      .catch(() => {
        if (!cancelled) setObjectUrl(null);
      });

    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [url]);

  return objectUrl;
}
