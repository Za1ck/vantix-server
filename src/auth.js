import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";

export function authOptions(config, database, sendMail) {
  const dispatch = (to, subject, text) => {
    // Detached delivery avoids making reset/registration timing depend on account existence.
    // Errors deliberately omit recipient, credentials, provider payload and token-bearing URLs.
    void sendMail({ to, subject, text }).catch(() => console.error("Vantix: mail delivery failed; inspect the mail provider dashboard."));
  };
  return {
    appName: "Vantix",
    baseURL: config.origin,
    basePath: "/api/auth",
    secret: config.secret,
    database,
    trustedOrigins: [config.origin],
    hooks: {
      before: createAuthMiddleware(async context => {
        if (["/sign-up/email", "/send-verification-email", "/sign-in/email"].includes(context.path) && context.body) {
          context.body.callbackURL = `${config.origin}/verified`;
        }
        if (context.path === "/request-password-reset" && context.body) {
          context.body.redirectTo = `${config.origin}/reset-password`;
        }
      }),
    },
    logger: { disabled: true },
    user: { modelName: "vantix_user" },
    session: { modelName: "vantix_session", expiresIn: 7 * 86400, updateAge: 86400, cookieCache: { enabled: false } },
    account: { modelName: "vantix_account" },
    verification: { modelName: "vantix_verification" },
    emailAndPassword: {
      enabled: true,
      disableSignUp: !config.registrationEnabled,
      requireEmailVerification: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      autoSignIn: false,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 1800,
      sendResetPassword: async ({ user, url }) => dispatch(user.email, "Nulstil din Vantix-adgangskode", `Åbn dette link for at vælge en ny adgangskode (gyldigt i 30 minutter):\n${url}\n\nHvis du ikke bad om dette, kan du ignorere mailen. Din hovedadgangskode til boksen ændres ikke.`),
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
      expiresIn: 3600,
      sendVerificationEmail: async ({ user, url }) => dispatch(user.email, "Bekræft din Vantix-konto", `Bekræft din e-mailadresse ved at åbne dette link (gyldigt i en time):\n${url}\n\nHvis du ikke oprettede en Vantix-konto, kan du ignorere mailen.`),
    },
    advanced: {
      useSecureCookies: true,
      cookiePrefix: "vantix",
      defaultCookieAttributes: { httpOnly: true, secure: true, sameSite: "lax", path: "/" },
      database: { generateId: "uuid" },
      // The HTTP app overwrites this private header from Express's one-hop proxy result.
      ipAddress: { ipAddressHeaders: ["x-vantix-client-ip"] },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "vantix_rate_limit",
      window: 60,
      max: 60,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 3600, max: 10 },
        "/request-password-reset": { window: 3600, max: 5 },
        "/send-verification-email": { window: 3600, max: 5 },
        "/reset-password": { window: 60, max: 5 },
      },
    },
  };
}

export function createAuth(config, database, sendMail) {
  return betterAuth(authOptions(config, database, sendMail));
}

export function createMailer(config, fetchImpl = fetch) {
  return async ({ to, subject, text }) => {
    const response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: config.emailFrom, to: [to], subject, text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("Mail delivery failed");
  };
}
