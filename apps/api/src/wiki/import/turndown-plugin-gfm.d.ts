// turndown-plugin-gfm ships no types and there's no @types package for it.
// This declares only the one export we use.
declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";

  export function gfm(service: TurndownService): void;
}
