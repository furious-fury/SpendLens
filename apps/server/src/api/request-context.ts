import type { AuthenticatedSession } from "../security/security-service.js";

export interface AppEnv {
  Variables: {
    requestId: string;
    session: AuthenticatedSession;
  };
}
