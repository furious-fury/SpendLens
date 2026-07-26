import {
  apiPaths,
  ChangePasswordRequestSchema,
  LoginRequestSchema,
  RekeyRequestSchema,
  SetupCompleteRequestSchema,
  SetupRequestSchema,
} from "@spendlens/contracts";
import { getCookie, setCookie } from "hono/cookie";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../api/request-context.js";
import { SecurityError } from "./security-error.js";
import type { SecurityService, SessionCredentials } from "./security-service.js";

export const SESSION_COOKIE = "spendlens_session";
export const CSRF_COOKIE = "spendlens_csrf";
export const CSRF_HEADER = "x-csrf-token";

export interface SecurityRoutesOptions {
  security: SecurityService;
  secureCookies: boolean;
  resolveRemoteAddress?: (request: Request) => string;
}

const publicSecurityPaths = new Set<string>([
  apiPaths.securityState,
  apiPaths.setup,
  apiPaths.setupComplete,
  apiPaths.login,
  apiPaths.openApi,
]);

export function requireApiAuthentication(security: SecurityService): MiddlewareHandler<AppEnv> {
  return async (context, next) => {
    if (publicSecurityPaths.has(context.req.path)) {
      await next();
      return;
    }

    const session = security.authenticate(getCookie(context, SESSION_COOKIE));
    context.set("session", session);
    if (!["GET", "HEAD", "OPTIONS"].includes(context.req.method)) {
      security.verifyCsrf(
        session,
        getCookie(context, CSRF_COOKIE),
        context.req.header(CSRF_HEADER),
      );
    }
    await next();
  };
}

export function createSecurityRoutes(options: SecurityRoutesOptions): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const remoteAddress = options.resolveRemoteAddress ?? (() => "local");

  routes.use("*", async (context, next) => {
    if (context.req.method !== "GET" && context.req.method !== "HEAD") {
      enforceSameOrigin(context.req.header("origin"), context.req.header("host"));
    }
    await next();
  });

  routes.get(apiPaths.securityState, async (context) => {
    const state = await options.security.state(getCookie(context, SESSION_COOKIE));
    return context.json(state);
  });

  routes.post(apiPaths.setup, async (context) => {
    const input = await parseBody(context.req.raw, SetupRequestSchema);
    const recoveryKit = await options.security.prepareSetup(input, remoteAddress(context.req.raw));
    return context.json({ status: "recovery-required" as const, recoveryKit }, 201);
  });

  routes.post(apiPaths.setupComplete, async (context) => {
    const input = await parseBody(context.req.raw, SetupCompleteRequestSchema);
    const credentials = await options.security.completeSetup(
      input.setupToken,
      input.recoveryConfirmed,
      remoteAddress(context.req.raw),
      context.req.header("user-agent"),
    );
    setSessionCookies(context, credentials, options.secureCookies);
    return context.json(sessionResponse(credentials));
  });

  routes.post(apiPaths.login, async (context) => {
    const input = await parseBody(context.req.raw, LoginRequestSchema);
    const credentials = await options.security.login(
      input.password,
      remoteAddress(context.req.raw),
      context.req.header("user-agent"),
    );
    setSessionCookies(context, credentials, options.secureCookies);
    return context.json(sessionResponse(credentials));
  });

  routes.post(apiPaths.logout, async (context) => {
    const session = authenticatedMutation(context.req.raw, options.security);
    options.security.logout(session, remoteAddress(context.req.raw));
    clearSessionCookies(context, options.secureCookies);
    return context.body(null, 204);
  });

  routes.post(apiPaths.logoutAll, async (context) => {
    const session = authenticatedMutation(context.req.raw, options.security);
    options.security.revokeAllSessions(session, remoteAddress(context.req.raw));
    clearSessionCookies(context, options.secureCookies);
    return context.body(null, 204);
  });

  routes.put(apiPaths.changePassword, async (context) => {
    const session = authenticatedMutation(context.req.raw, options.security);
    const input = await parseBody(context.req.raw, ChangePasswordRequestSchema);
    const credentials = await options.security.changePassword(
      session,
      input,
      remoteAddress(context.req.raw),
      context.req.header("user-agent"),
    );
    setSessionCookies(context, credentials, options.secureCookies);
    return context.json(sessionResponse(credentials));
  });

  routes.post(apiPaths.rekey, async (context) => {
    const session = authenticatedMutation(context.req.raw, options.security);
    const input = await parseBody(context.req.raw, RekeyRequestSchema);
    const recoveryKit = await options.security.rekeyDatabase(
      session,
      input.password,
      remoteAddress(context.req.raw),
    );
    return context.json({ recoveryKit });
  });

  return routes;
}

function authenticatedMutation(request: Request, security: SecurityService) {
  const cookies = parseCookies(request.headers.get("cookie"));
  const session = security.authenticate(cookies[SESSION_COOKIE]);
  security.verifyCsrf(session, cookies[CSRF_COOKIE], request.headers.get(CSRF_HEADER) ?? undefined);
  return session;
}

function setSessionCookies(
  context: Parameters<typeof setCookie>[0],
  credentials: SessionCredentials,
  secure: boolean,
): void {
  const common = {
    path: "/",
    sameSite: "Strict" as const,
    secure,
    expires: credentials.sessionExpiresAt,
  };
  setCookie(context, SESSION_COOKIE, credentials.sessionToken, {
    ...common,
    httpOnly: true,
  });
  setCookie(context, CSRF_COOKIE, credentials.csrfToken, {
    ...common,
    httpOnly: false,
  });
}

function clearSessionCookies(context: Parameters<typeof setCookie>[0], secure: boolean): void {
  const expired = new Date(0);
  setCookie(context, SESSION_COOKIE, "", {
    path: "/",
    sameSite: "Strict",
    secure,
    httpOnly: true,
    expires: expired,
  });
  setCookie(context, CSRF_COOKIE, "", {
    path: "/",
    sameSite: "Strict",
    secure,
    httpOnly: false,
    expires: expired,
  });
}

function sessionResponse(credentials: SessionCredentials) {
  return {
    user: credentials.user,
    sessionExpiresAt: credentials.sessionExpiresAt.toISOString(),
  };
}

async function parseBody<T>(
  request: Request,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): Promise<T> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new SecurityError("INVALID_REQUEST", "Send a valid JSON request body.", 400);
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    throw new SecurityError(
      "VALIDATION_FAILED",
      "Check the highlighted fields and try again.",
      400,
    );
  }
  return result.data;
}

function enforceSameOrigin(origin?: string, host?: string): void {
  if (!origin) {
    return;
  }

  try {
    if (!host || new URL(origin).host !== host) {
      throw new SecurityError(
        "CROSS_ORIGIN_REQUEST_BLOCKED",
        "Cross-origin security requests are not allowed.",
        403,
      );
    }
  } catch (error) {
    if (error instanceof SecurityError) {
      throw error;
    }
    throw new SecurityError("INVALID_ORIGIN", "The request origin is invalid.", 403);
  }
}

function parseCookies(header: string | null): Record<string, string> {
  if (!header) {
    return {};
  }
  return Object.fromEntries(
    header.split(";").map((part) => {
      const [name, ...value] = part.trim().split("=");
      return [name, decodeURIComponent(value.join("="))];
    }),
  );
}
