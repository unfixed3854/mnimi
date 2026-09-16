import { NavigationBar } from "expo-navigation-bar";
import { StatusBar } from "react-native";

export function SystemBars() {
  return (
    <>
      <StatusBar barStyle="dark-content" />
      <NavigationBar style="dark" />
    </>
  );
}
