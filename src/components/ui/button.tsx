import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "~/lib/common/classnames";

// The marker preserves legacy contextual layout (including frozen consumers).
// plain keeps navigation, list options and unadorned actions at their old size.
const styled =
  "button inline-flex items-center justify-center gap-[6px] rounded-lg border border-transparent whitespace-nowrap transition-[background,border-color] duration-150";
const buttonVariants = cva(
  "cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2! focus-visible:outline-ring! focus-visible:outline-offset-[3px]!",
  {
    variants: {
      variant: {
        // Primary: accent outline on a transparent ground (Nocturne).
        default: `${styled} border-nc-accent! bg-transparent text-nc-accent-light! hover:bg-nc-accent-900`,
        outline: `${styled} border-nc-border! bg-transparent text-nc-text-2! hover:border-nc-accent-600! hover:bg-nc-inset`,
        ghost: `${styled} bg-transparent text-nc-accent-light! hover:bg-nc-accent-900`,
        danger: `${styled} border-nc-bad-edge! bg-transparent text-nc-bad! hover:bg-[color-mix(in_srgb,var(--nc-bad)_10%,transparent)]`,
        plain: "",
      },
      size: { default: "", sm: "" },
    },
    compoundVariants: [
      {
        variant: ["default", "outline", "ghost", "danger"],
        size: "default",
        className:
          "px-[12px] py-[6px] text-[12px]! max-[700px]:[.page-heading>&]:text-[0px]!",
      },
      {
        variant: ["default", "outline", "ghost", "danger"],
        size: "sm",
        className:
          "px-[10px] py-[4px] text-[11.5px]! max-[700px]:[.page-heading>&]:text-[0px]!",
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
