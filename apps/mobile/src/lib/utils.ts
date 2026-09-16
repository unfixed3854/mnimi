import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        "text-eyebrow",
        "text-body",
        "text-caption",
        "text-title",
        "text-hero",
      ],
      "text-color": [
        "text-background",
        "text-surface",
        "text-surface-muted",
        "text-foreground",
        "text-muted-foreground",
        "text-border",
        "text-primary",
        "text-primary-foreground",
        "text-primary-soft",
        "text-primary-soft-strong",
        "text-destructive",
        "text-destructive-foreground",
        "text-destructive-soft",
        "text-focus",
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
