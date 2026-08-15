import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("application geometry", () => {
  it("keeps structural and control radii restrained", () => {
    const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

    expect(styles).toContain("--radius: 0.25rem;");
    expect(styles).toContain("--radius-lg: 0.25rem;");
    expect(styles).toContain("--radius-xl: 0.25rem;");
    expect(styles).not.toContain("--radius: 0.625rem;");
  });

  it("uses restrained caps on dashboard bars", () => {
    const overview = readFileSync(
      new URL("../components/overview-dashboard.tsx", import.meta.url),
      "utf8",
    );
    const insights = readFileSync(
      new URL("../components/insight-dashboard.tsx", import.meta.url),
      "utf8",
    );

    expect(overview).toContain("radius={[0, 2, 2, 0]}");
    expect(insights).toContain("radius={[0, 2, 2, 0]}");
  });
});
