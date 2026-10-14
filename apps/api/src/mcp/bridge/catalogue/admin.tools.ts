import { z } from "zod";
import { PERMISSIONS, auditListQuerySchema } from "@church/shared";
import { defineTool } from "../bridge.types";
import { hideSecretSettings, scrubAudit } from "../scrub";

const id = z.string().uuid();

/**
 * Read-only administration: who has access, the site's settings, the audit log, the cluster. Nothing here
 * changes anything, and nothing returns a secret (settings and audit snapshots are scrubbed, see scrub.ts).
 */
export const ADMIN_TOOLS = [
  // ---- People and access ----
  defineTool({
    name: "users_list",
    title: "List accounts",
    description:
      "Every account, including disabled and deleted ones (deletedAt is set), with its email, name and state. No password or 2FA secret is ever returned.",
    cls: "read",
    method: "GET",
    path: "/users",
    permissions: [PERMISSIONS.USERS_READ_ANY],
    input: z.object({}),
  }),
  defineTool({
    name: "users_get",
    title: "Read an account",
    description: "One account with its state. Use users_get_groups for the groups it belongs to.",
    cls: "read",
    method: "GET",
    path: "/users/:id",
    permissions: [PERMISSIONS.USERS_READ_ANY],
    input: z.object({ id }),
  }),
  defineTool({
    name: "users_get_groups",
    title: "Groups of an account",
    description: "The ids of the groups an account belongs to (names and access are in groups_list).",
    cls: "read",
    method: "GET",
    path: "/users/:id/assignments",
    permissions: [PERMISSIONS.USERS_READ_ANY],
    input: z.object({ id }),
  }),
  defineTool({
    name: "groups_list",
    title: "List groups",
    description: "Every group. Access is granted to groups, as a tier per module (groups_get_module_access).",
    cls: "read",
    method: "GET",
    path: "/groups",
    permissions: [PERMISSIONS.GROUPS_READ_ANY],
    input: z.object({}),
  }),
  defineTool({
    name: "groups_get",
    title: "Read a group",
    description: "One group with its name and details. Its members and access are separate tools.",
    cls: "read",
    method: "GET",
    path: "/groups/:id",
    permissions: [PERMISSIONS.GROUPS_READ_ANY],
    input: z.object({ id }),
  }),
  defineTool({
    name: "groups_list_members",
    title: "Members of a group",
    description: "The accounts that belong to one group, with their email and state.",
    cls: "read",
    method: "GET",
    path: "/groups/:id/members",
    permissions: [PERMISSIONS.GROUPS_READ_ANY],
    input: z.object({ id }),
  }),
  defineTool({
    name: "groups_get_module_access",
    title: "Module access of a group",
    description: "The tier (user, moderator, admin) a group holds on each module: this is what decides what its members can do.",
    cls: "read",
    method: "GET",
    path: "/groups/:id/module-access",
    permissions: [PERMISSIONS.GROUPS_READ_ANY],
    input: z.object({ id }),
  }),
  defineTool({
    name: "groups_get_permissions",
    title: "Permissions of a group",
    description: "The permission strings a group's module access resolves to.",
    cls: "read",
    method: "GET",
    path: "/groups/:id/permissions",
    permissions: [PERMISSIONS.GROUPS_READ_ANY],
    input: z.object({ id }),
  }),
  defineTool({
    name: "groups_get_matrix",
    title: "Access matrix",
    description: "All groups against all modules in one table: who can do what. Good for answering 'who can see X'.",
    cls: "read",
    method: "GET",
    path: "/groups/matrix",
    permissions: [PERMISSIONS.PERMISSIONS_READ_ANY],
    input: z.object({}),
  }),

  // ---- Settings ----
  defineTool({
    name: "settings_list",
    title: "List settings",
    description:
      "The site's settings you may read, with their values. A secret (a password, an API token, an OAuth secret) shows as [hidden] when it is set and empty when it is not, even though the web app shows it to a site admin. Settings are changed in the web app only.",
    cls: "read",
    method: "GET",
    path: "/settings",
    permissions: [],
    input: z.object({}),
    transform: hideSecretSettings,
  }),
  defineTool({
    name: "settings_get",
    title: "Read a setting",
    description: "One setting by key, such as site.name or monitoring.maintenance_mode. A secret shows as [hidden] when set.",
    cls: "read",
    method: "GET",
    path: "/settings/:key",
    permissions: [],
    input: z.object({ key: z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/) }),
    transform: hideSecretSettings,
  }),

  // ---- Audit log ----
  defineTool({
    name: "audit_list",
    title: "Read the audit log",
    description:
      "Who changed what, newest first: actor, action (such as ticket.create), resource type and id, the before and after snapshots, and apiTokenName when it was done through a token. Filter by actor, resource type, action or dates (from, to as an ISO date or datetime). Pass the last row's ts as cursor for the next page. Credentials in the snapshots are hidden.",
    cls: "read",
    method: "GET",
    path: "/audit",
    permissions: [PERMISSIONS.AUDIT_READ_ANY],
    input: z.object({
      limit: z.number().int().min(1).max(500).optional().describe("Rows to return (default 50)"),
      cursor: auditListQuerySchema.shape.cursor,
      actorUserId: auditListQuerySchema.shape.actorUserId,
      resourceType: auditListQuerySchema.shape.resourceType,
      action: auditListQuerySchema.shape.action,
      from: auditListQuerySchema.shape.from,
      to: auditListQuerySchema.shape.to,
    }),
    transform: scrubAudit,
  }),

  // ---- Cluster ----
  defineTool({
    name: "cluster_get_status",
    title: "Cluster status",
    description:
      "The app nodes, the background jobs and which node runs each, the database and object store probes, and the problems found. Use it to answer whether the system is healthy as a whole.",
    cls: "read",
    method: "GET",
    path: "/admin/cluster",
    permissions: [PERMISSIONS.SITE_ADMIN],
    input: z.object({}),
  }),
  defineTool({
    name: "planning_center_list_links",
    title: "Planning Center links",
    description: "Which logins are linked to which Planning Center people.",
    cls: "read",
    method: "GET",
    path: "/planning-center/links",
    permissions: [PERMISSIONS.PLANNING_CENTER_ADMIN],
    input: z.object({}),
  }),
];
