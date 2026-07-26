import { describe, expect, it } from "vitest";
import viteConfig from "../../vite.config";

describe("Vite development proxy", () => {
  it("preserves the browser origin for security mutations", () => {
    expect(viteConfig.server?.proxy?.["/api"]).toMatchObject({
      target: "http://127.0.0.1:4545",
      changeOrigin: false,
    });
  });
});
