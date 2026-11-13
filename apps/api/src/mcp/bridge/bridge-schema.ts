import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { BridgeTool } from "./bridge.types";

/** The strict Zod object a tool's arguments are validated with. */
export function strictInput(tool: BridgeTool) {
  return tool.input.strict();
}

/**
 * The JSON Schema the MCP client sees, generated from the same Zod object the
 * arguments are validated with, so the two cannot drift. Inlined (no $ref) and
 * without the `$schema` marker, which is what MCP clients expect.
 */
export function toInputSchema(tool: BridgeTool): Tool["inputSchema"] {
  // TypeScript 5.9 gives up comparing the strict object with zod-to-json-schema's parameter type (TS2589), so it is not compared:
  // `never` skips the check. It is the same Zod object the arguments are validated with; the unit tests read the generated schemas.
  const schema = zodToJsonSchema(strictInput(tool) as never, { target: "jsonSchema7", $refStrategy: "none" }) as Record<
    string,
    unknown
  >;
  delete schema.$schema;
  return schema as Tool["inputSchema"];
}
