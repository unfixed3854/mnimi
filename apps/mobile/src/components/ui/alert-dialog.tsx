import * as AlertDialogPrimitive from "@rn-primitives/alert-dialog";
import * as React from "react";
import { View, type ViewProps } from "react-native";
import { cn } from "@/lib/utils";
import { Button, type ButtonProps } from "@/components/ui/button";
import { type TextProps } from "@/components/ui/text";

const AlertDialog = AlertDialogPrimitive.Root;
const AlertDialogTrigger = AlertDialogPrimitive.Trigger;
const AlertDialogPortal = AlertDialogPrimitive.Portal;

type AlertDialogOverlayProps =
  & React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Overlay>
  & {
    className?: string;
  };

const AlertDialogOverlay = React.forwardRef<
  React.ComponentRef<typeof View>,
  AlertDialogOverlayProps
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Overlay
    ref={ref}
    className={cn("absolute inset-0 bg-black/55", className)}
    {...props}
  />
));

AlertDialogOverlay.displayName = "AlertDialogOverlay";

type AlertDialogContentProps =
  & Omit<
    React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Content>,
    "className"
  >
  & {
    className?: string;
  };

const AlertDialogContent = React.forwardRef<
  React.ComponentRef<typeof AlertDialogPrimitive.Content>,
  AlertDialogContentProps
>(({ children, className, ...props }, ref) => (
  <AlertDialogPortal>
    <AlertDialogOverlay />
    <AlertDialogPrimitive.Content
      ref={ref}
      accessibilityViewIsModal
      className="absolute inset-0 items-center justify-center px-lg"
      {...props}
    >
      <View
        className={cn(
          "w-full max-w-[480px] rounded-lg bg-surface p-lg",
          className,
        )}
      >
        {children}
      </View>
    </AlertDialogPrimitive.Content>
  </AlertDialogPortal>
));

AlertDialogContent.displayName = "AlertDialogContent";

type AlertDialogHeaderProps = ViewProps & {
  className?: string;
};

const AlertDialogHeader = React.forwardRef<
  React.ComponentRef<typeof View>,
  AlertDialogHeaderProps
>(
  ({ className, ...props }, ref) => (
    <View ref={ref} className={cn("gap-xs", className)} {...props} />
  ),
);

AlertDialogHeader.displayName = "AlertDialogHeader";

const AlertDialogFooter = React.forwardRef<
  React.ComponentRef<typeof View>,
  AlertDialogHeaderProps
>(
  ({ className, ...props }, ref) => (
    <View
      ref={ref}
      className={cn("flex-row justify-end gap-sm", className)}
      {...props}
    />
  ),
);

AlertDialogFooter.displayName = "AlertDialogFooter";

type AlertDialogTitleProps = TextProps;

const AlertDialogTitle = React.forwardRef<
  React.ComponentRef<typeof AlertDialogPrimitive.Title>,
  AlertDialogTitleProps
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Title
    ref={ref}
    className={cn("text-body font-semibold text-foreground", className)}
    {...props}
  />
));

AlertDialogTitle.displayName = "AlertDialogTitle";

type AlertDialogDescriptionProps = TextProps;

const AlertDialogDescription = React.forwardRef<
  React.ComponentRef<typeof AlertDialogPrimitive.Description>,
  AlertDialogDescriptionProps
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Description
    ref={ref}
    className={cn("text-body text-muted-foreground", className)}
    {...props}
  />
));

AlertDialogDescription.displayName = "AlertDialogDescription";

type AlertDialogActionProps =
  & Omit<
    React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Action>,
    "asChild" | "className"
  >
  & Pick<ButtonProps, "className" | "size" | "variant">;

const AlertDialogAction = React.forwardRef<
  React.ComponentRef<typeof AlertDialogPrimitive.Action>,
  AlertDialogActionProps
>(({ children, className, size, variant = "default", ...props }, ref) => (
  <AlertDialogPrimitive.Action ref={ref} asChild {...props}>
    <Button className={className} size={size} variant={variant}>
      {children}
    </Button>
  </AlertDialogPrimitive.Action>
));

AlertDialogAction.displayName = "AlertDialogAction";

type AlertDialogCancelProps =
  & Omit<
    React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Cancel>,
    "asChild" | "className"
  >
  & Pick<ButtonProps, "className" | "size" | "variant">;

const AlertDialogCancel = React.forwardRef<
  React.ComponentRef<typeof AlertDialogPrimitive.Cancel>,
  AlertDialogCancelProps
>(({ children, className, size, variant = "outline", ...props }, ref) => (
  <AlertDialogPrimitive.Cancel ref={ref} asChild {...props}>
    <Button className={className} size={size} variant={variant}>
      {children}
    </Button>
  </AlertDialogPrimitive.Cancel>
));

AlertDialogCancel.displayName = "AlertDialogCancel";

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
};
