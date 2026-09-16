import { Redirect } from "expo-router/build/link/Redirect";

export default function IndexRoute() {
  return <Redirect href="/login" />;
}
