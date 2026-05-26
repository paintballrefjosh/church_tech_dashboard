import NextAuth, { type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db, schema } from "./db";

const apiInternalUrl = process.env.API_INTERNAL_URL ?? "http://api:3001";
const localAuthEnabled = process.env.AUTH_DISABLE_LOCAL !== "true";
const googleEnabled = !!process.env.GOOGLE_OAUTH_CLIENT_ID && !!process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const workspaceDomain = process.env.GOOGLE_WORKSPACE_DOMAIN;

export const authConfig: NextAuthConfig = {
  adapter: DrizzleAdapter(db, {
    usersTable: schema.users,
    accountsTable: schema.accounts,
    sessionsTable: schema.sessions,
    verificationTokensTable: schema.verificationTokens,
  }),
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 14 }, // 14 days
  trustHost: true,
  pages: {
    signIn: "/signin",
  },
  providers: [
    ...(googleEnabled
      ? [
          Google({
            clientId: process.env.GOOGLE_OAUTH_CLIENT_ID!,
            clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
            authorization: { params: { hd: workspaceDomain ?? undefined } },
          }),
        ]
      : []),
    ...(localAuthEnabled
      ? [
          Credentials({
            name: "Local",
            credentials: {
              email: { label: "Email", type: "email" },
              password: { label: "Password", type: "password" },
              totp: { label: "TOTP", type: "text" },
            },
            async authorize(creds) {
              try {
                const res = await fetch(`${apiInternalUrl}/api/v1/auth/verify-credentials`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    email: creds?.email,
                    password: creds?.password,
                    totp: creds?.totp || undefined,
                  }),
                  cache: "no-store",
                });
                if (!res.ok) return null;
                const data = (await res.json()) as
                  | { ok: true; user: { id: string; email: string; name: string | null; image: string | null } }
                  | { ok: false; requiresTotp?: boolean };
                if (!data.ok) {
                  // Bubble up so the UI can prompt for TOTP. Auth.js doesn't have a
                  // first-class way to signal this; we throw so the caller sees the message.
                  if ("requiresTotp" in data && data.requiresTotp) {
                    throw new Error("TOTP_REQUIRED");
                  }
                  return null;
                }
                return {
                  id: data.user.id,
                  email: data.user.email,
                  name: data.user.name,
                  image: data.user.image,
                };
              } catch (err) {
                if (err instanceof Error && err.message === "TOTP_REQUIRED") throw err;
                return null;
              }
            },
          }),
        ]
      : []),
  ],
  callbacks: {
    async signIn({ account, profile }) {
      if (account?.provider === "google" && workspaceDomain) {
        const hd = (profile as { hd?: string } | undefined)?.hd;
        if (hd !== workspaceDomain) return false;
      }
      return true;
    },
    async jwt({ token, user }) {
      // First login: attach the user id (becomes JWT.sub).
      if (user?.id) token.sub = user.id;
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.sub) {
        (session.user as { id?: string }).id = token.sub;
      }
      return session;
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
