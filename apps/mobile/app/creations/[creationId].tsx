import { useLocalSearchParams } from "expo-router";
import { CreationDetailScreen } from "@/features/create/creation-detail-screen";

export default function CreationDetailRoute() {
  const { creationId } = useLocalSearchParams<{ creationId: string }>();
  return <CreationDetailScreen creationId={creationId} />;
}
