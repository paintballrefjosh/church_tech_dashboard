import type { WikiAclEntry, WikiVisibility } from "./schemas/wiki";

/**
 * Who may read and who may edit a wiki page, as two separate questions over the one stored list (`wiki_page_acl`:
 * a group and a `canEdit` flag). Pure functions, used by the API (when a list is saved) and by the page's access
 * editor, and unit-tested in apps/api/test/wiki-access.test.ts.
 *
 * READ: a public page is readable by everyone with the Wiki module. A restricted page ("group") is readable by
 * the groups in the list, whatever their `canEdit`: a row is a reader.
 * EDIT: the owner and Wiki admins always, plus every group whose row has `canEdit`. This holds for a public page
 * too, so "everyone reads, a few groups edit" is a public page with edit rows. Editing implies reading: on a
 * restricted page an editor's row is also what lets that group read it.
 *
 * So a public page has no use for a read-only row (everyone reads already), and `normaliseWikiAcl` drops it.
 */

/** One group once: a later entry for the same group wins; a public page keeps only the edit grants. */
export function normaliseWikiAcl(visibility: WikiVisibility, acl: readonly WikiAclEntry[]): WikiAclEntry[] {
  const byGroup = new Map<string, boolean>();
  for (const a of acl) byGroup.set(a.groupId, a.canEdit);
  const rows = [...byGroup.entries()].map(([groupId, canEdit]) => ({ groupId, canEdit }));
  return visibility === "public" ? rows.filter((r) => r.canEdit) : rows;
}

/** Groups that may read a restricted page: every row. */
export function wikiReaderGroupIds(acl: readonly WikiAclEntry[]): string[] {
  return acl.map((a) => a.groupId);
}

/** Groups that may edit the page (and, when it is restricted, read it too). */
export function wikiEditorGroupIds(acl: readonly WikiAclEntry[]): string[] {
  return acl.filter((a) => a.canEdit).map((a) => a.groupId);
}

/** Let a group read a restricted page. A group already listed (as a reader or an editor) is left as it is. */
export function addWikiReader(acl: readonly WikiAclEntry[], groupId: string): WikiAclEntry[] {
  if (acl.some((a) => a.groupId === groupId)) return [...acl];
  return [...acl, { groupId, canEdit: false }];
}

/** Stop a group reading a restricted page. It cannot edit what it cannot read, so its edit right goes too. */
export function removeWikiReader(acl: readonly WikiAclEntry[], groupId: string): WikiAclEntry[] {
  return acl.filter((a) => a.groupId !== groupId);
}

/** Let a group edit the page. It is added as a reader if it was not one. */
export function addWikiEditor(acl: readonly WikiAclEntry[], groupId: string): WikiAclEntry[] {
  if (acl.some((a) => a.groupId === groupId)) return acl.map((a) => (a.groupId === groupId ? { ...a, canEdit: true } : { ...a }));
  return [...acl, { groupId, canEdit: true }];
}

/**
 * Stop a group editing the page. On a restricted page it stays a reader (the row stays, read-only): taking away
 * someone's pen is not taking away their view. On a public page there is nothing left to say, so the row goes.
 */
export function removeWikiEditor(
  visibility: WikiVisibility,
  acl: readonly WikiAclEntry[],
  groupId: string,
): WikiAclEntry[] {
  return normaliseWikiAcl(
    visibility,
    acl.map((a) => (a.groupId === groupId ? { ...a, canEdit: false } : { ...a })),
  );
}
