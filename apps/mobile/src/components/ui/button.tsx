import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import {
  Pressable,
  type PressableProps,
  Text as NativeText,
  type TextProps,
} from "react-native";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "flex-row items-center justify-center gap-sm rounded-md active:opacity-80 disabled:opacity-55",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        destructive: "bg-destructive text-destructive-foreground",
        secondary: "bg-[#EEEAE2] text-foreground",
        outline: "border border-border bg-surface text-foreground",
        tonal: "border border-primary/15 bg-primary-soft text-primary",
        selection: "border border-border bg-surface text-foreground",
        selected: "border border-2 border-primary bg-primary-soft text-primary",
        destructiveQuiet:
          "border border-destructive/30 bg-destructive-soft text-destructive",
        ghost: "text-foreground",
        link: "text-primary",
      },
      size: {
        default: "min-h-[48px] px-md",
        sm: "min-h-[48px] px-sm",
        lg: "min-h-[56px] px-lg",
        icon: "h-[48px] w-[48px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

const buttonTextVariants = cva("text-body font-semibold", {
  variants: {
    variant: {
      default: "text-primary-foreground",
      destructive: "text-destructive-foreground",
      secondary: "text-foreground",
      outline: "text-foreground",
      tonal: "text-primary",
      selection: "text-foreground",
      selected: "text-primary",
      destructiveQuiet: "text-destructive",
      ghost: "text-foreground",
      link: "text-primary underline",
    },
    size: {
      default: "text-body",
      sm: "text-caption",
      lg: "text-body",
      icon: "text-body",
    },
  },
  defaultVariants: {
    variant: "default",
    size: "default",
  },
});

const ButtonTextClassContext = React.createContext<string | undefined>(
  undefined,
);

type ButtonProps = PressableProps & VariantProps<typeof buttonVariants> & {
  className?: string;
};

const Button = React.forwardRef<
  React.ComponentRef<typeof Pressable>,
  ButtonProps
>(
  (
    {
      accessibilityRole,
      accessibilityState,
      className,
      disabled,
      size,
      variant,
      ...props
    },
    ref,
  ) => (
    <ButtonTextClassContext.Provider
      value={buttonTextVariants({ size, variant })}
    >
      <Pressable
        ref={ref}
        accessibilityRole={accessibilityRole ?? "button"}
        accessibilityState={{
          ...accessibilityState,
          selected: variant === "selected" || accessibilityState?.selected,
        }}
        className={cn(buttonVariants({ size, variant }), className)}
        disabled={disabled}
        {...props}
      />
    </ButtonTextClassContext.Provider>
  ),
);

Button.displayName = "Button";

type ButtonTextProps = TextProps & {
  className?: string;
};

const ButtonText = React.forwardRef<
  React.ComponentRef<typeof NativeText>,
  ButtonTextProps
>(
  ({ className, ...props }, ref) => {
    const buttonTextClassName = React.useContext(ButtonTextClassContext);

    return (
      <NativeText
        ref={ref}
        className={cn(buttonTextClassName, className)}
        {...props}
      />
    );
  },
);

ButtonText.displayName = "ButtonText";

export { Button, ButtonText, buttonTextVariants, buttonVariants };
export type { ButtonProps, ButtonTextProps };
