"use client";
import { useEffect, useState, type ComponentProps } from "react";
import { Popover } from "../ui/popover";
import { usePanelVisible } from "./keep-alive";

/** Portals must close when their cached page is hidden, not cover the next page. */
export function PanelPopover({
  open,
  defaultOpen = false,
  onOpenChange,
  ...props
}: ComponentProps<typeof Popover>) {
  const visible = usePanelVisible();
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const isOpen = open ?? localOpen;
  useEffect(() => {
    if (!visible && isOpen) {
      setLocalOpen(false);
      onOpenChange?.(false);
    }
  }, [visible, isOpen, onOpenChange]);
  return (
    <Popover
      {...props}
      open={visible && isOpen}
      onOpenChange={(next) => {
        setLocalOpen(next);
        onOpenChange?.(next);
      }}
    />
  );
}
