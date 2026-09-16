import { View } from "react-native";
import { Link } from "expo-router";
import { useDueCount } from "@/api/cards";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { LoadingState } from "@/components/loading-state";
import { PageHeader } from "@/components/page-header";
import { Screen, tabScreenSafeAreaEdges } from "@/components/screen";
import {
  Button,
  ButtonText,
  buttonTextVariants,
  buttonVariants,
} from "@/components/ui/button";
import { Text } from "@/components/ui/text";

export function TodayScreen() {
  const { data: dueCount, isLoading, isError, error } = useDueCount();
  const due = dueCount ?? 0;

  return (
    <Screen safeAreaEdges={tabScreenSafeAreaEdges}>
      <PageHeader title="Today" />
      <View className="flex-1 justify-center">
        {isLoading
          ? <LoadingState layout="today" label="Loading today" />
          : isError
          ? (
            <ErrorState
              message={error instanceof Error
                ? error.message
                : "Couldn't load what's due."}
            />
          )
          : due === 0
          ? (
            <EmptyState
              illustration="rest"
              title="You're all caught up"
              message="Nothing to review right now. A little breathing room for what you've learned."
              action={
                <Link
                  accessibilityLabel="Browse decks"
                  className={buttonVariants({ variant: "link" })}
                  href="/decks"
                >
                  <ButtonText className={buttonTextVariants({ variant: "link" })}>
                    Browse decks
                  </ButtonText>
                </Link>
              }
            />
          )
          : (
            <View className="gap-sm">
              <Text className="text-hero font-bold text-primary">
                {due}
              </Text>
              <Text className="text-body text-muted-foreground">
                {due === 1 ? "card due" : "cards due"}
              </Text>
              <Link
                asChild
                href="/review"
              >
                <Button accessibilityLabel="Start review">
                  <ButtonText>Start review</ButtonText>
                </Button>
              </Link>
            </View>
          )}
      </View>
    </Screen>
  );
}
