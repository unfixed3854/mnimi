import type { MediaResource } from "@/lib/media-resource";

/** Private bytes stay in memory and are released when their consumer leaves. */
export function createMediaResource(
  bytes: Uint8Array,
  _filename: string,
  contentType: string,
): MediaResource {
  const uri = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: contentType }));
  let released = false;
  return {
    uri,
    release() {
      if (released) return;
      released = true;
      URL.revokeObjectURL(uri);
    },
  };
}
