import type { HomeSnapshot, TilePlacement } from "@church/shared";
import type { DashboardInitialData } from "../dashboard-tiles/dashboard-grid";

/** What every look receives. A look is presentation only: it never fetches its own data. */
export interface LookProps {
  snapshot: HomeSnapshot;
  me: {
    id: string;
    name: string;
    access: Record<string, "user" | "moderator" | "admin">;
    permissions: string[];
  };
  /** True on a booth screen: no editing chrome. */
  kiosk: boolean;
  /** Only the tiles look uses this: the saved grid and its prefetched data. */
  tiles?: { layout: TilePlacement[]; initialData: DashboardInitialData };
}
