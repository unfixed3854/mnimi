import { View } from "react-native";
import { Link, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { creationMutation } from "@/api/creations";
import { Screen, tabScreenSafeAreaEdges } from "@/components/screen";
import { useCreationOutbox } from "@/hooks/use-creation-outbox";
import { CreationInbox } from "@/features/create/creation-inbox";
import { RequestComposer } from "@/features/create/request-composer";
import { PrimaryButton } from "@/components/primary-button";
import { Text } from "@/components/ui/text";

export function CreateScreen() {
  const creation = useCreationOutbox();
  const params = useLocalSearchParams<{
    savedNoteId?: string;
    savedDeckName?: string;
    removedCreationId?: string;
  }>();
  const [restored, setRestored] = useState(false);
  const [restoreExpired, setRestoreExpired] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  useEffect(() => {
    if (!params.removedCreationId) return;
    const timer = setTimeout(() => setRestoreExpired(true), 10_000);
    return () => clearTimeout(timer);
  }, [params.removedCreationId]);
  return (
    <Screen safeAreaEdges={tabScreenSafeAreaEdges}>
      <View className="mt-lg gap-xl">
        {params.savedNoteId
          ? (
            <View className="gap-sm rounded-md border border-border bg-surface p-md">
              <Text className="text-body font-semibold">
                Saved to {params.savedDeckName ?? "your deck"}
              </Text>
              <Link
                href={{
                  pathname: "/notes/[noteId]",
                  params: { noteId: params.savedNoteId },
                }}
              >
                <Text className="text-body font-semibold text-primary">View note</Text>
              </Link>
            </View>
          )
          : null}
        {params.removedCreationId && !restored && !restoreExpired
          ? (
            <View className="flex-row items-center justify-between gap-md rounded-md border border-border bg-surface p-md">
              <Text className="text-body">Removed from queue</Text>
              <PrimaryButton
                variant="ghost"
                onPress={async () => {
                  try {
                    await creationMutation("restore", {
                      creationId: params.removedCreationId,
                    });
                    setRestored(true);
                    setRestoreError(null);
                  } catch {
                    setRestoreError("Couldn't restore this request. Try again now.");
                  }
                }}
              >
                Undo
              </PrimaryButton>
            </View>
          )
          : null}
        {restoreError
          ? <Text accessibilityRole="alert" className="text-caption text-destructive">{restoreError}</Text>
          : null}
        <RequestComposer
          actionableCount={creation.actionableCount}
          value={creation.composer}
          onChange={creation.setComposer}
          onSubmit={creation.submit}
          error={creation.validationError}
          ready={creation.ready}
        />
        <CreationInbox
          creations={creation.creations}
          retry={creation.retry}
          loading={creation.isLoading}
        />
      </View>
    </Screen>
  );
}
