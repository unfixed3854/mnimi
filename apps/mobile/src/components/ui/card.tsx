import * as React from "react";
import { View, type ViewProps } from "react-native";
import { cn } from "@/lib/utils";
import { Text, type TextProps } from "@/components/ui/text";

type CardProps = ViewProps & {
  className?: string;
};

const Card = React.forwardRef<React.ComponentRef<typeof View>, CardProps>(
  ({ className, ...props }, ref) => (
    <View
      ref={ref}
      className={cn(
        "gap-sm rounded-md border border-border bg-surface p-md",
        className,
      )}
      {...props}
    />
  ),
);

Card.displayName = "Card";

const CardHeader = React.forwardRef<React.ComponentRef<typeof View>, CardProps>(
  ({ className, ...props }, ref) => (
    <View ref={ref} className={cn("gap-xs", className)} {...props} />
  ),
);

CardHeader.displayName = "CardHeader";

const CardContent = React.forwardRef<
  React.ComponentRef<typeof View>,
  CardProps
>(
  ({ className, ...props }, ref) => (
    <View ref={ref} className={cn("gap-sm", className)} {...props} />
  ),
);

CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<React.ComponentRef<typeof View>, CardProps>(
  ({ className, ...props }, ref) => (
    <View
      ref={ref}
      className={cn("flex-row items-center gap-sm", className)}
      {...props}
    />
  ),
);

CardFooter.displayName = "CardFooter";

type CardTextProps = TextProps;

const CardTitle = React.forwardRef<
  React.ComponentRef<typeof Text>,
  CardTextProps
>(
  ({ className, ...props }, ref) => (
    <Text
      ref={ref}
      className={cn("text-body font-semibold text-foreground", className)}
      {...props}
    />
  ),
);

CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<
  React.ComponentRef<typeof Text>,
  CardTextProps
>(
  ({ className, ...props }, ref) => (
    <Text
      ref={ref}
      className={cn("text-caption text-muted-foreground", className)}
      {...props}
    />
  ),
);

CardDescription.displayName = "CardDescription";

export {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
};
export type { CardProps };
