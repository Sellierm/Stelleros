import { createRequire } from "node:module";
import bcrypt from "bcrypt";
import { betterAuth } from "better-auth";
import { username } from "better-auth/plugins";
import { toNodeHandler } from "better-auth/node";

const require = createRequire(import.meta.url);
const { pool, IS_PROD, ALLOWED_ORIGINS } = require("../config");

export const auth = betterAuth({
  appName: "Stelleros",
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  database: pool,
  trustedOrigins: ALLOWED_ORIGINS,
  user: { modelName: "auth_user" },
  session: {
    modelName: "auth_session",
    expiresIn: 2 * 60 * 60,
    updateAge: 5 * 60,
  },
  account: { modelName: "auth_account" },
  verification: { modelName: "auth_verification" },
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: 12,
    password: {
      hash: (password) => bcrypt.hash(password, 12),
      verify: async ({ hash, password }) => {
        return (
          typeof hash === "string" &&
          hash.startsWith("$2") &&
          bcrypt.compare(password, hash)
        );
      },
    },
  },
  plugins: [username({ minUsernameLength: 3, maxUsernameLength: 10 })],
  advanced: {
    useSecureCookies: IS_PROD,
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: IS_PROD ? "strict" : "lax",
    },
  },
  rateLimit: {
    enabled: true,
    window: 600,
    max: 60,
    customRules: { "/sign-in/username": { window: 600, max: 10 } },
  },
});

export const handler = toNodeHandler(auth);
export { fromNodeHeaders } from "better-auth/node";
