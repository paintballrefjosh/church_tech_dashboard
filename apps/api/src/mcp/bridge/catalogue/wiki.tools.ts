import { z } from "zod";
import { PERMISSIONS, updateWikiFolderSchema, wikiAclEntrySchema, WIKI_VISIBILITIES } from "@church/shared";
import { defineTool } from "../bridge.types";

const id = z.string().uuid();

/**
 * The wiki routes the seven hand-written tools (mcp.tools.ts) do not cover:
 * old revisions, revert, who can see or edit a page, and renaming or moving a
 * folder. Pages and folders cannot be deleted by an agent.
 */
export const WIKI_TOOLS = [
  defineTool({
    name: "wiki_get_revision",
    title: "Read an old page version",
    description: "One earlier version of a page, with its full Markdown body. Ids come from wiki_list_revisions.",
    cls: "read",
    method: "GET",
    path: "/wiki/:id/revisions/:revId",
    permissions: [PERMISSIONS.WIKI_READ_OWN],
    input: z.object({ id, revId: id }),
  }),
  defineTool({
    name: "wiki_revert_page",
    title: "Revert a page to an old version",
    description:
      "Put a page back to an earlier version. This is itself kept as a new revision, so nothing is lost, but it replaces the current text: read the current page and the old version first and be sure.",
    cls: "write",
    method: "POST",
    path: "/wiki/:id/revisions/:revId/revert",
    permissions: [PERMISSIONS.WIKI_READ_OWN],
    destructive: true,
    input: z.object({ id, revId: id }),
  }),
  defineTool({
    name: "wiki_set_page_access",
    title: "Set who can see or edit a page",
    description:
      "Make a page visible to everyone who can read the wiki ('public'), or only to the groups listed in acl ('group'), and say which of those groups may edit it. acl replaces the whole list. Changing access can hide a page from people, so only do it when asked.",
    cls: "write",
    method: "PATCH",
    path: "/wiki/:id",
    permissions: [PERMISSIONS.WIKI_READ_OWN],
    idempotent: true,
    input: z.object({
      id,
      visibility: z.enum(WIKI_VISIBILITIES),
      acl: z.array(wikiAclEntrySchema).optional(),
    }),
  }),
  defineTool({
    name: "wiki_update_folder",
    title: "Rename or move a wiki folder",
    description: "Rename a folder or move it into another folder (parentFolderId null moves it to the top level).",
    cls: "write",
    method: "PATCH",
    path: "/wiki/folders/:id",
    permissions: [PERMISSIONS.WIKI_CREATE],
    idempotent: true,
    input: z.object({ id, ...updateWikiFolderSchema.shape }),
  }),
];
