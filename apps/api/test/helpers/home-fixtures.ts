import {
  sectionOff,
  sectionOk,
  type ChecklistDigest,
  type NextService,
  type SummaryInput,
  type SystemsHealth,
  type TicketDigest,
} from "@church/shared";
import type { PrimarySections } from "../../src/dashboard/home/home.types";

export const TZ = "Europe/London";

/** Thursday 8 Oct 2026, 13:00 in London (BST). */
export const NOW = new Date("2026-10-08T12:00:00Z");

export function systemsOk(over: Partial<SystemsHealth> = {}): SystemsHealth {
  return {
    areas: [
      { key: "servers", label: "Servers", href: "/monitoring/infra", state: "ok", up: 4, down: 0, total: 4, note: null },
      { key: "wifi", label: "Wi-Fi", href: "/monitoring/network", state: "ok", up: 9, down: 0, total: 9, note: null },
    ],
    totals: { up: 13, down: 0, total: 13 },
    problems: [],
    maintenanceMode: false,
    canWrite: true,
    ...over,
  };
}

export function problem(over: Partial<SystemsHealth["problems"][number]> = {}): SystemsHealth["problems"][number] {
  return {
    id: "wifi:aa:bb",
    area: "wifi",
    name: "AP-Kids-Wing",
    detail: null,
    since: "2026-10-08T10:00:00Z",
    href: "/monitoring/network",
    ack: { kind: "unifi", mac: "aa:bb", acked: false },
    ...over,
  };
}

export function serviceOk(over: Partial<NextService> = {}): NextService {
  const person = (name: string, status: "confirmed" | "waiting" | "declined") => ({
    name,
    status,
    isMe: false,
    localUserId: null,
  });
  return {
    source: "planning_center",
    title: "Sunday Gathering",
    seriesTitle: null,
    serviceTypeName: "Sunday",
    href: "/planning-center/1/2",
    startsAt: "2026-10-11T09:00:00Z",
    times: [],
    team: {
      confirmed: 12,
      waiting: 2,
      declined: 1,
      positions: [
        { name: "Vocals", people: [person("Ann", "confirmed"), person("Bo", "confirmed")] },
        { name: "Bass", people: [person("Cy", "declined")] },
        { name: "Sound", people: [person("Di", "waiting"), person("Ed", "waiting")] },
      ],
    },
    ...over,
  };
}

export function ticketsOk(over: Partial<TicketDigest> = {}): TicketDigest {
  return { mine: [], unassignedCount: 0, openCount: 0, canAssign: false, ...over };
}

export function ticketRow(over: Partial<TicketDigest["mine"][number]> = {}): TicketDigest["mine"][number] {
  return {
    id: "t1",
    number: 201,
    title: "Projector will not start",
    status: "open",
    priority: "normal",
    requesterName: "Grace",
    assignedToMe: true,
    createdAt: "2026-10-08T08:00:00Z",
    responseDueAt: "2026-10-08T20:40:00Z",
    responseBreached: false,
    href: "/tickets/t1",
    ...over,
  };
}

export function checklistsOk(): ChecklistDigest {
  return {
    events: [
      {
        eventId: "e1",
        name: "Sunday setup",
        scheduledAt: "2026-10-11T07:00:00Z",
        href: "/checklists/e1",
        tasks: [
          { taskId: "k1", title: "Lights", positionName: "Stage", done: false },
          { taskId: "k2", title: "Mics", positionName: "Stage", done: false },
        ],
      },
    ],
  };
}


/** Every primary section off; override the ones a test cares about. */
export function primary(over: Partial<PrimarySections> = {}): PrimarySections {
  return {
    service: sectionOff("forbidden"),
    systems: sectionOff("forbidden"),
    tickets: sectionOff("forbidden"),
    checklists: sectionOff("forbidden"),
    wiki: sectionOff("forbidden"),
    notes: sectionOff("forbidden"),
    activity: sectionOk([]),
    ...over,
  };
}

export function summaryInput(over: Partial<SummaryInput> = {}): SummaryInput {
  return {
    timezone: TZ,
    generatedAt: NOW.toISOString(),
    service: sectionOff("forbidden"),
    systems: sectionOff("forbidden"),
    tickets: sectionOff("forbidden"),
    checklists: sectionOff("forbidden"),
    ...over,
  };
}
