import { Redirect } from "expo-router";

// Keep the feature module out of production execution as well as navigation.
const DevtoolsScreen = __DEV__
  ? require("@/features/devtools/devtools-screen").DevtoolsScreen
  : null;

export default function DevtoolsRoute() {
  return DevtoolsScreen ? <DevtoolsScreen /> : <Redirect href="/settings" />;
}
