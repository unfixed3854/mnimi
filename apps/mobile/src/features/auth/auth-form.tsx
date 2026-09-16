import { useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { AuthError } from "@/auth/auth-error";
import { AuthErrorAlert } from "@/features/auth/auth-error-alert";
import { signIn, signUp } from "@/auth/auth";
import { TextField } from "@/components/text-field";
import { Button, ButtonText } from "@/components/ui/button";
import { nativeColors } from "@/theme/native-colors";

export function AuthForm(
  { mode, onSuccess }: { mode: "signin" | "signup"; onSuccess?: () => void },
) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<AuthError | null>(null);
  const [pending, setPending] = useState(false);
  const isSignUp = mode === "signup";

  async function submit() {
    if (pending) return;
    if (!email.trim() || !password) {
      setError(new AuthError("Check your details", "Email and password are required."));
      return;
    }
    if (isSignUp && password !== confirmPassword) {
      setError(new AuthError("Check your details", "Passwords do not match."));
      return;
    }
    setPending(true);
    setError(null);
    try {
      if (isSignUp) await signUp(email.trim(), password);
      else await signIn(email.trim(), password);
      onSuccess?.();
    } catch (cause) {
      // Inputs intentionally stay controlled by this component after failure.
      const title = isSignUp ? "Couldn't create your account" : "Couldn't sign you in";
      setError(cause instanceof AuthError ? cause : new AuthError(
        title,
        cause instanceof Error ? cause.message : "Please try again.",
      ));
    } finally {
      setPending(false);
    }
  }

  return (
    <View className="gap-md">
      <TextField
        label="Email"
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextField
        label="Password"
        autoComplete={isSignUp ? "new-password" : "current-password"}
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />
      {isSignUp
        ? (
          <TextField
            label="Confirm password"
            autoComplete="new-password"
            secureTextEntry
            value={confirmPassword}
            onChangeText={setConfirmPassword}
          />
        )
        : null}
      {error ? <AuthErrorAlert error={error} /> : null}
      <Button
        accessibilityLabel={isSignUp ? "Create account" : "Sign in"}
        accessibilityState={{ busy: pending, disabled: pending }}
        disabled={pending}
        onPress={() => void submit()}
      >
        {pending
          ? <ActivityIndicator color={nativeColors.primaryForeground} />
          : null}
        <ButtonText>{isSignUp ? "Create account" : "Sign in"}</ButtonText>
      </Button>
    </View>
  );
}
