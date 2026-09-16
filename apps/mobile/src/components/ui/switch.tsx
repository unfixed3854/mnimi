import * as SwitchPrimitive from "@rn-primitives/switch";
import * as React from "react";
import { cn } from "@/lib/utils";

type SwitchProps = React.ComponentProps<typeof SwitchPrimitive.Root> & {
  className?: string;
};

/** React Native Reusables switch adapted to the app's semantic tokens. */
function Switch({ className, checked, disabled, ...props }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      checked={checked}
      className={cn(
        "h-6 w-11 flex-row items-center rounded-full border border-transparent p-xs",
        checked ? "bg-primary" : "bg-border",
        disabled ? "opacity-55" : "active:opacity-80",
        className,
      )}
      disabled={disabled}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "h-4 w-4 rounded-full bg-surface",
          checked ? "translate-x-5" : "translate-x-0",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
export type { SwitchProps };
