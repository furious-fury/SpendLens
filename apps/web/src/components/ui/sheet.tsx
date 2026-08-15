import { X } from "@phosphor-icons/react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { overlayLayers } from "@/components/ui/layers";
import { cn } from "@/lib/utils";

export function Sheet({
  children,
  description,
  onClose,
  open,
  title,
  wide = false,
}: {
  children: ReactNode;
  description?: string;
  onClose: () => void;
  open: boolean;
  title: string;
  wide?: boolean;
}) {
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 bg-black/35 backdrop-blur-[1px]"
          style={{ zIndex: overlayLayers.sheetBackdrop }}
        />
        <DialogPrimitive.Content
          className={cn(
            "fixed inset-0 flex flex-col bg-background shadow-2xl outline-none md:inset-y-0 md:left-auto md:border-l md:border-border",
            wide ? "md:w-[720px]" : "md:w-[540px]",
          )}
          style={{ zIndex: overlayLayers.sheet }}
        >
          <header className="flex min-h-[72px] items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div>
              <DialogPrimitive.Title className="font-semibold tracking-tight">
                {title}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description
                className={description ? "mt-1 text-xs text-muted-foreground" : "sr-only"}
              >
                {description ?? `${title} panel`}
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close panel">
                <X />
              </Button>
            </DialogPrimitive.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
