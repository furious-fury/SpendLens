import type * as React from "react";

interface SpendLensMarkProps extends React.ComponentProps<"svg"> {
  title?: string;
  tone?: "brand" | "accent";
}

function SpendLensMark({ title, tone = "brand", style, ...props }: SpendLensMarkProps) {
  return (
    <svg
      viewBox="0 0 500 500"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      style={{ color: tone === "accent" ? "var(--sidebar-primary)" : "var(--brand-mark)", ...style }}
      {...props}
    >
      {title ? <title>{title}</title> : null}
      <g fill="currentColor">
        <path d="M 250 50 C 139.54 50 50 139.54 50 250 C 50 360.46 139.54 450 250 450 C 360.46 450 450 360.46 450 250 C 450 230 447 210.8 441.4 192.6 L 411.2 222.8 C 414.3 231.6 416 240.6 416 250 C 416 341.68 341.68 416 250 416 C 158.32 416 84 341.68 84 250 C 84 158.32 158.32 84 250 84 C 275.2 84 299 89.6 320.2 99.6 L 344.8 75 C 316.4 59 284.2 50 250 50 Z" />
        <rect x="150" y="270" width="45" height="110" rx="8" />
        <rect x="227.5" y="300" width="45" height="80" rx="8" />
        <rect x="305" y="220" width="45" height="160" rx="8" />
        <path d="M 115 320 L 195 240 L 265 270 L 415 120" stroke="currentColor" strokeWidth="28" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        <circle cx="195" cy="240" r="26" />
        <circle cx="265" cy="270" r="26" />
        <circle cx="415" cy="120" r="32" />
      </g>
    </svg>
  );
}

export { SpendLensMark };
