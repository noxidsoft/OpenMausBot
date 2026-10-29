import { describe, expect, it } from "vitest";
import { cloudPlanFromAccount, cloudPlanFromSnapshot } from "./cloud-plan-facts";

describe("the Cloud plan", () => {
  const trial = { state: "active", tier: "pro", endsAt: 1, amount: 4900, chargeAt: 1, holdUntil: null };
  const entitlement = (patch: Record<string, unknown>) => ({ plan: "pro", status: "active", expiresAt: null, version: 1, ...patch });

  it("reads a desktop's Cloud account: unknown while it cannot tell, none when signed out or not paying", () => {
    expect(cloudPlanFromAccount({ status: "signed-out", message: "restoring" })).toEqual({ plan: "unknown" });
    expect(cloudPlanFromAccount({ status: "signed-out" })).toEqual({ plan: "none" });
    for (const status of ["connecting", "reauth-required", "unavailable"] as const) expect(cloudPlanFromAccount({ status }), status).toEqual({ plan: "unknown" });
    expect(cloudPlanFromAccount(null)).toEqual({ plan: "unknown" });
    const connected = (patch: Record<string, unknown>, extra: Record<string, unknown> = {}) => cloudPlanFromAccount({ status: "connected", entitlement: entitlement(patch), ...extra } as never);
    expect(connected({})).toEqual({ plan: "pro", trial: false });
    expect(connected({ tier: "personal" }, { trial })).toEqual({ plan: "personal", trial: true });
    expect(connected({ tier: "a-tier-from-a-newer-admin" })).toEqual({ plan: "other", trial: false });
    expect(connected({ tier: "max", status: "inactive" })).toEqual({ plan: "none", trial: false });
    expect(connected({ plan: "free" }, { trial })).toEqual({ plan: "none", trial: true });
  });

  it("reads a Cloud page's own plan, where a paid plan whose payment needs attention counts as none", () => {
    expect(cloudPlanFromSnapshot({ status: "paid" })).toEqual({ plan: "pro", trial: false });
    expect(cloudPlanFromSnapshot({ status: "paid", tier: "max" })).toEqual({ plan: "max", trial: false });
    expect(cloudPlanFromSnapshot({ status: "paid", tier: "a-tier-from-a-newer-admin" })).toEqual({ plan: "other", trial: false });
    expect(cloudPlanFromSnapshot({ status: "attention", tier: "pro", trial } as never)).toEqual({ plan: "none", trial: true });
    expect(cloudPlanFromSnapshot({ status: "none" })).toEqual({ plan: "none", trial: false });
    for (const status of ["checking", "signin"] as const) expect(cloudPlanFromSnapshot({ status }), status).toEqual({ plan: "unknown" });
    expect(cloudPlanFromSnapshot(undefined)).toEqual({ plan: "unknown" });
  });
});
