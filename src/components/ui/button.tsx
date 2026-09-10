import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "~/lib/utils";

// The marker preserves legacy contextual layout (including frozen consumers).
// plain keeps navigation, list options and unadorned actions at their old size.
const styled =
  "button inline-flex items-center justify-center gap-[7px] rounded-[7px] border border-transparent whitespace-nowrap transition-[background] duration-150";
const buttonVariants = cva(
  "cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2! focus-visible:outline-ring! focus-visible:outline-offset-[3px]!",
  {
    variants: {
      variant: {
        default: `${styled} bg-primary text-primary-foreground! shadow-[0_2px_4px_color-mix(in_srgb,var(--primary)_10%,transparent)] hover:bg-[color-mix(in_srgb,var(--primary)_70%,var(--foreground))]`,
        outline: `${styled} bg-card border-input text-[color-mix(in_srgb,color-mix(in_srgb,var(--secondary-foreground)_55.56%,var(--muted))_90%,var(--primary))]! hover:bg-[color-mix(in_srgb,var(--secondary)_70%,var(--muted-surface))]`,
        ghost: `${styled} bg-transparent text-[color-mix(in_srgb,var(--primary)_60%,var(--muted))]! hover:bg-[color-mix(in_srgb,var(--primary)_7%,var(--card))]`,
        danger: `${styled} bg-[color-mix(in_srgb,var(--destructive)_10%,var(--card))] text-destructive!`,
        plain: "",
      },
      size: { default: "", sm: "" },
    },
    compoundVariants: [
      {
        variant: ["default", "outline", "ghost", "danger"],
        size: "default",
        className:
          "px-[15px] py-[9px] text-[12px]! max-[700px]:[.page-heading>&]:text-[0px]!",
      },
      {
        variant: ["default", "outline", "ghost", "danger"],
        size: "sm",
        className:
          "px-[9px] py-[5px] text-[11px]! max-[700px]:[.page-heading>&]:text-[0px]!",
      },
    ],
    defaultVariants: { variant: "default", size: "default" },
  },
);
export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}
