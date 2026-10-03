import {
  pgTable,
  text,
  timestamp,
  boolean,
  uuid,
  integer,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Auth.js (v5) compatible tables. Column names match what @auth/drizzle-adapter
 * expects by default (camelCase actual column names for adapter-managed fields).
 * Custom application columns use snake_case as per the rest of the schema.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name"),
    email: text("email").notNull().unique(),
    emailVerified: timestamp("emailVerified"),
    image: text("image"),
    isActive: boolean("is_active").notNull().default(true),
    totpEnabled: boolean("totp_enabled").notNull().default(false),
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    // OAuth approval gate. "approved" = full member (has groups, can sign in and
    // use modules). "pending" = signed in via an external Google account while
    // google.allow_external_with_approval is on; can authenticate but has no
    // group/permissions and is blocked from all content until an admin approves.
    // Defaults to "approved" so local + workspace + pre-existing users are
    // unaffected. See apps/api/src/users/users.service.ts provisionOAuthUser.
    approvalStatus: text("approval_status").notNull().default("approved"),
    // One of "fluid" | "narrow" | "standard" | "wide" | "custom". See display-form.
    pageWidth: text("page_width").notNull().default("standard"),
    // Pixel cap used only when pageWidth = "custom".
    pageWidthPx: integer("page_width_px"),
    // Notification kinds (from NOTIFICATION_KINDS) the user has opted out of.
    // Anything in this list is silently skipped by NotificationsService.create.
    mutedNotificationKinds: text("muted_notification_kinds").array().notNull().default([]),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    // Soft-delete tombstone. NULL = live account. When set, the row is kept for
    // audit (notes/tickets/audit_log attribution survive) but the account is
    // locked out of sign-in and hidden from member/mention/assignee surfaces.
    // The email stays unique (locked to this row); recovery is via restore, not
    // re-creation. See users.service.ts delete()/restore().
    deletedAt: timestamp("deleted_at"),
  },
  (t) => ({
    // Expression indexes that turn the @mention resolver into index-friendly
    // exact-equals lookups instead of OR-of-ILIKEs (which would scan).
    lowerEmailIdx: index("users_lower_email_idx").on(sql`lower(${t.email})`),
    lowerNameIdx: index("users_lower_name_idx").on(sql`lower(${t.name})`),
  }),
);

export const accounts = pgTable(
  "accounts",
  {
    userId: uuid("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (acc) => ({
    pk: primaryKey({ columns: [acc.provider, acc.providerAccountId] }),
  })
);

export const sessions = pgTable("sessions", {
  sessionToken: text("sessionToken").primaryKey(),
  userId: uuid("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires").notNull(),
});

export const verificationTokens = pgTable(
  "verificationTokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires").notNull(),
  },
  (vt) => ({
    pk: primaryKey({ columns: [vt.identifier, vt.token] }),
  })
);

export const credentials = pgTable("credentials", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  passwordHash: text("password_hash").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const totpSecrets = pgTable("totp_secrets", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  secret: text("secret").notNull(),
  recoveryCodes: text("recovery_codes").array(),
  enrolledAt: timestamp("enrolled_at").notNull().defaultNow(),
});
