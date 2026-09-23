"use client";

import { Button } from "./button";
import { Slot } from "@radix-ui/react-slot";
import { ChevronDown, ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { cn } from "~/lib/common/classnames";

/** Persistent navigation menu; native links retain Tab and browser navigation. */
export function Menu({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <nav aria-label={label} className="min-h-0 flex-1 overflow-y-auto">
      <ul className="m-0 list-none space-y-1 p-0">{children}</ul>
    </nav>
  );
}

export function MenuItem({
  children,
  active = false,
}: {
  children: ReactNode;
  active?: boolean;
}) {
  return (
    <li>
      <Slot
        aria-current={active ? "page" : undefined}
        className={cn(
          "nav-item w-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
          active && "active",
        )}
      >
        {children}
      </Slot>
    </li>
  );
}

export function MenuGroup({
  label,
  icon,
  active = false,
  children,
}: {
  label: string;
  icon: ReactNode;
  active?: boolean;
  children: ReactNode;
}) {
  const [open, setExpanded] = useState(active);
  useEffect(() => {
    if (active) setExpanded(true);
  }, [active]);
  return (
    <li>
      <Button
        variant="plain"
        type="button"
        className="nav-item w-full"
        aria-expanded={open}
        onClick={() => setExpanded(!open)}
      >
        {icon}
        {label}
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </Button>
      {open && (
        <ul aria-label={label} className="ml-3 list-none border-l pl-2">
          {children}
        </ul>
      )}
    </li>
  );
}
