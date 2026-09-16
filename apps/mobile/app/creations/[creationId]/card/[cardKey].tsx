import { useLocalSearchParams } from "expo-router";
import { CreationCardEditorScreen } from "@/features/create/creation-card-editor-screen";

export default function CreationCardEditorRoute() {
  const { creationId, cardKey } = useLocalSearchParams<{
    creationId: string;
    cardKey: string;
  }>();
  return <CreationCardEditorScreen creationId={creationId} cardKey={cardKey} />;
}
