import { describe, expect, it } from "vitest";
import { router } from "./router";

describe("import route", () => {
  it("uses the real statement import page instead of a placeholder", () => {
    const component = router.routesByPath["/imports"].options.component;

    expect(component).toBeDefined();
    expect(component?.name).toBe("ImportPage");
  });
});

