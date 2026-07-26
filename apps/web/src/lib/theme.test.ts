import { describe, expect, it } from "vitest";
import { readAccent, readAppearance } from "./theme";

function storage(value: string | null) {
  return {
    getItem: () => value,
  };
}

describe("theme preferences", () => {
  it("uses safe defaults for missing preferences", () => {
    expect(readAppearance(storage(null))).toBe("system");
    expect(readAccent(storage(null))).toBe("indigo");
  });

  it("ignores invalid persisted values", () => {
    expect(readAppearance(storage("midnight"))).toBe("system");
    expect(readAccent(storage("chartreuse"))).toBe("indigo");
  });

  it("accepts supported preferences", () => {
    expect(readAppearance(storage("dark"))).toBe("dark");
    expect(readAccent(storage("teal"))).toBe("teal");
  });
});
