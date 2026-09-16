import { Fragment } from "react";
import { View } from "react-native";
import type { CreationSummary } from "@/api/creations";
import { ListRow } from "@/components/list-row";
import { SectionHeader } from "@/components/section-header";
import { Text } from "@/components/ui/text";

const GROUPS: Array<{
  group: CreationSummary["group"];
  title: string;
}> = [
  { group: "needsChoice", title: "Needs your choice" },
  { group: "ready", title: "Ready to review" },
  { group: "creating", title: "Creating" },
  { group: "queued", title: "Queued" },
  { group: "failed", title: "Needs attention" },
];

function excerpt(text: string): string {
  const compact = text.trim().replace(/\s+/g, " ");
  return compact.length > 100 ? `${compact.slice(0, 97)}…` : compact;
}

export function CreationInbox({
  creations,
  retry,
  loading,
}: {
  creations: CreationSummary[];
  retry: (clientRequestId: string) => Promise<void>;
  loading: boolean;
}) {
  if (loading) {
    return <Text className="text-body text-muted-foreground">Loading creations…</Text>;
  }
  if (creations.length === 0) {
    return null;
  }
  return (
    <View className="gap-lg">
      {GROUPS.map(({ group, title }) => {
        const rows = creations.filter((creation) => creation.group === group);
        if (rows.length === 0) return null;
        return (
          <View className="gap-sm" key={group}>
            <SectionHeader title={title} />
            <View className="overflow-hidden rounded-md border border-border bg-surface">
              {rows.map((creation, index) => {
                const local = creation.id.startsWith("outbox:");
                const description = [creation.deckName, creation.stateLabel]
                  .filter(Boolean).join(" · ");
                return (
                  <Fragment key={creation.id}>
                    <ListRow
                      title={excerpt(creation.sourceText)}
                      description={description}
                      leadingIcon={creation.thumbnailId
                        ? "image-outline"
                        : "sparkles-outline"}
                      href={local
                        ? undefined
                        : {
                          pathname: "/creations/[creationId]",
                          params: { creationId: creation.id },
                        }}
                      onPress={local
                        ? () => creation.group === "failed"
                          ? retry(creation.clientRequestId)
                          : undefined
                        : undefined}
                    />
                    {index < rows.length - 1
                      ? <View className="h-px bg-border" />
                      : null}
                  </Fragment>
                );
              })}
            </View>
          </View>
        );
      })}
    </View>
  );
}
