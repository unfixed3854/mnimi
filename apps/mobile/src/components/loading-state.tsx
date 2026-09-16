import { View } from "react-native";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

type LoadingLayout = "today" | "decks" | "notes" | "deck" | "note" | "review" | "creation" | "editor" | "registration";

function ListSkeleton({ icons = false }: { icons?: boolean }) {
  return (
    <View className="overflow-hidden rounded-md border border-border bg-surface">
      {["w-3/5", "w-2/5", "w-1/2"].map((width, index) => (
        <View key={width}>
          {index > 0 ? <View className="h-px bg-border" /> : null}
          <View className="min-h-[56px] flex-row items-center gap-md px-md py-sm">
            {icons ? <Skeleton className="h-[22px] w-[22px] rounded-full" /> : null}
            <View className="flex-1">
              <Skeleton className={`h-4 ${width}`} />
            </View>
            <Skeleton className="h-4 w-3" />
          </View>
        </View>
      ))}
    </View>
  );
}

function CardSkeleton() {
  return (
    <Card className="gap-md">
      <Skeleton className="h-3 w-1/4" />
      <Skeleton className="h-5 w-4/5" />
      <Skeleton className="h-5 w-3/5" />
    </Card>
  );
}

function LoadingContent({ layout }: { layout: LoadingLayout }) {
  switch (layout) {
    case "today":
      return (
        <View className="gap-sm">
          <Skeleton className="h-[64px] w-24" />
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-12 w-full" />
        </View>
      );
    case "decks":
      return <ListSkeleton icons />;
    case "notes":
      return <ListSkeleton />;
    case "deck":
      return (
        <View className="gap-md">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="mt-lg h-14 w-full" />
          <View className="mt-xl gap-md">
            <Skeleton className="h-6 w-20" />
            <ListSkeleton />
          </View>
        </View>
      );
    case "review":
      return (
        <View className="gap-md">
          <Skeleton className="h-4 w-32" />
          <View className="mt-lg gap-lg">
            <Card className="items-center gap-md rounded-lg p-xl">
              <Skeleton className="h-6 w-4/5" />
              <Skeleton className="h-6 w-3/5" />
            </Card>
            <Skeleton className="h-12 w-full" />
          </View>
        </View>
      );
    case "registration":
    case "editor":
      return (
        <View className={layout === "editor" ? "gap-md rounded-lg border border-border bg-surface p-md" : "gap-md"}>
          {[0, 1, 2].map((field) => (
            <View key={field} className="gap-xs">
              <Skeleton className="h-4 w-28" />
              <Skeleton className={layout === "editor" && field < 2 ? "h-24 w-full" : "h-12 w-full"} />
            </View>
          ))}
          {layout === "registration" ? <Skeleton className="h-12 w-full" /> : null}
        </View>
      );
    case "creation":
      return (
        <View className="gap-md">
          <Skeleton className="h-4 w-32" />
          <CardSkeleton />
          <CardSkeleton />
        </View>
      );
    case "note":
      return (
        <View className="gap-md">
          <View className="mt-xl gap-sm">
            <Skeleton className="h-6 w-20" />
            <Skeleton className="h-6 w-3/5" />
          </View>
          <View className="mt-xl gap-md">
            <Skeleton className="h-6 w-20" />
            <CardSkeleton />
            <CardSkeleton />
          </View>
        </View>
      );
  }
}

export function LoadingState({ label = "Loading", layout = "note" }: {
  label?: string;
  layout?: LoadingLayout;
}) {
  return (
    <View
      accessible
      accessibilityLabel={label}
      accessibilityRole="progressbar"
      accessibilityState={{ busy: true }}
      className="w-full"
    >
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden pointerEvents="none">
        <LoadingContent layout={layout} />
      </View>
    </View>
  );
}
