import { describe, expect, it } from "vitest";
import { overlayLayers } from "./layers";

describe("overlay stacking", () => {
  it("keeps floating select menus above modal sheets", () => {
    expect(overlayLayers.floating).toBeGreaterThan(overlayLayers.sheet);
  });
});
