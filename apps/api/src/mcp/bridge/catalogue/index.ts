import type { BridgeTool } from "../bridge.types";
import { GENERAL_TOOLS } from "./general.tools";

/**
 * Every tool that is a door onto a REST route. One file per area, added phase
 * by phase (docs/mcp.md). The wiki's hand-written tools live in mcp.tools.ts.
 */
export const BRIDGE_TOOLS: BridgeTool[] = [...GENERAL_TOOLS];
