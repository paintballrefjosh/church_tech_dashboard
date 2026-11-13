import { z } from "zod";
import { PERMISSIONS, updateWikiFolderSchema, wikiAclEntrySchema, WIKI_VISIBILITIES } from "@lampstand/shared";
import { defineTool } from "../bridge.types";

const id = z.string().uuid();

/**
 * The wiki routes the seven hand-written tools (mcp.tools.ts) do not cover:
 * old revisions, revert, who can see or edit a page, archiving, and renaming or moving a
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
    input: z.object({
      id,
      revId: id,
      expectedUpdatedAt: z
        .string()
        .datetime()
        .optional()
        .describe("The page's updatedAt from when you read it: the revert is refused (409) if it has been edited since."),
    }),
  }),
  defineTool({
    name: "wiki_set_page_access",
    title: "Set who can see or edit a page",
    description:
      "Say who may READ a page: everyone who can read the wiki ('public'), or only the groups listed in acl ('group'). Separately, acl entries with canEdit true say which groups may EDIT it, on a public page as well (entries with canEdit false only matter for a 'group' page, where they are read-only readers; a group that can edit can also read). The owner and Wiki admins can always edit. acl replaces the whole list. Changing access can hide a page from people, so only do it when asked.",
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
    name: "wiki_archive_page",
    title: "Archive a wiki page",
    description:
      "Put a page away: it leaves the wiki menu and comes last in searches (marked archived), but stays readable by its address and keeps its history. Use it for a page that is out of date or no longer used, when asked; it is not a delete and wiki_unarchive_page undoes it. You need to be able to edit the page.",
    cls: "write",
    method: "POST",
    path: "/wiki/:id/archive",
    permissions: [PERMISSIONS.WIKI_READ_OWN],
    idempotent: true,
    input: z.object({ id }),
  }),
  defineTool({
    name: "wiki_unarchive_page",
    title: "Restore an archived wiki page",
    description: "Bring an archived page back into the wiki menu and normal search order. You need to be able to edit the page.",
    cls: "write",
    method: "POST",
    path: "/wiki/:id/unarchive",
    permissions: [PERMISSIONS.WIKI_READ_OWN],
    idempotent: true,
    input: z.object({ id }),
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
