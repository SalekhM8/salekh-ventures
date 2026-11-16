"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/* Design prototype. Floors and departments are the launch set from the
   brief. Everything that happens is a browser simulation: no agents,
   no real data. */

export type DeptKey = "data" | "ads" | "creative" | "cr" | "eng" | "research" | "outreach";
export type RoomState = "idle" | "working" | "waiting" | "done" | "failed" | "handoff";
export type Vec3 = [number, number, number];

/* Brand: taken from the dast. films. */
export const C = {
  blush: "#e8c7b5",
  clay: "#d98e76",
  coral: "#e55d40",
  terracotta: "#b03a2a",
  burgundy: "#6a1a18",
  ink: "#1a0e0b",
  cream: "#f4e8de",
  panel: "#ecd5c6",
  surface: "#faf3ee",
  light: "#f6e7dd",
};
export const SERIF = "var(--font-fraunces), Georgia, serif";
export const SANS = "var(--font-inter), ui-sans-serif, system-ui, sans-serif";

export const DEPTS: Record<DeptKey, { name: string; color: string; work: string; ask: string; output: string }> = {
  data: { name: "Data", color: "#2F8FE8", work: "Reading the numbers against target", ask: "A report is flagged for your call", output: "Daily read" },
  ads: { name: "Ads", color: "#8B6CF0", work: "Reviewing campaigns against target", ask: "Proposal: pause one ad set", output: "Campaign review" },
  creative: { name: "Creative", color: "#E8559F", work: "Drafting scripts and captions", ask: "A filming request is ready", output: "Script and captions" },
  cr: { name: "Customer Relations", color: "#16B5A6", work: "Drafting a reply to a customer", ask: "A draft reply needs your yes", output: "Customer reply" },
  eng: { name: "Engineering", color: "#5E6B85", work: "Working on a pull request", ask: "A pull request is ready for review", output: "Pull request" },
  research: { name: "Research", color: "#C98A1A", work: "Reading the market and writing it up", ask: "A research brief needs your call", output: "Market report" },
  outreach: { name: "Outreach", color: "#E55D40", work: "Finding and checking businesses to contact", ask: "A message is ready for you to send", output: "Shortlist" },
};

/* Department ids as the runner names them. */
export const DEPT_API: Record<DeptKey, string> = { data: "data", ads: "ads", creative: "creative", cr: "customer-relations", eng: "engineering", research: "research", outreach: "outreach" };

export const AMBER = "#F5A300";
export const RED = "#E0352B";
export const GREEN = "#27A567";
/* Darker versions for text on cream. */
export const STATE_TEXT: Record<RoomState, string> = {
  idle: "#7a6a62",
  working: C.ink,
  waiting: "#8a5200",
  done: "#1c7046",
  failed: "#a8231b",
  handoff: C.ink,
};

export const STATE_LABEL: Record<RoomState, string> = {
  idle: "Idle",
  working: "Working",
  waiting: "Waiting on you",
  done: "Done",
  failed: "Failed",
  handoff: "Handing off",
};

/* South front. Floor index 0 is the top storey. */
export const FLOOR_WIN = [
  { y: 18.25, z: 10.02, w: 1.4, h: 1.7 },
  { y: 12.9, z: 13.02, w: 1.6, h: 2.7 },
  { y: 7.3, z: 13.02, w: 1.7, h: 3.7 },
  { y: 2.3, z: 13.02, w: 1.6, h: 2.5 },
];

export const FLOORS: { id: string; name: string; level: number; depts: DeptKey[]; bays: number[] }[] = [
  { id: "roots", name: "ROOTS", level: 4, depts: ["data", "ads", "creative"], bays: [-15.5, -11.5, 11.5] },
  { id: "mastore", name: "Mastore HQ", level: 3, depts: ["data", "ads", "creative", "cr", "eng", "research"], bays: [-19.5, -15.5, -11.5, 11.5, 15.5, 19.5] },
  { id: "twilight", name: "Twilight", level: 2, depts: ["creative", "data"], bays: [-11.5, 11.5] },
  { id: "salekh-ventures", name: "Salekh Ventures", level: 1, depts: ["outreach", "data", "creative", "cr", "eng", "research"], bays: [-19.5, -15.5, -11.5, 11.5, 15.5, 19.5] },
];

export type Room = {
  id: string;
  index: number;
  slot: number;
  floorId: string;
  floorName: string;
  floorIndex: number;
  level: number;
  dept: DeptKey;
  pos: Vec3;
  w: number;
  h: number;
};

