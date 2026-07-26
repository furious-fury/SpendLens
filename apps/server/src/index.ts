import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";

const port = Number.parseInt(process.env.SPENDLENS_PORT ?? "4545", 10);
const host = process.env.SPENDLENS_HOST ?? "127.0.0.1";
const webRoot = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const app = createApp();

app.use("/*", serveStatic({ root: webRoot }));
app.get("*", serveStatic({ path: `${webRoot}/index.html` }));

const server = serve(
  {
    fetch: app.fetch,
    hostname: host,
    port,
  },
  () => {
    console.log(`SpendLens is available at http://${host}:${port}`);
  },
);

server.on("error", (error) => {
  console.error("SpendLens could not start its HTTP server.", error);
  process.exitCode = 1;
});

function shutdown(signal: string) {
  console.log(`Received ${signal}; shutting down.`);
  server.close((error) => {
    if (error) {
      console.error("Failed to stop SpendLens cleanly.", error);
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
