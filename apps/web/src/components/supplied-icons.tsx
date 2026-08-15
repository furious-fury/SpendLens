import type { ComponentPropsWithoutRef, CSSProperties } from "react";
import bankUrl from "../../../../icons/bank.svg";
import bookSavedUrl from "../../../../icons/book-saved.svg";
import chartUrl from "../../../../icons/chart-bars.svg";
import documentDownloadUrl from "../../../../icons/document-download.svg";
import dollarCircleUrl from "../../../../icons/currency-dollar-circle.svg";
import exportArrowUrl from "../../../../icons/arrow-export.svg";
import flashCircleUrl from "../../../../icons/flash-circle.svg";
import gearUrl from "../../../../icons/gear.svg";
import importArrowUrl from "../../../../icons/arrow-import.svg";
import moreUrl from "../../../../icons/more-horizontal.svg";
import receiptUrl from "../../../../icons/receipt.svg";
import searchUrl from "../../../../icons/search.svg";
import slidersUrl from "../../../../icons/sliders-control.svg";
import transferUrl from "../../../../icons/transfer.svg";

export type SuppliedIconProps = ComponentPropsWithoutRef<"span"> & {
  weight?: "thin" | "light" | "regular" | "bold" | "fill" | "duotone";
};

function createSuppliedIcon(source: string, label: string) {
  function SuppliedIcon({ className, style, weight: _weight, ...props }: SuppliedIconProps) {
    return (
      <span
        aria-hidden="true"
        className={className}
        data-icon={label}
        {...props}
        style={
          {
            ...style,
            backgroundColor: "currentColor",
            display: "inline-block",
            flexShrink: 0,
            maskImage: `url("${source}")`,
            maskPosition: "center",
            maskRepeat: "no-repeat",
            maskSize: "contain",
            WebkitMaskImage: `url("${source}")`,
            WebkitMaskPosition: "center",
            WebkitMaskRepeat: "no-repeat",
            WebkitMaskSize: "contain",
          } as CSSProperties
        }
      />
    );
  }

  SuppliedIcon.displayName = label;
  return SuppliedIcon;
}

export const SuppliedBank = createSuppliedIcon(bankUrl, "Bank");
export const SuppliedBookSaved = createSuppliedIcon(bookSavedUrl, "Book saved");
export const SuppliedChart = createSuppliedIcon(chartUrl, "Chart");
export const SuppliedDocumentDownload = createSuppliedIcon(documentDownloadUrl, "Document download");
export const SuppliedDollarCircle = createSuppliedIcon(dollarCircleUrl, "Dollar circle");
export const SuppliedExportArrow = createSuppliedIcon(exportArrowUrl, "Export arrow");
export const SuppliedFlashCircle = createSuppliedIcon(flashCircleUrl, "Flash circle");
export const SuppliedGear = createSuppliedIcon(gearUrl, "Settings");
export const SuppliedImportArrow = createSuppliedIcon(importArrowUrl, "Import arrow");
export const SuppliedMore = createSuppliedIcon(moreUrl, "More");
export const SuppliedReceipt = createSuppliedIcon(receiptUrl, "Receipt");
export const SuppliedSearch = createSuppliedIcon(searchUrl, "Search");
export const SuppliedSliders = createSuppliedIcon(slidersUrl, "Controls");
export const SuppliedTransfer = createSuppliedIcon(transferUrl, "Transfer");
