import { Link } from "expo-router/build/link/Link";
import { Screen } from "@/components/screen";
import {
  ButtonText,
  buttonTextVariants,
  buttonVariants,
} from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import { AuthForm } from "@/features/auth/auth-form";
import { useRegistrationEnabled } from "@/features/auth/use-registration-enabled";

export default function LoginRoute() {
  const registrationEnabled = useRegistrationEnabled();

  return <LoginContent registrationEnabled={registrationEnabled} />;
}

export function LoginContent({
  registrationEnabled,
}: {
  registrationEnabled: boolean | null;
}) {
  return (
    <Screen>
      <PageHeader
        title="Sign in"
        subtitle="Continue your language practice."
      />
      <AuthForm mode="signin" />
      {registrationEnabled
        ? (
          <Link
            accessibilityRole="link"
            className={buttonVariants({ variant: "link" })}
            href="/signup"
          >
            <ButtonText className={buttonTextVariants({ variant: "link" })}>
              Create an account
            </ButtonText>
          </Link>
        )
        : null}
    </Screen>
  );
}
