import { Global, Module } from "@nestjs/common";
import { BUS_STORE, DbBusStore } from "./bus.store";
import { ClusterBus } from "./cluster-bus.service";
import { ClusterJobs } from "./cluster-jobs.service";
import { JobStateService } from "./job-state.service";
import { LeaseService } from "./lease.service";
import { DbLeaseStore, LEASE_STORE } from "./lease.store";
import { NodeService } from "./node.service";
import { RateLimitService } from "./rate-limit.service";
import { RestoreGate } from "./restore-gate";

/**
 * Coordination between app nodes: identity + heartbeat, database leases, the
 * leader-gated job runner, small persisted job state, and the event bus. See docs/multi-node.md.
 */
@Global()
@Module({
  providers: [
    NodeService,
    { provide: LEASE_STORE, useClass: DbLeaseStore },
    LeaseService,
    ClusterJobs,
    JobStateService,
    { provide: BUS_STORE, useClass: DbBusStore },
    ClusterBus,
    RateLimitService,
    RestoreGate,
  ],
  exports: [NodeService, LeaseService, ClusterJobs, JobStateService, ClusterBus, RateLimitService, RestoreGate],
})
export class ClusterModule {}
