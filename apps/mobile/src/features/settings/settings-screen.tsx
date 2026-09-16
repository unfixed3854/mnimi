import { useRef, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import {
  signOut,
  updateAiInstructions,
  updateNativeLanguage,
  updateTtsAutoplay,
} from "@/auth/auth";
import { useSession } from "@/auth/session-store";
import { ListRow } from "@/components/list-row";
import { PageHeader } from "@/components/page-header";
import { PrimaryButton } from "@/components/primary-button";
import { Screen, tabScreenSafeAreaEdges } from "@/components/screen";
import { SelectionDialog } from "@/components/selection-dialog";
import { SectionHeader } from "@/components/section-header";
import { TextField } from "@/components/text-field";
import { nativeColors } from "@/theme/native-colors";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";

const languages = [
  { code: "en", label: "English" },
  { code: "pl", label: "Polski" },
  { code: "de", label: "Deutsch" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
];

export function SettingsScreen(
  { onSignedOut }: { onSignedOut?: () => void } = {},
) {
  const session = useSession();
  const savingLanguage = useRef(false);
  const savingAutoplay = useRef(false);
  const savingAiInstructions = useRef(false);
  const [language, setLanguage] = useState(
    session?.user.nativeLanguage ?? "en",
  );
  const [autoplay, setAutoplay] = useState(session?.user.ttsAutoplay ?? true);
  const [aiInstructions, setAiInstructions] = useState(
    session?.user.aiInstructions ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [languagePickerOpen, setLanguagePickerOpen] = useState(false);
  async function saveLanguage(next: string) {
    if (savingLanguage.current || !session) return;
    savingLanguage.current = true;
    setBusy(true);
    setLanguage(next);
    setError(null);
    try {
      await updateNativeLanguage(next);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to update language",
      );
    } finally {
      savingLanguage.current = false;
      setBusy(false);
    }
  }
  async function saveAutoplay(next: boolean) {
    if (savingAutoplay.current || !session) return;
    savingAutoplay.current = true;
    setBusy(true);
    setAutoplay(next);
    setError(null);
    try {
      await updateTtsAutoplay(next);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to update autoplay",
      );
    } finally {
      savingAutoplay.current = false;
      setBusy(false);
    }
  }
  async function saveAiInstructions() {
    if (savingAiInstructions.current || !session) return;
    savingAiInstructions.current = true;
    setBusy(true);
    setError(null);
    try {
      await updateAiInstructions(aiInstructions);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Failed to update AI instructions",
      );
    } finally {
      savingAiInstructions.current = false;
      setBusy(false);
    }
  }
  async function leave() {
    setBusy(true);
    setSigningOut(true);
    setError(null);
    try {
      await signOut();
      onSignedOut?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign out failed");
    } finally {
      setBusy(false);
      setSigningOut(false);
    }
  }
  const selectedLanguage =
    languages.find((item) => item.code === language)?.label ?? language;
  return (
    <Screen safeAreaEdges={tabScreenSafeAreaEdges}>
      <PageHeader title="Settings" />
      <View className="gap-md">
        <SectionHeader title="Preferences" />
        <View className="overflow-hidden rounded-md border border-border bg-surface">
          <ListRow
            accessibilityLabel={`Native language: ${selectedLanguage}`}
            accessibilityState={{ disabled: busy || !session, busy }}
            disabled={busy || !session}
            leadingIcon="language-outline"
            onPress={() => {
              if (!busy && session) setLanguagePickerOpen(true);
            }}
            title="Native language"
            trailing={
              <Text className="text-muted-foreground">{selectedLanguage}</Text>
            }
          />
          <View className="h-px bg-border" />
          <ListRow
            description="Play pronunciation when an answer is revealed."
            leadingIcon="volume-high-outline"
            showChevron={false}
            title="Autoplay pronunciation"
            trailing={
              <Switch
                accessibilityLabel="Autoplay pronunciation"
                checked={autoplay}
                disabled={busy || !session}
                onCheckedChange={(next) => void saveAutoplay(next)}
              />
            }
          />
        </View>
      </View>
      <View className="gap-sm">
        <SectionHeader title="AI" />
        <TextField
          editable={!busy && !!session}
          label="Custom AI instructions"
          multiline
          numberOfLines={4}
          onChangeText={setAiInstructions}
          placeholder="For example, prefer everyday example sentences."
          style={{ minHeight: 112, textAlignVertical: "top" }}
          value={aiInstructions}
        />
        <Text className="text-caption text-muted-foreground">
          Used when AI generates or adjusts flashcards.
        </Text>
        <PrimaryButton
          disabled={busy || !session}
          onPress={saveAiInstructions}
        >
          Save AI instructions
        </PrimaryButton>
      </View>
      <SelectionDialog
        onOpenChange={setLanguagePickerOpen}
        onValueChange={(next) => void saveLanguage(next)}
        open={languagePickerOpen}
        options={languages.map((item) => ({
          label: item.label,
          value: item.code,
        }))}
        overlayTestID="language-select-overlay"
        title="Choose native language"
        value={language}
      />
      <View className="gap-md">
        <SectionHeader title="Account" />
        <View className="overflow-hidden rounded-md border border-border bg-surface">
          <ListRow
            leadingIcon="person-circle-outline"
            title={session?.user.email ?? "—"}
            description="Signed in"
          />
          <View className="h-px bg-border" />
          <ListRow
            leadingIcon="log-out-outline"
            title="Sign out"
            disabled={busy}
            accessibilityState={{ disabled: busy, busy }}
            showChevron={false}
            onPress={() => void leave()}
            trailing={signingOut ? <ActivityIndicator accessibilityLabel="Signing out" color={nativeColors.primary} /> : undefined}
          />
        </View>
      </View>
      {__DEV__
        ? (
          <View className="overflow-hidden rounded-md border border-border bg-surface">
            <ListRow
              leadingIcon="code-slash-outline"
              title="Development tools"
              onPress={() => require("expo-router").router.push("/devtools")}
            />
          </View>
        )
        : null}
      {error
        ? (
          <Text
            accessibilityRole="alert"
            className="text-caption text-destructive"
          >
            {error}
          </Text>
        )
        : null}
    </Screen>
  );
}
