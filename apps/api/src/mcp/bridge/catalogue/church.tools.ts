import { z } from "zod";
import { PERMISSIONS } from "@church/shared";
import { defineTool } from "../bridge.types";

const PC_READ = PERMISSIONS.PLANNING_CENTER_READ_ANY;

/** Planning Center (read-only) and the ProPresenter status. Changing what the projector shows is phase 3. */
export const CHURCH_TOOLS = [
  defineTool({
    name: "planning_center_get_health",
    title: "Planning Center connection",
    description: "Whether the Planning Center integration is configured and reachable.",
    cls: "read",
    method: "GET",
    path: "/planning-center/health",
    permissions: [PC_READ],
    input: z.object({}),
  }),
  defineTool({
    name: "planning_center_list_service_types",
    title: "Planning Center service types",
    description: "The service types in Planning Center (for example Sunday morning). Their ids are what planning_center_list_plans filters by.",
    cls: "read",
    method: "GET",
    path: "/planning-center/service-types",
    permissions: [PC_READ],
    input: z.object({}),
  }),
  defineTool({
    name: "planning_center_list_plans",
    title: "Upcoming Planning Center plans",
    description: "The upcoming service plans, soonest first, optionally for one service type.",
    cls: "read",
    method: "GET",
    path: "/planning-center/plans",
    permissions: [PC_READ],
    input: z.object({
      service_type_id: z.string().max(64).optional().describe("A service type id from planning_center_list_service_types"),
      limit: z.number().int().min(1).max(50).optional(),
    }),
  }),
  defineTool({
    name: "planning_center_get_plan",
    title: "One Planning Center plan",
    description: "A plan in full: its items, and the people scheduled with their positions.",
    cls: "read",
    method: "GET",
    path: "/planning-center/plans/:serviceTypeId/:planId",
    permissions: [PC_READ],
    input: z.object({ serviceTypeId: z.string().min(1).max(64), planId: z.string().min(1).max(64) }),
  }),
  defineTool({
    name: "planning_center_search_people",
    title: "Find people in Planning Center",
    description: "Search the people in Planning Center by name.",
    cls: "read",
    method: "GET",
    path: "/planning-center/people",
    permissions: [PC_READ],
    input: z.object({ q: z.string().max(100).optional(), limit: z.number().int().min(1).max(100).optional() }),
  }),
  defineTool({
    name: "planning_center_get_my_link",
    title: "My Planning Center link",
    description: "Which Planning Center person, if any, the token's owner is linked to. Linking is done in the web app.",
    cls: "read",
    method: "GET",
    path: "/planning-center/me/link",
    permissions: [PC_READ],
    input: z.object({}),
  }),

  defineTool({
    name: "propresenter_get_health",
    title: "ProPresenter connection",
    description: "Whether the ProPresenter integration is configured and the machine answers.",
    cls: "read",
    method: "GET",
    path: "/propresenter/health",
    permissions: [PERMISSIONS.PROPRESENTER_READ_ANY],
    input: z.object({}),
  }),
  defineTool({
    name: "propresenter_get_status",
    title: "ProPresenter status",
    description: "What ProPresenter is showing now, as reported by the machine. Read-only: moving slides is not offered to agents yet.",
    cls: "read",
    method: "GET",
    path: "/propresenter/status",
    permissions: [PERMISSIONS.PROPRESENTER_READ_ANY],
    input: z.object({}),
  }),
];
