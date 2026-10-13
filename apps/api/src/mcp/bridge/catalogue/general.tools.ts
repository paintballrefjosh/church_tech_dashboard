import { z } from "zod";
import { SEARCH_KINDS } from "../../../search/search.controller";
import { defineTool } from "../bridge.types";

/** Tools that belong to no single module: who am I, and search across everything. */
export const GENERAL_TOOLS = [
  defineTool({
    name: "me_get_profile",
    title: "Who am I",
    description:
      "The account this token acts as: name, email, groups, the permissions it holds, and (for a token) whether it is read-only and which modules it is limited to. Call it first to learn what you may do.",
    cls: "read",
    method: "GET",
    path: "/me",
    permissions: [],
    input: z.object({}),
  }),
  defineTool({
    name: "search_everything",
    title: "Search everything",
    description:
      "Search the dashboard's content by words: wiki pages, notes, tickets, and (when permitted) monitors, hosts, Cisco switches/ports/MAC/ARP/VLANs, IPAM subnets and hosts, DNS records and UniFi devices/clients. Returns ranked hits with kind, title, snippet and url. Narrow with kind when you know what you want.",
    cls: "read",
    method: "GET",
    path: "/search",
    permissions: [],
    commaKeys: ["kind"],
    input: z.object({
      q: z.string().trim().min(1).max(200).describe("Words to look for"),
      kind: z.array(z.enum(SEARCH_KINDS as [string, ...string[]])).min(1).optional().describe("Only these kinds"),
      limit: z.number().int().min(1).max(50).optional().describe("How many hits (default 20)"),
    }),
  }),
];