export const ROOMS: Room[] = FLOORS.flatMap((f, fi) =>
  f.depts.map((dept, i) => {
    const win = FLOOR_WIN[fi] ?? { y: 0, z: 13, w: 1.6, h: 2.5 };
    return {
      id: `${f.id}:${dept}`,
      index: 0,
      slot: i,
      floorId: f.id,
      floorName: f.name,
      floorIndex: fi,
      level: f.level,
      dept,
      pos: [f.bays[i] ?? 0, win.y, win.z] as Vec3,
      w: win.w,
      h: win.h,
    };
  }),
).map((r, index) => ({ ...r, index }));

export const ROOM_BY_ID: Record<string, Room> = Object.fromEntries(ROOMS.map((r) => [r.id, r]));

export const CHIEF_POINT: Vec3 = [0, 7.4, 20];

export function stateColor(state: RoomState, dept: DeptKey) {
  if (state === "waiting") return AMBER;
  if (state === "failed") return RED;
  if (state === "done") return GREEN;
  return DEPTS[dept].color;
}

export type LogLine = { id: number | string; time: string; kind: string; text: string };
export type Output = { id: number | string; time: string; title: string; score?: number | null };
export type Proposal = { title: string; reason: string; actionType: string; rung: number; expiresAt: string; undoable: boolean; payloadHash?: string };
export type RoomSim = {
  state: RoomState;
  ticks: number;
  task: string;
  log: LogLine[];
  outputs: Output[];
  proposal?: Proposal | null;
  pendingApprovalId?: string | null;
  costTodayGbp?: number;
  budgetTodayGbp?: number | null;
};
export type Sim = Record<string, RoomSim>;
export type Courier = { id: number; fromId: string; toId: string; color: string };

function initialSim(): Sim {
  const sim: Sim = {};
  for (const r of ROOMS) sim[r.id] = { state: "idle", ticks: 0, task: "Nothing assigned", log: [], outputs: [] };
  const set = (id: string, state: RoomState) => {
    const room = sim[id];
    const meta = ROOM_BY_ID[id];
    if (room && meta) {
      room.state = state;
      room.task = state === "waiting" ? DEPTS[meta.dept].ask : DEPTS[meta.dept].work;
    }
  };
  set("roots:ads", "waiting");
  set("roots:creative", "working");
  set("mastore:data", "working");
  set("mastore:cr", "working");
  set("salekh-ventures:creative", "working");
  return sim;
}

