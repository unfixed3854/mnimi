import { useEffect, useState } from "react";
import { Image, View } from "react-native";
import { createMediaResource, type MediaResource } from "@/lib/media-resource";
import { fetchAuthenticatedMedia, imageMediaPath } from "@/api/media";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

export type GeneratedImageStatus = "absent" | "loading" | "ready" | "error";

export function generatedImageClassName(className?: string): string {
  return cn("mb-lg h-48 w-48 self-center rounded-md", className);
}

/** Owns the downloaded private image for as long as it is displayed. */
export function GeneratedImage({ scope, id, present, alt, className, onStatusChange }: {
  scope: "notes" | "drafts";
  id: string;
  present: boolean;
  alt: string;
  className?: string;
  onStatusChange?: (status: GeneratedImageStatus) => void;
}) {
  const [uri, setUri] = useState<string | null>(null);
  const [status, setStatus] = useState<GeneratedImageStatus>(
    present ? "loading" : "absent",
  );
  useEffect(() => {
    let active = true;
    let resource: MediaResource | null = null;
    setUri(null);
    if (!present) {
      setStatus("absent");
      return;
    }
    setStatus("loading");
    void (async () => {
      try {
        const bytes = await fetchAuthenticatedMedia(imageMediaPath(scope, id));
        if (!active) return;
        resource = createMediaResource(bytes, `mnimi-image-${scope}-${id}.png`, "image/png");
        setUri(resource.uri);
      } catch {
        if (active) setStatus("error");
      }
    })();
    return () => {
      active = false;
      resource?.release();
    };
  }, [id, present, scope]);

  useEffect(() => {
    onStatusChange?.(status);
  }, [onStatusChange, status]);

  if (status === "absent" || status === "error") return null;
  return (
    <View className={cn("relative overflow-hidden", generatedImageClassName(className))}>
      {uri
        ? (
          <Image
            accessible={status === "ready"}
            aria-hidden={status !== "ready"}
            accessibilityLabel={alt}
            source={{ uri }}
            className="h-full w-full"
            onLoad={() => setStatus("ready")}
            onError={() => setStatus("error")}
          />
        )
        : null}
      {status === "loading"
        ? (
          <Skeleton
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel="Loading image"
            accessibilityState={{ busy: true }}
            className="absolute inset-0 rounded-none"
          />
        )
        : null}
    </View>
  );
}
