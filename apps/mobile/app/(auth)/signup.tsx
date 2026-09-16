import { Link } from "expo-router/build/link/Link";
import { Screen } from "@/components/screen";
import {
  ButtonText,
  buttonTextVariants,
  buttonVariants,
} from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import { AuthForm } from "@/features/auth/auth-form";
import { EmptyState } from "@/components/empty-state";
import { LoadingState } from "@/components/loading-state";
import { useRegistrationEnabled } from "@/features/auth/use-registration-enabled";

export default function SignupRoute() {
  const registrationEnabled = useRegistrationEnabled();

  return <SignupContent registrationEnabled={registrationEnabled} />;
}

export function SignupContent({
  registrationEnabled,
}: {
  registrationEnabled: boolean | null;
}) {
  return (
    <Screen>
      <PageHeader
        title="Create an account"
        subtitle="Start building your practice habit."
      />
      {registrationEnabled === null
        ? <LoadingState layout="registration" label="Checking registration" />
        : registrationEnabled
        ? <AuthForm mode="signup" />
        : (
          <EmptyState
            illustration="locked"
            title="Registration is unavailable"
            message="New accounts cannot be created right now."
          />
        )}
      <Link
        accessibilityRole="link"
        className={buttonVariants({ variant: "link" })}
        href="/login"
      >
        <ButtonText className={buttonTextVariants({ variant: "link" })}>
          Already have an account? Sign in
        </ButtonText>
      </Link>
    </Screen>
  );
}
