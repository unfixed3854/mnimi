import * as React from "react";
import { Text as NativeText, type TextProps } from "react-native";
import { cn } from "@/lib/utils";

type Props = TextProps & {
  className?: string;
};

const Text = React.forwardRef<React.ComponentRef<typeof NativeText>, Props>(
  ({ className, ...props }, ref) => (
    <NativeText
      ref={ref}
      className={cn("text-body text-foreground", className)}
      {...props}
    />
  ),
);

Text.displayName = "Text";

export { Text };
export type { Props as TextProps };
