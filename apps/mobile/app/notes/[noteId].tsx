import { useLocalSearchParams } from "expo-router";
import { NoteScreen } from "@/features/notes/note-screen";

export default function NoteRoute() {
  const { noteId } = useLocalSearchParams<{ noteId: string }>();
  return <NoteScreen noteId={noteId} />;
}
