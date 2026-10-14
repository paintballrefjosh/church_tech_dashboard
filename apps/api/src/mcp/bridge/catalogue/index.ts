import type { BridgeTool } from "../bridge.types";
import { ADMIN_TOOLS } from "./admin.tools";
import { CHECKLIST_TOOLS } from "./checklists.tools";
import { CHURCH_TOOLS } from "./church.tools";
import { GENERAL_TOOLS } from "./general.tools";
import { MONITORING_TOOLS } from "./monitoring.tools";
import { NETWORK_TOOLS } from "./network.tools";
import { OPERATIONAL_TOOLS } from "./operational.tools";
import { PERSONAL_TOOLS } from "./personal.tools";
import { TICKET_TOOLS } from "./tickets.tools";
import { WIKI_TOOLS } from "./wiki.tools";

/**
 * Every tool that is a door onto a REST route. One file per area, added phase
 * by phase (docs/mcp.md). The wiki's seven core tools are hand-written in
 * mcp.tools.ts; wiki.tools.ts here holds the rest of the wiki.
 */
export const BRIDGE_TOOLS: BridgeTool[] = [
  ...GENERAL_TOOLS,
  ...TICKET_TOOLS,
  ...PERSONAL_TOOLS,
  ...CHECKLIST_TOOLS,
  ...WIKI_TOOLS,
  ...MONITORING_TOOLS,
  ...NETWORK_TOOLS,
  ...CHURCH_TOOLS,
  ...OPERATIONAL_TOOLS,
  ...ADMIN_TOOLS,
];
