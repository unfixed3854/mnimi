import * as DialogPrimitive from "@rn-primitives/dialog";
import * as React from "react";
import { View, type ViewProps } from "react-native";
import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;
const DialogClose = DialogPrimitive.Close;
const DialogPortal = DialogPrimitive.Portal;
const DialogTrigger = DialogPrimitive.Trigger;

type DialogOverlayProps = React.ComponentProps<
  typeof DialogPrimitive.Overlay
> & {
  className?: string;
};

const DialogOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  DialogOverlayProps
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn("absolute inset-0 items-center justify-center bg-black/40 p-md", className)}
    {...props}
  />
));

DialogOverlay.displayName = "DialogOverlay";

type DialogContentProps = React.ComponentProps<
  typeof DialogPrimitive.Content
> & {
  className?: string;
  overlayTestID?: string;
};

const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(({ children, className, overlayTestID, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay testID={overlayTestID}>
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "w-full max-w-[480px] gap-md rounded-lg bg-surface p-lg",
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogOverlay>
  </DialogPortal>
));

DialogContent.displayName = "DialogContent";

type DialogHeaderProps = ViewProps & {
  className?: string;
};

const DialogHeader = React.forwardRef<
  React.ComponentRef<typeof View>,
  DialogHeaderProps
>(({ className, ...props }, ref) => (
  <View ref={ref} className={cn("gap-xs", className)} {...props} />
));

DialogHeader.displayName = "DialogHeader";

const DialogFooter = React.forwardRef<
  React.ComponentRef<typeof View>,
  DialogHeaderProps
>(({ className, ...props }, ref) => (
  <View ref={ref} className={cn("gap-sm", className)} {...props} />
));

DialogFooter.displayName = "DialogFooter";

type DialogTitleProps = React.ComponentProps<typeof DialogPrimitive.Title> & {
  className?: string;
};

const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  DialogTitleProps
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-body font-semibold text-foreground", className)}
    {...props}
  />
));

DialogTitle.displayName = "DialogTitle";

type DialogDescriptionProps = React.ComponentProps<
  typeof DialogPrimitive.Description
> & {
  className?: string;
};

const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  DialogDescriptionProps
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-body text-muted-foreground", className)}
    {...props}
  />
));

DialogDescription.displayName = "DialogDescription";

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
