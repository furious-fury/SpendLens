import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { accents, readAccent, readAppearance } from "./theme";

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

  it("defines dashboard chart colours for light, dark, and every accent", () => {
    const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

    expect(styles.match(/--chart-1:/g)).toHaveLength(2);
    expect(styles.match(/--chart-5:/g)).toHaveLength(2);
    for (const accent of accents) {
      expect(styles).toContain(`html[data-accent="${accent}"]`);
      expect(styles).toContain(`.dark[data-accent="${accent}"]`);
    }
  });
});
