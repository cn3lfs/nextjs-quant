"use client";
import * as React from "react";
import { Popover as Primitive } from "radix-ui";
import { cn } from "~/lib/common/classnames";

export const Popover = Primitive.Root;
export const PopoverTrigger = Primitive.Trigger;
export const PopoverClose = Primitive.Close;
export function PopoverContent({
  className,
  align = "start",
  sideOffset = 8,
  ...props
}: React.ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={12}
        className={cn(
          "z-50 max-h-[var(--radix-popover-content-available-height)] w-80 max-w-[calc(100vw-24px)] overflow-auto rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-md outline-none",
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  );
}
