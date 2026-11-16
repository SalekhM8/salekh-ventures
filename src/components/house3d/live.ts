"use client";

import type { Decision, DecisionResult, PendingEnquiry } from "./Approvals";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEPT_API, ROOMS, type Courier, type DeptKey, type Proposal, type RoomState, type Sim } from "./model";

/* Reads the real house from the runner (through the site's own server).
   When the runner is not connected the page falls back to the sample
   simulation and says so. Contract: white-house/runner/API.md */

type ApiRoom = {
  id: string;
  state: RoomState;
  task: string;
  pendingApprovalId: string | null;
  proposal: Proposal | null;
  log: { id: string; at: string; kind: string; text: string }[];
  outputs: { id: string; at: string; title: string; runId: string; score: number | null }[];
  costTodayGbp: number;
  budgetTodayGbp: number | null;
};
type ApiHouse = {
  generatedAt: string;
  killSwitch: { global: boolean; floors: string[] };
  rooms: ApiRoom[];
  handoffs: { id: string; from: string; to: string; at: string }[];
};

const API_DEPT_TO_UI = Object.fromEntries((Object.keys(DEPT_API) as DeptKey[]).map((k) => [DEPT_API[k], k])) as Record<string, DeptKey>;

function toUi(apiRoomId: string) {
  const [business, dept] = apiRoomId.split(":");
  const key = dept ? API_DEPT_TO_UI[dept] : undefined;
  return business && key ? `${business}:${key}` : apiRoomId;
}
function toApi(uiRoomId: string) {
  const [business, dept] = uiRoomId.split(":");
  const api = dept ? DEPT_API[dept as DeptKey] : undefined;
  return business && api ? `${business}:${api}` : uiRoomId;
}
const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-GB");

async function call(path: string, body?: unknown) {
  const res = await fetch(`/api/house/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const json: unknown = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json: (json ?? {}) as Record<string, unknown> };
}

export function useLiveHouse(enabled = true) {
  const [house, setHouse] = useState<ApiHouse | null>(null);
  const [connected, setConnected] = useState(false);
  const [couriers, setCouriers] = useState<Courier[]>([]);
  const seen = useRef(new Set<string>());
  const first = useRef(true);
  const n = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const r = await call("v1/house");
      if (!r.ok || !Array.isArray(r.json.rooms)) {
        setConnected(false);
        return false;
      }
      const h = r.json as unknown as ApiHouse;
      const fresh: Courier[] = [];
      for (const hand of h.handoffs ?? []) {
        if (seen.current.has(hand.id)) continue;
        seen.current.add(hand.id);
        if (first.current) continue; // do not replay old handoffs on first load
        n.current += 1;
        fresh.push({ id: n.current, fromId: hand.from === "chief" ? "chief" : toUi(hand.from), toId: toUi(hand.to), color: "#FFFFFF" });
      }
      first.current = false;
      if (fresh.length) setCouriers((c) => [...c.slice(-10), ...fresh]);
      setHouse(h);
      setConnected(true);
      return true;
    } catch {
      setConnected(false);
      return false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      if (stop) return;
      const ok = document.hidden ? connected : await refresh();
      timer = setTimeout(loop, ok ? 1500 : 6000);
    };
    loop();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [refresh, connected, enabled]);

  const sim = useMemo<Sim>(() => {
    const out: Sim = {};
    for (const r of ROOMS) out[r.id] = { state: "idle", ticks: 0, task: "Nothing assigned", log: [], outputs: [] };
    for (const r of house?.rooms ?? []) {
      const id = toUi(r.id);
      if (!out[id]) continue;
      out[id] = {
        state: r.state,
        ticks: 0,
        task: r.task,
        log: r.log.map((l) => ({ id: l.id, time: clock(l.at), kind: l.kind, text: l.text })),
        outputs: r.outputs.map((o) => ({ id: o.id, time: clock(o.at), title: o.title, score: o.score })),
        proposal: r.proposal,
        pendingApprovalId: r.pendingApprovalId,
        costTodayGbp: r.costTodayGbp,
        budgetTodayGbp: r.budgetTodayGbp,
      };
    }
    return out;
  }, [house]);

  const removeCourier = useCallback((id: number) => setCouriers((c) => c.filter((x) => x.id !== id)), []);

  const decide = useCallback(
    async (roomId: string, yes: boolean) => {
      const approval = sim[roomId]?.pendingApprovalId;
      if (!approval) return;
      // Send back the hash of the proposal the person actually saw, so a yes is tied to it.
      const payloadHash = sim[roomId]?.proposal?.payloadHash;
      await call(`v1/approvals/${approval}`, payloadHash ? { decision: yes ? "approve" : "reject", payloadHash } : { decision: yes ? "approve" : "reject" });
      await refresh();
    },
    [sim, refresh],
  );
  const acknowledge = useCallback(
    async (roomId: string) => {
      if (sim[roomId]?.state !== "failed") return;
      await call(`v1/rooms/${toApi(roomId)}/acknowledge`, {});
      await refresh();
    },
    [sim, refresh],
  );
  const run = useCallback(
    async (roomId: string) => {
      const r = await call(`v1/rooms/${toApi(roomId)}/run`, {});
      await refresh();
      return r.ok ? null : String(r.json.reason ?? "refused");
    },
    [refresh],
  );
  const setStop = useCallback(
    async (on: boolean) => {
      await call("v1/kill-switch", { on });
      await refresh();
    },
    [refresh],
  );
  const score = useCallback(
    async (outputId: string, value: number, note: string) => {
      const r = await call(`v1/outputs/${outputId}/score`, note ? { score: value, note } : { score: value });
      await refresh();
      return r.ok;
    },
    [refresh],
  );
  const output = useCallback(async (outputId: string) => {
    const r = await call(`v1/outputs/${outputId}`);
    return r.ok ? { title: String(r.json.title ?? ""), body: String(r.json.body ?? "") } : null;
  }, []);

  /** The enquiries waiting for a yes in one room: exactly what would be sent. */
  const approvals = useCallback(async (roomId: string): Promise<PendingEnquiry[] | null> => {
    const r = await call(`v1/rooms/${toApi(roomId)}/approvals`);
    if (!r.ok || !Array.isArray(r.json.approvals)) return null;
    return (r.json.approvals as PendingEnquiry[]).filter((a) => a && a.enquiry);
  }, []);
  const decideMany = useCallback(
    async (decisions: Decision[]): Promise<DecisionResult[] | null> => {
      const r = await call("v1/approvals/batch", { decisions });
      await refresh();
      return r.ok && Array.isArray(r.json.results) ? (r.json.results as DecisionResult[]) : null;
    },
    [refresh],
  );

  return { connected, stopped: house?.killSwitch.global ?? false, sim, couriers, removeCourier, decide, acknowledge, run, setStop, score, output, approvals, decideMany };
}

export const RUN_REFUSED: Record<string, string> = {
  no_agent: "This department has no agent yet.",
  over_budget: "This department has used today's budget.",
  kill_switch: "Everything is stopped.",
  already_running: "It is already running.",
  no_api_key: "No Anthropic API key is set for the runner yet.",
};
