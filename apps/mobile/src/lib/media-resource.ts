import { File, Paths } from "expo-file-system";

export type MediaResource = { uri: string; release: () => void };
let resourceId = 0;

/** Each consumer owns its cache file, even when showing the same media twice. */
export function createMediaResource(
  bytes: Uint8Array,
  filename: string,
  _contentType: string,
): MediaResource {
  const file = new File(Paths.cache, `${++resourceId}-${filename}`);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      file.delete();
    } catch { /* cache eviction is best effort */ }
  };
  try {
    file.write(bytes);
  } catch (error) {
    release();
    throw error;
  }
  return { uri: file.uri, release };
}
