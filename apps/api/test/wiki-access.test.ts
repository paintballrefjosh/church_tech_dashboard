import { describe, expect, it } from "vitest";
import {
  addWikiEditor,
  addWikiReader,
  normaliseWikiAcl,
  removeWikiEditor,
  removeWikiReader,
  wikiEditorGroupIds,
  wikiReaderGroupIds,
} from "@lampstand/shared";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";

describe("normaliseWikiAcl", () => {
  it("keeps every row of a restricted page, each group once, the last entry winning", () => {
    expect(
      normaliseWikiAcl("group", [
        { groupId: A, canEdit: false },
        { groupId: B, canEdit: true },
        { groupId: A, canEdit: true },
      ]),
    ).toEqual([
      { groupId: A, canEdit: true },
      { groupId: B, canEdit: true },
    ]);
  });

  it("keeps only the edit grants of a public page: everyone already reads it", () => {
    expect(
      normaliseWikiAcl("public", [
        { groupId: A, canEdit: false },
        { groupId: B, canEdit: true },
      ]),
    ).toEqual([{ groupId: B, canEdit: true }]);
  });

  it("does not change what it is given", () => {
    const given = [{ groupId: A, canEdit: false }];
    normaliseWikiAcl("public", given);
    expect(given).toEqual([{ groupId: A, canEdit: false }]);
  });
});

describe("readers and editors are separate lists over one stored list", () => {
  const acl = [
    { groupId: A, canEdit: false },
    { groupId: B, canEdit: true },
  ];

  it("reads a restricted page's readers (every row) and editors (canEdit) apart", () => {
    expect(wikiReaderGroupIds(acl)).toEqual([A, B]);
    expect(wikiEditorGroupIds(acl)).toEqual([B]);
  });

  it("adding an editor who is not a reader makes them one, since editing implies reading", () => {
    expect(addWikiEditor([], C)).toEqual([{ groupId: C, canEdit: true }]);
  });

  it("adding an editor who already reads upgrades that row and keeps the others", () => {
    expect(addWikiEditor(acl, A)).toEqual([
      { groupId: A, canEdit: true },
      { groupId: B, canEdit: true },
    ]);
  });

  it("adding a reader never takes away an edit right they already had", () => {
    expect(addWikiReader(acl, B)).toEqual(acl);
    expect(addWikiReader(acl, C)).toEqual([...acl, { groupId: C, canEdit: false }]);
  });

  it("removing an editor from a restricted page leaves them reading", () => {
    expect(removeWikiEditor("group", acl, B)).toEqual([
      { groupId: A, canEdit: false },
      { groupId: B, canEdit: false },
    ]);
  });

  it("removing an editor from a public page removes the row", () => {
    expect(removeWikiEditor("public", [{ groupId: B, canEdit: true }], B)).toEqual([]);
  });

  it("removing a reader takes their edit right with them", () => {
    expect(removeWikiReader(acl, B)).toEqual([{ groupId: A, canEdit: false }]);
  });
});
