import { describe, expect, it } from "vitest";
import { isNavigationItemActive } from "./app-shell";

describe("sidebar navigation", () => {
  it("only marks Overview active on the root route", () => {
    expect(isNavigationItemActive("/", "/")).toBe(true);
    expect(isNavigationItemActive("/transactions", "/")).toBe(false);
  });

  it("keeps a section active for its nested routes", () => {
    expect(isNavigationItemActive("/transactions/transaction-1", "/transactions")).toBe(true);
    expect(isNavigationItemActive("/settings/ai", "/settings")).toBe(true);
  });
});