export function useHouseSim(stopped: boolean, quiet: boolean) {
  const [sim, setSim] = useState<Sim>(initialSim);
  const [couriers, setCouriers] = useState<Courier[]>([]);
  const counter = useRef(0);
  const simRef = useRef(sim);
  useEffect(() => {
    simRef.current = sim;
  }, [sim]);

  const send = useCallback(
    (fromId: string, toId: string, color: string) => {
      if (quiet) return;
      counter.current += 1;
      const id = counter.current;
      setCouriers((c) => [...c.slice(-10), { id, fromId, toId, color }]);
    },
    [quiet],
  );

  const tick = useCallback(() => {
    const current = simRef.current;
    const next: Sim = {};
    for (const [id, r] of Object.entries(current)) next[id] = { ...r, ticks: r.ticks + 1 };
    const now = () => new Date().toLocaleTimeString("en-GB");

    const line = (kind: string, text: string): LogLine => {
      counter.current += 1;
      return { id: counter.current, time: now(), kind, text };
    };
    const push = (id: string, state: RoomState, task: string, lines: LogLine[], output?: string) => {
      const prev = next[id];
      if (!prev) return;
      counter.current += 1;
      next[id] = {
        state,
        ticks: 0,
        task,
        log: [...prev.log, ...lines].slice(-14),
        outputs: output ? [{ id: counter.current, time: now(), title: output }, ...prev.outputs].slice(0, 6) : prev.outputs,
      };
    };

    const room = ROOMS[Math.floor(Math.random() * ROOMS.length)];
    if (!room) return;
    const r = next[room.id];
    if (!r) return;
    const dept = DEPTS[room.dept];
    const waiting = Object.values(next).filter((x) => x.state === "waiting").length;
    const failed = Object.values(next).filter((x) => x.state === "failed").length;
    const roll = Math.random();

    if (r.state === "idle" && roll < 0.7) {
      send("chief", room.id, "#FFFFFF");
      push(room.id, "working", dept.work, [
        line("started", "Run started"),
        line("brief", "Brief received from the Chief of Staff"),
        line("working", dept.work),
      ]);
    } else if (r.state === "working" && r.ticks >= 3) {
      const mates = ROOMS.filter(
        (m) => m.floorId === room.floorId && m.id !== room.id && next[m.id]?.state === "idle",
      );
      const mate = mates[Math.floor(Math.random() * mates.length)];
      if (roll < 0.14 && waiting < 3) {
        push(room.id, "waiting", dept.ask, [
          line("proposal", dept.ask),
          line("gateway", "Checked by the gateway. Needs a yes before anything happens"),
        ]);
      } else if (roll < 0.2 && failed < 1) {
        push(room.id, "failed", "Stopped with an error", [line("failed", "Run stopped with an error. Nothing was sent")]);
      } else if (roll < 0.45 && mate) {
        send(room.id, mate.id, dept.color);
        push(room.id, "handoff", `Handing work to ${DEPTS[mate.dept].name}`, [line("handoff", `Handed work to ${DEPTS[mate.dept].name}`)], dept.output);
        push(mate.id, "working", DEPTS[mate.dept].work, [
          line("started", "Run started"),
          line("handoff", `Picked up a handoff from ${dept.name}`),
          line("working", DEPTS[mate.dept].work),
        ]);
      } else {
        push(room.id, "done", "Finished", [line("done", "Finished. Result logged")], dept.output);
      }
    } else if ((r.state === "done" || r.state === "handoff") && r.ticks >= 2) {
      push(room.id, "idle", "Nothing assigned", []);
    }

    setSim(next);
  }, [send]);

  useEffect(() => {
    if (stopped) return;
    const t = setInterval(() => {
      if (!document.hidden) tick();
    }, 1000);
    return () => clearInterval(t);
  }, [stopped, tick]);

  const decide = useCallback((id: string, yes: boolean) => {
    setSim((s) => {
      const r = s[id];
      const meta = ROOM_BY_ID[id];
      if (!r || !meta) return s;
      counter.current += 2;
      const time = new Date().toLocaleTimeString("en-GB");
      const entry: LogLine = {
        id: counter.current,
        time,
        kind: yes ? "approved" : "rejected",
        text: yes ? "You approved it. Carried out and checked" : "You rejected it. Nothing was done",
      };
      return {
        ...s,
        [id]: {
          state: yes ? "done" : "idle",
          ticks: 0,
          task: yes ? "Finished" : "Nothing assigned",
          log: [...r.log, entry].slice(-14),
          outputs: yes ? [{ id: counter.current - 1, time, title: DEPTS[meta.dept].output }, ...r.outputs].slice(0, 6) : r.outputs,
        },
      };
    });
  }, []);

  const acknowledge = useCallback((id: string) => {
    setSim((s) => {
      const r = s[id];
      if (!r || r.state !== "failed") return s;
      return { ...s, [id]: { ...r, state: "idle", ticks: 0, task: "Nothing assigned" } };
    });
  }, []);

  const removeCourier = useCallback((id: number) => {
    setCouriers((c) => c.filter((x) => x.id !== id));
  }, []);

  return { sim, couriers, removeCourier, decide, acknowledge };
}

/* ------------------------------ the Chief of Staff's words --------- */

export type Names = Record<string, string>;
export const REAL_NAMES: Names = Object.fromEntries(FLOORS.map((f) => [f.id, f.name]));
/* What a prospect sees on the public demo: no real business names. */
export const DEMO_NAMES: Names = { roots: "Health clinic", mastore: "Software company", twilight: "Online shop", "salekh-ventures": "Services firm" };

const label = (r: Room, n: Names) => `${n[r.floorId] ?? r.floorName} ${DEPTS[r.dept].name}`;

export function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function briefing(sim: Sim, stopped: boolean, names: Names = REAL_NAMES) {
  if (stopped) return "Everything is stopped. Nothing runs and nothing is sent until you resume.";
  const working = ROOMS.filter((r) => ["working", "handoff"].includes(sim[r.id]?.state ?? "idle"));
  const waiting = ROOMS.filter((r) => sim[r.id]?.state === "waiting");
  const failed = ROOMS.filter((r) => sim[r.id]?.state === "failed");
  const parts = [`${working.length} of ${ROOMS.length} rooms are working across ${FLOORS.length} floors.`];
  parts.push(waiting.length ? `${waiting.length} ${waiting.length === 1 ? "needs" : "need"} your yes: ${waiting.map((r) => label(r, names)).join(", ")}.` : "Nothing is waiting on you.");
  if (failed.length) parts.push(`${failed.length} failed: ${failed.map((r) => label(r, names)).join(", ")}.`);
  return parts.join(" ");
}

/** Prototype only: answers are worked out from the simulation by simple rules.
 *  The real Chief of Staff answers from the log. */
