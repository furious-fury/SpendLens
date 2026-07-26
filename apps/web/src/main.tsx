import "@fontsource-variable/inter";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { SecurityGate } from "@/components/security-gate";
import { ThemeProvider } from "@/components/theme-provider";
import { router } from "@/router";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 30_000,
    },
  },
});

const root = document.getElementById("root");

if (!root) {
  throw new Error("SpendLens could not find its application root.");
}

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <SecurityGate>
          <RouterProvider router={router} />
        </SecurityGate>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
