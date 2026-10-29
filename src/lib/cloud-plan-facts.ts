import type { CloudAccountState, CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import { allow, CLOUD_TIER } from "@/lib/analytics-allowlist";
import { trialRunning } from "@/lib/cloud-plan";

export type CloudPlanFacts = { plan: "starter" | "personal" | "pro" | "max" | "other" | "none" | "unknown"; trial?: boolean };

const tierPlan = (tier: string | undefined): CloudPlanFacts["plan"] => tier === undefined ? "pro" : allow(tier, CLOUD_TIER);

export function cloudPlanFromAccount(account: CloudAccountState | null | undefined): CloudPlanFacts {
  if (account?.status === "signed-out" && account.message !== "restoring") return { plan: "none" };
  if (account?.status !== "connected") return { plan: "unknown" };
  const paid = account.entitlement?.plan === "pro" && account.entitlement.status === "active";
  return { plan: paid ? tierPlan(account.entitlement?.tier) : "none", trial: trialRunning(account.trial) };
}

export function cloudPlanFromSnapshot(snapshot: CloudPlanSnapshot | null | undefined): CloudPlanFacts {
  if (snapshot?.status === "paid") return { plan: tierPlan(snapshot.tier), trial: trialRunning(snapshot.trial) };
  if (snapshot?.status === "none" || snapshot?.status === "attention") return { plan: "none", trial: trialRunning(snapshot.trial) };
  return { plan: "unknown" };
}