export function answer(question: string, sim: Sim, stopped: boolean, names: Names = REAL_NAMES): { text: string; rooms: string[] } {
  const q = question.toLowerCase();
  if (stopped) return { text: "Everything is stopped, so there is nothing running to report on. Resume and ask me again.", rooms: [] };
  const fn = (id: string) => names[id] ?? id;
  const describe = (r: Room) => {
    const s = sim[r.id];
    const last = s?.log[s.log.length - 1];
    return `${DEPTS[r.dept].name} is ${STATE_LABEL[s?.state ?? "idle"].toLowerCase()}${last ? ` (last: ${last.text.toLowerCase()})` : ""}`;
  };
  const floor = FLOORS.find((f) => q.includes(fn(f.id).toLowerCase()) || q.includes(f.id));
  const dept = (Object.keys(DEPTS) as DeptKey[]).find(
    (k) => q.includes(DEPTS[k].name.toLowerCase()) || (k === "cr" && q.includes("customer")) || (k === "eng" && q.includes("engineer")) || (k === "research" && q.includes("market")) || (k === "outreach" && (q.includes("prospect") || q.includes("lead"))),
  );

  const isDemo = names !== REAL_NAMES;
  if (/(what is this|what are you|who are you|how does (this|it) work|what do you do|explain)/.test(q)) {
    return {
      text: "Each floor is a business and each room is a department with its own agent. I decide who works on what, pass work between rooms, and bring you the calls that need a person. Ask me what needs you, or walk into any room to see the work.",
      rooms: [],
    };
  }
  if (/(price|pricing|cost|how much|fee)/.test(q)) {
    return { text: "That depends on which departments you would hand over. Use Build your team on the page and Salekh will come back to you personally.", rooms: [] };
  }
  if (isDemo && /(real|fake|simulat|demo|live)/.test(q)) {
    return { text: "This is a simulation with made up businesses, so you can see how the system behaves. Nothing here is a real client or real data.", rooms: [] };
  }

  if (/(need|approv|waiting|my yes|decide)/.test(q)) {
    const rooms = ROOMS.filter((r) => sim[r.id]?.state === "waiting");
    if (!rooms.length) return { text: "Nothing is waiting on you right now.", rooms: [] };
    return { text: `${rooms.length} ${rooms.length === 1 ? "thing needs" : "things need"} your yes. ${rooms.map((r) => `${label(r, names)}: ${sim[r.id]?.task ?? ""}`).join(". ")}.`, rooms: rooms.map((r) => r.id) };
  }
  if (/(fail|error|wrong|broke|problem)/.test(q)) {
    const rooms = ROOMS.filter((r) => sim[r.id]?.state === "failed");
    if (!rooms.length) return { text: "Nothing has failed. Every run so far finished or is still going.", rooms: [] };
    return { text: `${rooms.map((r) => label(r, names)).join(", ")} stopped with an error. Nothing was sent. Open the room to see the log.`, rooms: rooms.map((r) => r.id) };
  }
  if (/(done|finished|produced|output|made|work)/.test(q) && !floor && !dept) {
    const rooms = ROOMS.filter((r) => (sim[r.id]?.outputs.length ?? 0) > 0);
    if (!rooms.length) return { text: "Nothing has been finished yet in this session.", rooms: [] };
    return { text: `Finished so far: ${rooms.map((r) => `${label(r, names)} (${sim[r.id]?.outputs.length})`).join(", ")}. Open a room to see each piece.`, rooms: rooms.map((r) => r.id).slice(0, 4) };
  }
  if (floor || dept) {
    const rooms = ROOMS.filter((r) => (!floor || r.floorId === floor.id) && (!dept || r.dept === dept));
    if (!rooms.length) return { text: "That floor does not have that department.", rooms: [] };
    const head = floor && !dept ? `On ${fn(floor.id)}: ` : dept && !floor ? `${DEPTS[dept].name} across the house: ` : "";
    return { text: `${head}${rooms.map((r) => (floor && !dept ? describe(r) : `${fn(r.floorId)}: ${describe(r)}`)).join(". ")}.`, rooms: rooms.map((r) => r.id).slice(0, 5) };
  }
  if (/(today|happen|overall|summary|update|going on|status|brief|everything)/.test(q)) {
    const made = ROOMS.reduce((n, r) => n + (sim[r.id]?.outputs.length ?? 0), 0);
    return {
      text: `${briefing(sim, stopped, names)} ${made ? `${made} ${made === 1 ? "piece of work has" : "pieces of work have"} been finished so far.` : "No work has been finished yet."}`,
      rooms: ROOMS.filter((r) => sim[r.id]?.state === "waiting").map((r) => r.id),
    };
  }
  return {
    text: "I can tell you what needs you, what has failed, what has been finished, or how any floor or department is doing. Try one of the questions below, or name a department.",
    rooms: [],
  };
}
