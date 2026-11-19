"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Sky } from "@react-three/drei";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import * as THREE from "three";
import { WhiteHouse } from "./WhiteHouse";
import { Interior } from "./Interior";
import { FloorScene, ROOM_W, floorCamera, floorPan } from "./FloorScene";
import { RUN_REFUSED, useLiveHouse } from "./live";
import { Approvals } from "./Approvals";
import { CallList, parseShortlist } from "./CallList";
import { Markdown } from "./Markdown";
import { CATALOGUE } from "@/lib/agents";

/* The house's department keys, matched to the catalogue of agent jobs. */
const CATALOGUE_ID: Record<string, string> = { data: "data", ads: "ads", creative: "content", cr: "customer-relations", eng: "engineering", research: "research", outreach: "outreach" };
import {
  AMBER,
  C,
  DEMO_NAMES,
  DEPTS,
  FLOORS,
  GREEN,
  RED,
  ROOMS,
  REAL_NAMES,
  ROOM_BY_ID,
  SANS,
  SERIF,
  STATE_LABEL,
  STATE_TEXT,
  answer,
  briefing,
  greeting,
  stateColor,
  useHouseSim,
  type RoomState,
} from "./model";

type Loc = { place: "grounds" } | { place: "oval" } | { place: "floor"; floor: number; room: string | null };

const HOME = new THREE.Vector3(30, 20, 98);
const TARGET = new THREE.Vector3(-9, 8.5, 6);
/* Phones are tall and narrow, so the camera stands further back and looks straight at the house. */
const HOME_PHONE = new THREE.Vector3(52, 34, 185);
const TARGET_PHONE = new THREE.Vector3(0, 9, 6);
const sceneKey = (l: Loc) => (l.place === "floor" ? `floor-${l.floor}` : l.place);

/* ------------------------------ camera ----------------------------- */

function Rig({ loc, phone, pan }: { loc: Loc; phone: boolean; pan: React.RefObject<number> }) {
  const look = useRef(new THREE.Vector3());
  const last = useRef("");
  const dp = useRef(new THREE.Vector3());
  const dl = useRef(new THREE.Vector3());

  useFrame((state, dt) => {
    const cam = state.camera as THREE.PerspectiveCamera;
    const key = sceneKey(loc) + (phone ? ":phone" : "");
    const fresh = key !== last.current;
    if (fresh) last.current = key;
    const fov = (f: number) => {
      if (cam.fov !== f) {
        cam.fov = f;
        cam.updateProjectionMatrix();
      }
    };
    if (loc.place === "grounds") {
      if (fresh) {
        fov(34);
        cam.position.copy(phone ? HOME_PHONE : HOME);
        cam.lookAt(phone ? TARGET_PHONE : TARGET);
      }
      return;
    }
    if (loc.place === "oval") {
      fov(56);
      dp.current.set(state.pointer.x * 0.7 - 1.6, 2.7 + state.pointer.y * 0.25, -7.2);
      dl.current.set(-1.2, 2.2, 3);
    } else {
      fov(38);
      const c = floorCamera(loc.floor, loc.room, state.size.width / state.size.height, pan.current);
      dp.current.set(c.pos[0] + state.pointer.x * 0.5, c.pos[1] + state.pointer.y * 0.25, c.pos[2]);
      dl.current.set(...c.look);
    }
    const k = fresh ? 1 : 1 - Math.exp(-dt * 6);
    cam.position.lerp(dp.current, k);
    look.current.lerp(dl.current, k);
    cam.lookAt(look.current);
  });
  return null;
}

/* ------------------------------ small UI pieces -------------------- */

const card: CSSProperties = { background: C.surface, color: C.ink, borderRadius: 22, boxShadow: "0 1px 0 rgba(26,14,11,0.08), 0 14px 40px rgba(26,14,11,0.16)" };

function Eyebrow({ children, color = C.terracotta }: { children: ReactNode; color?: string }) {
  return <div style={{ font: `600 10.5px/1.4 ${SANS}`, letterSpacing: "0.22em", textTransform: "uppercase", color }}>{children}</div>;
}

function Headline({ children, size = 30, dot = true }: { children: ReactNode; size?: number; dot?: boolean }) {
  return (
    <div style={{ font: `300 ${size}px/1.05 ${SERIF}`, letterSpacing: "-0.03em" }}>
      {children}
      {dot && <span style={{ color: C.coral }}>.</span>}
    </div>
  );
}

function Dot({ color, size = 9 }: { color: string; size?: number }) {
  return <span style={{ display: "inline-block", flex: "none", width: size, height: size, borderRadius: size, background: color }} />;
}

type Snap = "min" | "mid" | "full";
const SNAPS: Snap[] = ["min", "mid", "full"];

/* The panel for a room or the Oval Office. On a computer it is a fixed card on
   the right. On a phone it is a sheet you slide up and down: fully minimised,
   half, or full height. */
function Sheet({
  phone,
  snap,
  onSnap,
  hostH,
  label,
  title,
  sub,
  dot,
  wide,
  reduced,
  children,
}: {
  phone: boolean;
  snap: Snap;
  onSnap: (s: Snap) => void;
  hostH: number;
  label: string;
  title: string;
  sub: string;
  dot: string;
  wide?: boolean;
  reduced: boolean;
  children: ReactNode;
}) {
  const [dragH, setDragH] = useState<number | null>(null);
  const start = useRef<{ y: number; h: number } | null>(null);

  if (!phone) {
    return (
      <motion.aside
        aria-label={label}
        initial={reduced ? { opacity: 0 } : { x: 40, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={reduced ? { opacity: 0 } : { x: 40, opacity: 0 }}
        transition={{ duration: 0.22, ease: [0.2, 0.7, 0.1, 1] }}
        style={{ ...card }}
        className={`absolute bottom-5 right-5 top-[84px] z-30 flex flex-col overflow-hidden ${wide ? "w-[440px]" : "w-[420px]"}`}
      >
        {children}
      </motion.aside>
    );
  }

  const H: Record<Snap, number> = { min: 74, mid: Math.round(hostH * 0.42), full: Math.max(260, hostH - 150) };
  const height = dragH ?? H[snap];
  const minimised = snap === "min" && dragH === null;
  const release = () => {
    const from = start.current;
    start.current = null;
    if (!from) return;
    const h = dragH ?? from.h;
    setDragH(null);
    const moved = h - from.h;
    if (Math.abs(moved) < 8) return onSnap(snap === "mid" ? "full" : "mid"); // a tap
    const nearest = SNAPS.reduce((best, k) => (Math.abs(H[k] - h) < Math.abs(H[best] - h) ? k : best), snap);
    const step = SNAPS[Math.max(0, Math.min(2, SNAPS.indexOf(snap) + (moved > 0 ? 1 : -1)))] ?? snap;
    onSnap(nearest === snap && Math.abs(moved) > 36 ? step : nearest);
  };

  return (
    <motion.aside
      aria-label={label}
      initial={{ height: 0 }}
      animate={{ height }}
      transition={dragH !== null || reduced ? { duration: 0 } : { type: "spring", stiffness: 330, damping: 34 }}
      style={{ ...card }}
      className="absolute inset-x-2 bottom-2 z-30 flex flex-col overflow-hidden"
    >
      <div
        role="button"
        tabIndex={0}
        aria-label="Slide up or down. Tap to open or close."
        onPointerDown={(e) => {
          start.current = { y: e.clientY, h: H[snap] };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (start.current) setDragH(Math.max(60, Math.min(H.full + 24, start.current.h - (e.clientY - start.current.y))));
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onSnap(snap === "mid" ? "full" : "mid");
        }}
        className="flex flex-none cursor-grab touch-none select-none flex-col items-center px-5 pb-2 pt-2.5"
      >
        <span style={{ width: 44, height: 5, borderRadius: 5, background: C.blush }} />
        {minimised && (
          <span className="mt-2.5 flex w-full items-center gap-2.5">
            <Dot color={dot} size={10} />
            <span style={{ font: `300 20px/1.1 ${SERIF}`, letterSpacing: "-0.02em" }}>{title}</span>
            <span className="ml-auto" style={{ font: `500 13px/1 ${SANS}`, color: "#7a6a62" }}>
              {sub}
            </span>
          </span>
        )}
      </div>
      <div className={minimised ? "hidden" : "flex min-h-0 flex-1 flex-col"}>{children}</div>
    </motion.aside>
  );
}

const btnPrimary: CSSProperties = { minHeight: 46, padding: "0 20px", borderRadius: 999, background: C.ink, color: C.surface, font: `600 14px/1 ${SANS}`, cursor: "pointer" };
const btnGhost: CSSProperties = { minHeight: 46, padding: "0 18px", borderRadius: 999, background: "transparent", color: C.ink, border: `1.5px solid ${C.blush}`, font: `600 14px/1 ${SANS}`, cursor: "pointer" };

type Msg = { id: number; from: "you" | "chief"; text: string; rooms: string[]; time: string };

/* ------------------------------ the page --------------------------- */

/** The agents actually built and running in a room, by catalogue name. Everything else in the catalogue is offered, not built. */
const BUILT: Record<string, string[]> = {
  outreach: ["Lead Finder", "Lead Researcher", "Call Prep"],
  data: ["Daily Read"],
  research: ["Market Report"],
};
function isBuilt(roomId: string, agent: string) {
  // Only the Salekh Ventures floor has running agents so far.
  const [floor, dept] = roomId.split(":");
  return floor === "salekh-ventures" && (BUILT[dept ?? ""] ?? []).includes(agent);
}

export default function House3D({
  demo = false,
  embedded = false,
  preview = false,
  lowPower = false,
  paused = false,
  onClose,
}: {
  demo?: boolean;
  embedded?: boolean;
  /** Canvas only, turning slowly, nothing to press. Used as the phone poster. */
  preview?: boolean;
  /** Phones: no shadows and a lower pixel ratio. */
  lowPower?: boolean;
  /** Stop drawing while off screen. */
  paused?: boolean;
  onClose?: () => void;
} = {}) {
  const names = demo ? DEMO_NAMES : REAL_NAMES;
  const fname = (id: string) => names[id] ?? id;
  const reduced = useReducedMotion() ?? false;
  const [stoppedLocal, setStoppedLocal] = useState(false);
  const [loc, setLoc] = useState<Loc>({ place: "grounds" });
  const [fade, setFade] = useState(false);
  const [auto, setAuto] = useState(true);
  const [placesOpen, setPlacesOpen] = useState(false);
  const [chat, setChat] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [talking, setTalking] = useState(false);
  const [scores, setScores] = useState<Record<string, number>>({});
  // Which finished pieces of work Salekh has opened, kept on this device. Unopened work is "new for you".
  const [seen, setSeen] = useState<Set<string>>(() => {
    try {
      return new Set<string>(JSON.parse(localStorage.getItem("wh-seen") ?? "[]") as string[]);
    } catch {
      return new Set<string>();
    }
  });
  const markSeen = (id: string) =>
    setSeen((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev).add(id);
      try {
        localStorage.setItem("wh-seen", JSON.stringify([...next].slice(-300)));
      } catch {}
      return next;
    });
  const [showOlder, setShowOlder] = useState(false);
  /** The newest unopened piece of work in a room, when there is one (live only). */
  const unread = (roomId: string) => {
    if (!isLive) return null;
    const o = sim[roomId]?.outputs[0];
    return o && !seen.has(String(o.id)) && !String(o.title).startsWith("Results so far") ? o : null;
  };
  const [scoring, setScoring] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [scoreMsg, setScoreMsg] = useState("");
  const [viewing, setViewing] = useState<{ id: string; title: string; time: string; body: string } | null>(null);
  const [runMsg, setRunMsg] = useState("");
  const msgId = useRef(0);
  const labelLayer = useRef<HTMLDivElement>(null);
  /* Phones: the bottom sheet starts folded down so the scene stays visible. */
  const [snap, setSnap] = useState<Snap>("mid");
  const collapsed = lowPower && snap !== "full";
  const rootRef = useRef<HTMLDivElement>(null);
  const [hostH, setHostH] = useState(760);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHostH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const chatBox = useRef<HTMLDivElement>(null);
  /* Phones: swipe sideways along a floor. */
  const pan = useRef(-1e6);
  const drag = useRef<{ x: number; start: number } | null>(null);
  const live = useLiveHouse(!demo);
  const isLive = live.connected;
  const stopped = isLive ? live.stopped : stoppedLocal;
  const sample = useHouseSim(stoppedLocal || isLive, reduced);
  const sim = isLive ? live.sim : sample.sim;
  const couriers = isLive ? live.couriers : sample.couriers;
  const removeCourier = isLive ? live.removeCourier : sample.removeCourier;
  const decide = (id: string, yes: boolean) => (isLive ? void live.decide(id, yes) : sample.decide(id, yes));
  const acknowledge = (id: string) => (isLive ? void live.acknowledge(id) : sample.acknowledge(id));
  const toggleStop = () => (isLive ? void live.setStop(!stopped) : setStoppedLocal((v) => !v));
  const still = reduced || stopped;

  const runNow = async (id: string) => {
    setRunMsg("Starting…");
    const reason = await live.run(id);
    setRunMsg(reason ? (RUN_REFUSED[reason] ?? `Refused: ${reason}`) : "Started.");
  };
  const openOutput = async (id: string, title: string, time: string) => {
    markSeen(id);
    const o = await live.output(id);
    setViewing({ id, title, time, body: o?.body ?? "Could not load this piece of work." });
  };
  const saveScore = async (id: string) => {
    const v = scores[id];
    if (!v) return;
    if (v < 9 && !note.trim()) {
      setScoreMsg("Under 9 needs a note saying what was wrong.");
      return;
    }
    const ok = await live.score(id, v, note.trim());
    setScoreMsg(ok ? "" : "Could not save the score.");
    if (ok) setScoring(null);
  };

  const stateOf = (id: string): RoomState => (stopped ? "idle" : (sim[id]?.state ?? "idle"));
  const allRooms = Object.values(sim);
  const counts = {
    working: allRooms.filter((r) => r.state === "working" || r.state === "handoff").length,
    waiting: allRooms.filter((r) => r.state === "waiting").length,
    failed: allRooms.filter((r) => r.state === "failed").length,
  };

  const say = (from: Msg["from"], text: string, rooms: string[] = []) => {
    msgId.current += 1;
    const id = msgId.current;
    setChat((c) => [...c, { id, from, text, rooms, time: new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) }].slice(-12));
  };

  const go = (next: Loc) => {
    setAuto(false);
    setPlacesOpen(false);
    setSnap("mid");
    if (next.place === "floor" && (loc.place !== "floor" || loc.floor !== next.floor)) pan.current = -1e6;
    setScoring(null);
    setViewing(null);
    setRunMsg("");
    setScoreMsg("");
    if (loc.place === "floor" && loc.room) acknowledge(loc.room);
    const arrive = () => {
      if (next.place === "oval" && loc.place !== "oval") {
        setChat([]);
        const fresh = ROOMS.filter((r) => unread(r.id));
        const news = fresh.length
          ? ` New for you: ${fresh.map((r) => `${names[r.floorId] ?? r.floorId} ${DEPTS[r.dept].name} finished "${unread(r.id)?.title}"`).join("; ")}. Open the room to read it.`
          : "";
        // The Engineering watcher's word on Outreach comes first: a problem is the thing to hear.
        const watch = isLive ? live.health.map((h) => (live.health.length > 1 ? `${names[h.business] ?? h.business}: ${h.line}` : h.line)).join(" ") : "";
        say("chief", `${greeting()}. ${watch ? `${watch} ` : ""}${briefing(sim, stopped, names)}${news}`, [...ROOMS.filter((r) => sim[r.id]?.state === "waiting").map((r) => r.id), ...fresh.map((r) => r.id)]);
        setTalking(true);
      }
      setLoc(next);
    };
    if (sceneKey(next) === sceneKey(loc) || reduced) {
      arrive();
      return;
    }
    setFade(true);
    setTimeout(() => {
      arrive();
      setFade(false);
    }, 170);
  };
  const goRoom = (id: string) => {
    const r = ROOM_BY_ID[id];
    if (r) go({ place: "floor", floor: r.floorIndex, room: id });
  };

  useEffect(() => {
    if (!talking) return;
    const t = setTimeout(() => setTalking(false), 2600);
    return () => clearTimeout(t);
  }, [talking, chat]);

  const ask = (q: string) => {
    const text = q.trim();
    if (!text) return;
    setDraft("");
    setSnap("full");
    say("you", text);
    const a = answer(text, sim, stopped, names);
    setTimeout(() => {
      say("chief", a.text, a.rooms);
      setTalking(true);
    }, 320);
  };

  useEffect(() => {
    const el = chatBox.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat, snap]);

  const room = loc.place === "floor" && loc.room ? ROOM_BY_ID[loc.room] : undefined;
  const roomSim = room ? sim[room.id] : undefined;
  const roomState: RoomState = room ? stateOf(room.id) : "idle";
  const floorRooms = loc.place === "floor" ? ROOMS.filter((r) => r.floorIndex === loc.floor) : [];
  const panning = lowPower && !preview && loc.place === "floor" && !loc.room && floorRooms.length > 2;
  const crumbs: { label: string; to: Loc }[] = [{ label: "Grounds", to: { place: "grounds" } }];
  if (loc.place === "oval") crumbs.push({ label: "Oval Office", to: loc });
  if (loc.place === "floor") {
    crumbs.push({ label: fname(FLOORS[loc.floor]?.id ?? ""), to: { place: "floor", floor: loc.floor, room: null } });
    if (room) crumbs.push({ label: DEPTS[room.dept].name, to: loc });
  }

  const places = (
    <div data-lenis-prevent style={{ ...card, padding: 10 }} className="flex min-h-0 flex-col overflow-y-auto">
      <div className="px-3 pb-2 pt-3">
        <Eyebrow>Places</Eyebrow>
      </div>
      {(
        [
          { key: "grounds", label: "The grounds", sub: "The whole house", to: { place: "grounds" } as Loc, on: loc.place === "grounds" },
          { key: "oval", label: "Oval Office", sub: "Ask the Chief of Staff", to: { place: "oval" } as Loc, on: loc.place === "oval" },
        ] as const
      ).map((p) => (
        <button
          key={p.key}
          type="button"
          onClick={() => go(p.to)}
          className="flex min-h-12 items-center justify-between rounded-2xl px-3 text-left"
          style={{ background: p.on ? C.ink : "transparent", color: p.on ? C.surface : C.ink }}
        >
          <span style={{ font: `300 19px/1 ${SERIF}`, letterSpacing: "-0.02em" }}>{p.label}</span>
          <span style={{ font: `500 11.5px/1 ${SANS}`, opacity: 0.7 }}>{p.sub}</span>
        </button>
      ))}
      {FLOORS.map((f, fi) => {
        const onFloor = loc.place === "floor" && loc.floor === fi;
        return (
          <div key={f.id} className="mt-1 border-t pt-1" style={{ borderColor: C.panel }}>
            <button
              type="button"
              onClick={() => go({ place: "floor", floor: fi, room: null })}
              className="flex min-h-12 w-full items-center justify-between rounded-2xl px-3 text-left"
              style={{ background: onFloor && !room ? C.ink : "transparent", color: onFloor && !room ? C.surface : C.ink }}
            >
              <span style={{ font: `300 19px/1 ${SERIF}`, letterSpacing: "-0.02em" }}>{fname(f.id)}</span>
              <span style={{ font: `600 10px/1 ${SANS}`, letterSpacing: "0.2em", opacity: 0.7 }}>FLOOR {f.level}</span>
            </button>
            {ROOMS.filter((r) => r.floorId === f.id).map((r) => {
              const st = stateOf(r.id);
              const on = room?.id === r.id;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => goRoom(r.id)}
                  className="flex min-h-10 w-full items-center gap-2.5 rounded-xl pl-5 pr-3 text-left"
                  style={{ background: on ? C.panel : "transparent", font: `500 13.5px/1 ${SANS}`, color: C.ink }}
                >
                  <Dot color={stateColor(st, r.dept)} />
                  <span className="flex-1">{DEPTS[r.dept].name}</span>
                  {st === "idle" && unread(r.id) ? (
                    <span style={{ color: C.terracotta, fontWeight: 700, fontSize: 12 }}>New for you</span>
                  ) : (
                    <span style={{ color: STATE_TEXT[st], fontWeight: st === "idle" ? 400 : 600, fontSize: 12 }}>{STATE_LABEL[st]}</span>
                  )}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );

  return (
    <div ref={rootRef} data-lenis-prevent={embedded ? undefined : true} className={embedded ? "relative h-full w-full overflow-hidden" : "fixed inset-0 overflow-hidden"}
      style={{ background: C.light, color: C.ink, cursor: "auto", fontFamily: SANS, touchAction: panning ? "pan-y" : undefined }}
      onPointerDown={(e) => {
        if (panning) drag.current = { x: e.clientX, start: floorPan(loc.place === "floor" ? loc.floor : 0, pan.current) };
      }}
      onPointerMove={(e) => {
        if (!panning || !drag.current) return;
        const perPx = (2.15 * ROOM_W) / Math.max(1, window.innerWidth);
        pan.current = floorPan(loc.place === "floor" ? loc.floor : 0, drag.current.start - (e.clientX - drag.current.x) * perPx);
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
    >
      <Canvas shadows={!lowPower} dpr={lowPower ? [1, 1.5] : [1, 2]} frameloop={paused ? "never" : "always"} camera={{ position: HOME.toArray(), fov: 34, near: 0.5, far: 1200 }}>
        <Rig loc={loc} phone={lowPower} pan={pan} />
        {loc.place === "oval" && (
          <>
            <color attach="background" args={["#2A1A12"]} />
            <Interior sim={sim} stopped={stopped} still={still} talking={talking} />
          </>
        )}
        {loc.place === "floor" && (
          <FloorScene
            key={loc.floor}
            floorIndex={loc.floor}
            focusId={loc.room}
            sim={sim}
            stopped={stopped}
            still={still}
            couriers={couriers}
            onCourierDone={removeCourier}
            onSelect={goRoom}
            layer={labelLayer as React.RefObject<HTMLElement>}
          />
        )}
        {loc.place === "grounds" && (
          <>
            <Sky distance={4500} sunPosition={[-70, 26, 90]} turbidity={7} rayleigh={1.6} mieCoefficient={0.006} mieDirectionalG={0.85} />
            <fog attach="fog" args={["#F2D4B4", 170, 520]} />
            <hemisphereLight args={["#CFE3FF", "#6B7A55", 1.15]} />
            <directionalLight
              castShadow
              position={[-55, 46, 78]}
              intensity={2.7}
              color="#FFDDB8"
              shadow-mapSize={[2048, 2048]}
              shadow-camera-left={-80}
              shadow-camera-right={80}
              shadow-camera-top={70}
              shadow-camera-bottom={-50}
              shadow-camera-near={1}
              shadow-camera-far={260}
              shadow-bias={-0.0004}
            />
            <WhiteHouse
              sim={sim}
              stopped={stopped}
              still={still}
              couriers={couriers}
              onCourierDone={removeCourier}
              onSelect={goRoom}
              onEnter={() => go({ place: "oval" })}
              onFloor={(fi) => go({ place: "floor", floor: fi, room: null })}
              names={names}
              phone={lowPower}
              layer={labelLayer as React.RefObject<HTMLElement>}
            />
            <OrbitControls
              makeDefault
              target={lowPower ? TARGET_PHONE : TARGET}
              enablePan={false}
              enableZoom={!embedded}
              minDistance={34}
              maxDistance={lowPower ? 230 : 150}
              minPolarAngle={0.5}
              maxPolarAngle={1.5}
              enabled={!preview}
              autoRotate={(auto || preview) && !reduced}
              autoRotateSpeed={0.35}
              enableDamping
              onStart={() => setAuto(false)}
            />
          </>
        )}
      </Canvas>

      {/* floating labels from the 3D scene are drawn here */}
      <div ref={labelLayer} className="pointer-events-none absolute inset-0 z-10 overflow-hidden" />

      {/* quick cream fade between places */}
      <motion.div className="pointer-events-none absolute inset-0" style={{ background: C.cream }} initial={false} animate={{ opacity: fade ? 1 : 0 }} transition={{ duration: 0.16 }} />

      {!preview && (
        <>
      {/* left: name and places */}
      <div className="pointer-events-none absolute bottom-0 left-0 top-0 z-30 flex w-full flex-col gap-3 p-3 md:max-w-[320px] md:p-5">
        <div style={{ ...card, padding: lowPower ? "10px 10px 10px 16px" : "16px 18px" }} className="pointer-events-auto flex items-center justify-between gap-3">
          <div className="min-w-0 whitespace-nowrap">
            <Headline size={lowPower ? 20 : 27}>The White House</Headline>
            <div className={lowPower ? "hidden" : "mt-1.5"}>
              <Eyebrow color={isLive ? "#1c7046" : C.terracotta}>{isLive ? "Live" : demo ? "Interactive demo · simulated" : "Sample simulation · not live"}</Eyebrow>
            </div>
          </div>
          <div className="flex flex-none gap-1.5">
            <button type="button" onClick={() => setPlacesOpen((v) => !v)} className="md:hidden" style={{ ...btnGhost, minHeight: 44, padding: "0 14px", borderColor: C.ink }} aria-expanded={placesOpen}>
              Places
            </button>
            {onClose && (
              <button type="button" onClick={onClose} style={{ ...btnPrimary, minHeight: 44, padding: "0 14px" }}>
                Close
              </button>
            )}
          </div>
        </div>
        {/* phones: status and stop sit under the name */}
        <div className="pointer-events-auto flex items-center gap-2 md:hidden">
          <div style={{ ...card, borderRadius: 999, padding: "0 12px", font: `500 12px/1 ${SANS}` }} className="flex min-h-11 flex-1 items-center justify-between gap-2 whitespace-nowrap tabular-nums">
            <span className="flex items-center gap-1.5">
              <Dot color={C.ink} size={7} /> Working <b>{stopped ? 0 : counts.working}</b>
            </span>
            <span className="flex items-center gap-1.5" style={{ color: STATE_TEXT.waiting }}>
              <Dot color={AMBER} size={7} /> Needs you <b>{counts.waiting}</b>
            </span>
            <span className="flex items-center gap-1.5" style={{ color: counts.failed ? STATE_TEXT.failed : C.ink }}>
              <Dot color={counts.failed ? RED : C.blush} size={7} /> Failed <b>{counts.failed}</b>
            </span>
          </div>
          <button type="button" onClick={toggleStop} style={{ ...btnPrimary, minHeight: 44, padding: "0 16px", background: stopped ? GREEN : C.ink }}>
            {stopped ? "Resume" : "Stop"}
          </button>
        </div>
        <div className={`pointer-events-auto min-h-0 flex-col ${placesOpen ? "flex" : "hidden"} md:flex`}>{places}</div>
      </div>

      {/* top: where you are, the counts, the stop button */}
      <div className="pointer-events-none absolute right-0 top-0 z-30 hidden flex-wrap items-center justify-end gap-2 p-5 md:flex">
        <nav aria-label="Where you are" style={{ ...card, borderRadius: 999, padding: "0 8px" }} className="pointer-events-auto hidden min-h-12 items-center md:flex">
          {crumbs.map((c, i) => (
            <span key={c.label} className="flex items-center">
              {i > 0 && <span style={{ opacity: 0.35, padding: "0 2px" }}>/</span>}
              <button
                type="button"
                onClick={() => go(c.to)}
                className="min-h-10 rounded-full px-3"
                style={{ font: `${i === crumbs.length - 1 ? 600 : 500} 13.5px/1 ${SANS}`, color: i === crumbs.length - 1 ? C.ink : "#7a6a62", cursor: "pointer" }}
              >
                {c.label}
              </button>
            </span>
          ))}
        </nav>
        <div style={{ ...card, borderRadius: 999, padding: "0 18px", font: `500 13.5px/1 ${SANS}` }} className="pointer-events-auto flex min-h-12 items-center gap-4 tabular-nums">
          <span className="flex items-center gap-2">
            <Dot color={C.ink} /> Working <b>{stopped ? 0 : counts.working}</b>
          </span>
          <span className="flex items-center gap-2" style={{ color: STATE_TEXT.waiting }}>
            <Dot color={AMBER} /> Needs you <b>{counts.waiting}</b>
          </span>
          <span className="flex items-center gap-2" style={{ color: counts.failed ? STATE_TEXT.failed : C.ink }}>
            <Dot color={counts.failed ? RED : C.blush} /> Failed <b>{counts.failed}</b>
          </span>
        </div>
        <button type="button" onClick={toggleStop} className="pointer-events-auto" style={{ ...btnPrimary, minHeight: 48, background: stopped ? GREEN : C.ink }}>
          {stopped ? "Resume" : "Stop everything"}
        </button>
      </div>

      <AnimatePresence>
        {stopped && (
          <motion.div
            role="status"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            style={{ ...card, borderRadius: 999, padding: "13px 20px", font: `500 14px/1 ${SANS}` }}
            className="absolute left-1/2 top-36 z-30 w-max max-w-[92%] -translate-x-1/2 md:top-20"
          >
            Stopped. Nothing runs and nothing is sent until you resume.
          </motion.div>
        )}
      </AnimatePresence>

      {/* phones: the floors, as tags down the right edge of the grounds */}
      {lowPower && loc.place === "grounds" && (
        <nav aria-label="Floors" className="absolute right-2 top-1/2 z-20 flex -translate-y-1/2 flex-col items-end gap-2">
          {FLOORS.map((f, fi) => {
            const rooms = ROOMS.filter((r) => r.floorId === f.id);
            const needs = rooms.some((r) => stateOf(r.id) === "waiting");
            const failed = rooms.some((r) => stateOf(r.id) === "failed");
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => go({ place: "floor", floor: fi, room: null })}
                style={{ ...card, borderRadius: 14, padding: "8px 12px", textAlign: "left", boxShadow: "0 6px 18px rgba(26,14,11,0.18)" }}
                className="flex min-h-12 items-center gap-2.5"
              >
                <span>
                  <span className="block" style={{ font: `600 9.5px/1.3 ${SANS}`, letterSpacing: "0.18em", color: C.terracotta }}>
                    FLOOR {f.level}
                  </span>
                  <span className="block" style={{ font: `300 17px/1.1 ${SERIF}`, letterSpacing: "-0.02em" }}>
                    {fname(f.id)}
                  </span>
                </span>
                {(needs || failed) && <Dot color={failed ? RED : AMBER} size={9} />}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => go({ place: "oval" })}
            style={{ ...btnPrimary, minHeight: 48, padding: "0 16px", borderRadius: 14, font: `600 13.5px/1 ${SANS}` }}
          >
            Oval Office
          </button>
        </nav>
      )}

      {/* hints */}
      {loc.place === "grounds" && (
        <div style={{ ...card, borderRadius: 999, padding: "13px 20px", font: `500 13.5px/1.3 ${SANS}` }} className="absolute bottom-5 left-1/2 hidden -translate-x-1/2 md:block">
          {embedded ? "Drag to look around. Click a floor name, a lit window or the garden door." : "Drag to look around. Click a floor name, a lit window or the garden door to go in."}
        </div>
      )}
      {loc.place === "floor" && !room && (
        <div style={{ ...card, borderRadius: 999, padding: "13px 20px", font: `500 13.5px/1.3 ${SANS}` }} className="absolute bottom-5 left-1/2 -translate-x-1/2">
          {panning ? "Swipe sideways for more rooms. Tap a room to step in." : `${fname(FLOORS[loc.floor]?.id ?? "")}: click a room to step in.`}
        </div>
      )}

      {/* a room: now, what it made, what happened */}
      <AnimatePresence>
        {room && roomSim && (
          <Sheet
            key="room"
            phone={lowPower}
            snap={snap}
            onSnap={setSnap}
            hostH={hostH}
            reduced={reduced}
            label={`${fname(room.floorId)}, ${DEPTS[room.dept].name}`}
            title={DEPTS[room.dept].name}
            sub={stopped ? "Stopped" : STATE_LABEL[roomState]}
            dot={stateColor(roomState, room.dept)}
          >
            <div data-lenis-prevent className="flex-1 overflow-y-auto px-5 pb-4 pt-1 md:p-6">
              <Eyebrow>
                Floor {room.level} · {fname(room.floorId)}
              </Eyebrow>
              <div className="mt-1 flex items-center gap-3">
                <Dot color={DEPTS[room.dept].color} size={12} />
                <Headline size={lowPower ? 28 : 38}>{DEPTS[room.dept].name}</Headline>
              </div>

              <section className="mt-4 md:mt-6">
                <Eyebrow>Now</Eyebrow>
                <div className="mt-2 flex items-center gap-2.5" style={{ font: `600 17px/1.2 ${SANS}`, color: STATE_TEXT[roomState] }}>
                  <Dot color={stateColor(roomState, room.dept)} size={11} />
                  {stopped ? "Stopped" : STATE_LABEL[roomState]}
                </div>
                <p className="mt-1.5" style={{ font: `400 15px/1.5 ${SANS}`, color: "#4a3b34" }}>
                  {stopped ? "Nothing runs until you resume." : roomSim.task}
                </p>
                {(() => {
                  const fresh = unread(room.id);
                  if (!fresh) return null;
                  return (
                    <div className="mt-3 rounded-2xl p-4" style={{ background: "#FFF3D6", border: `1.5px solid ${C.terracotta}` }}>
                      <Eyebrow color={C.terracotta}>New for you</Eyebrow>
                      <p className="mt-1" style={{ font: `300 21px/1.2 ${SERIF}`, letterSpacing: "-0.02em" }}>{fresh.title}</p>
                      <p style={{ font: `400 13px/1.4 ${SANS}`, color: "#7a6a62" }}>Finished {fresh.time}</p>
                      <button type="button" onClick={() => openOutput(String(fresh.id), fresh.title, fresh.time)} className="mt-3" style={btnPrimary}>
                        {room.dept === "outreach" ? "Open the call list" : "Read it"}
                      </button>
                    </div>
                  );
                })()}
                {isLive && (
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <button type="button" onClick={() => runNow(room.id)} disabled={roomState === "working" || stopped} style={{ ...btnGhost, minHeight: 42, borderColor: C.ink, opacity: roomState === "working" || stopped ? 0.45 : 1 }}>
                      Run now
                    </button>
                    {roomSim.budgetTodayGbp != null && (
                      <span style={{ font: `500 12.5px/1.3 ui-monospace, monospace`, color: "#7a6a62" }}>
                        Today £{(roomSim.costTodayGbp ?? 0).toFixed(2)} of £{roomSim.budgetTodayGbp.toFixed(2)}
                      </span>
                    )}
                    {runMsg && (
                      <span role="status" style={{ font: `500 13px/1.3 ${SANS}`, color: "#4a3b34" }}>
                        {runMsg}
                      </span>
                    )}
                  </div>
                )}
              </section>

              {!stopped && roomState === "waiting" && (
                <section className="mt-5 rounded-2xl p-4" style={{ background: "#FFF3D6", border: `1.5px solid ${AMBER}` }}>
                  <Eyebrow color={STATE_TEXT.waiting}>Needs your yes</Eyebrow>
                  {isLive && room.dept === "outreach" ? (
                    <div className="mt-2">
                      <Approvals key={room.id} load={() => live.approvals(room.id)} decide={live.decideMany} />
                    </div>
                  ) : (
                    <>
                  <p className="mt-1.5" style={{ font: `300 22px/1.2 ${SERIF}`, letterSpacing: "-0.02em" }}>
                    {roomSim.proposal?.title ?? DEPTS[room.dept].ask}
                  </p>
                  <p className="mt-2" style={{ font: `400 13.5px/1.5 ${SANS}`, color: "#4a3b34" }}>
                    {roomSim.proposal
                      ? `Why: ${roomSim.proposal.reason} A yes covers exactly this and nothing else.`
                      : "Sample proposal. The real one shows the agent's reason and the exact action. A yes covers exactly that."}
                  </p>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button type="button" onClick={() => decide(room.id, true)} style={btnPrimary}>
                      Approve
                    </button>
                    <button type="button" onClick={() => decide(room.id, false)} style={{ ...btnGhost, borderColor: C.ink }}>
                      Reject
                    </button>
                  </div>
                    </>
                  )}
                </section>
              )}
              {!stopped && roomState === "failed" && (
                <section className="mt-5 rounded-2xl p-4" style={{ background: "#FDE5E2", border: `1.5px solid ${RED}` }}>
                  <Eyebrow color={STATE_TEXT.failed}>Failed</Eyebrow>
                  <p className="mt-1.5" style={{ font: `400 14.5px/1.5 ${SANS}` }}>
                    The run stopped with an error and nothing was sent. It clears once you leave the room.
                  </p>
                </section>
              )}

              {!collapsed && (
                <>
              <section className="mt-7">
                <Eyebrow>Agents for this department</Eyebrow>
                <ul className="mt-2 flex flex-col">
                  {[...(CATALOGUE.find((d) => d.id === CATALOGUE_ID[room.dept])?.agents ?? [])]
                    .sort((a, b) => Number(isBuilt(room.id, b.name)) - Number(isBuilt(room.id, a.name)))
                    .map((a) => {
                      const built = isLive && isBuilt(room.id, a.name);
                      return (
                        <li key={a.name} className="flex items-start justify-between gap-3 border-b py-2" style={{ borderColor: C.panel, opacity: built ? 1 : 0.55 }}>
                          <div>
                            <div style={{ font: `600 14px/1.3 ${SANS}` }}>{a.name}</div>
                            <div style={{ font: `400 13px/1.4 ${SANS}`, color: "#7a6a62" }}>{a.job}</div>
                          </div>
                          {isLive && (
                            <span style={{ flex: "none", font: `600 11px/1.6 ${SANS}`, color: built ? "#1c7046" : "#7a6a62" }}>{built ? "Working" : "Not built yet"}</span>
                          )}
                        </li>
                      );
                    })}
                </ul>
              </section>
              <section className="mt-7">
                <Eyebrow>Work made here</Eyebrow>
                {roomSim.outputs.length === 0 && (
                  <p className="mt-2" style={{ font: `400 14px/1.5 ${SANS}`, color: "#7a6a62" }}>
                    Nothing finished yet{isLive ? "" : " in this session"}.
                  </p>
                )}
                <ul className="mt-2 flex flex-col gap-2">
                  {(showOlder ? roomSim.outputs : roomSim.outputs.slice(0, 1)).map((o) => {
                    const key = String(o.id);
                    const given = scores[key] ?? o.score ?? null;
                    return (
                      <li key={key} className="rounded-2xl p-3.5" style={{ background: C.cream }}>
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div style={{ font: `300 19px/1.15 ${SERIF}`, letterSpacing: "-0.02em" }}>{o.title}</div>
                            <div style={{ font: `400 12px/1.4 ${SANS}`, color: "#7a6a62" }}>
                              Finished {o.time}
                              {isLive ? "" : " · sample"}
                            </div>
                          </div>
                          <div className="flex gap-1.5">
                            {isLive && (
                              <button type="button" onClick={() => openOutput(key, o.title, o.time)} style={{ ...btnGhost, minHeight: 40, padding: "0 14px", fontSize: 13, borderColor: C.ink }}>
                                Read
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                setScoring(scoring === key ? null : key);
                                setNote("");
                                setScoreMsg("");
                              }}
                              style={{ ...btnGhost, minHeight: 40, padding: "0 14px", fontSize: 13 }}
                            >
                              {given ? `Scored ${given}` : "Score"}
                            </button>
                          </div>
                        </div>
                        {scoring === key && (
                          <div className="mt-3">
                            <div role="group" aria-label="Score from 1 to 10" className="grid grid-cols-10 gap-1">
                              {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                                <button
                                  key={n}
                                  type="button"
                                  onClick={() => setScores((sc) => ({ ...sc, [key]: n }))}
                                  className="min-h-10 rounded-lg"
                                  style={{ background: scores[key] === n ? C.ink : C.surface, color: scores[key] === n ? C.surface : C.ink, font: `600 13px/1 ${SANS}`, cursor: "pointer" }}
                                >
                                  {n}
                                </button>
                              ))}
                            </div>
                            {(scores[key] ?? 10) < 9 && (
                              <>
                                <label htmlFor={`note-${key}`} className="mt-2 block" style={{ font: `400 12.5px/1.5 ${SANS}`, color: "#4a3b34" }}>
                                  Under 9 needs a note saying what was wrong. That note becomes a lesson for this department.
                                </label>
                                {isLive && (
                                  <textarea
                                    id={`note-${key}`}
                                    value={note}
                                    onChange={(e) => setNote(e.target.value)}
                                    rows={3}
                                    className="mt-1.5 w-full rounded-xl p-3 outline-none focus:ring-2 focus:ring-[#1a0e0b]"
                                    style={{ background: C.surface, border: `1.5px solid ${C.blush}`, font: `400 14px/1.5 ${SANS}`, color: C.ink }}
                                  />
                                )}
                              </>
                            )}
                            {isLive && scores[key] && (
                              <div className="mt-2 flex items-center gap-3">
                                <button type="button" onClick={() => saveScore(key)} style={{ ...btnPrimary, minHeight: 42 }}>
                                  Save score
                                </button>
                                {scoreMsg && (
                                  <span role="status" style={{ font: `500 13px/1.3 ${SANS}`, color: STATE_TEXT.failed }}>
                                    {scoreMsg}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {roomSim.outputs.length > 1 && (
                  <button type="button" onClick={() => setShowOlder(!showOlder)} className="mt-2" style={{ ...btnGhost, minHeight: 38, padding: "0 14px", fontSize: 13 }}>
                    {showOlder ? "Hide older work" : `Show older work (${roomSim.outputs.length - 1})`}
                  </button>
                )}
              </section>

              <section className="mt-7">
                <Eyebrow>What has happened</Eyebrow>
                {roomSim.log.length === 0 && (
                  <p className="mt-2" style={{ font: `400 14px/1.5 ${SANS}`, color: "#7a6a62" }}>
                    Nothing yet in this session.
                  </p>
                )}
                <ol className="mt-2 flex flex-col">
                  {[...roomSim.log].reverse().map((l) => (
                    <li key={l.id} className="grid grid-cols-[64px_1fr] gap-3 border-b py-2.5" style={{ borderColor: C.panel }}>
                      <span style={{ font: `500 12px/1.5 ui-monospace, monospace`, color: "#7a6a62" }}>{l.time}</span>
                      <span style={{ font: `400 14px/1.45 ${SANS}` }}>
                        <span style={{ font: `600 10px/1 ${SANS}`, letterSpacing: "0.16em", textTransform: "uppercase", color: C.terracotta }}>{l.kind}</span>
                        <br />
                        {l.text}
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
                </>
              )}
            </div>
            <div className="flex items-center gap-2 border-t p-3" style={{ borderColor: C.panel }}>
              <button type="button" onClick={() => go({ place: "floor", floor: room.floorIndex, room: null })} style={{ ...btnGhost, minHeight: 44 }}>
                Back to floor
              </button>
              <div className="ml-auto flex gap-2">
                {[-1, 1].map((d) => {
                  const next = floorRooms[(room.slot + d + floorRooms.length) % floorRooms.length];
                  if (!next || floorRooms.length < 2) return null;
                  return (
                    <button key={d} type="button" onClick={() => goRoom(next.id)} style={{ ...btnGhost, minHeight: 44, padding: "0 14px" }}>
                      {d < 0 ? (lowPower ? "Previous" : "Previous room") : lowPower ? "Next" : "Next room"}
                    </button>
                  );
                })}
              </div>
            </div>
          </Sheet>
        )}
      </AnimatePresence>

      {/* reading a finished piece of work, full size */}
      <AnimatePresence>
        {viewing && room && (
          <motion.div
            key="reader"
            className="absolute inset-0 z-40 flex items-stretch justify-center p-3 md:p-8"
            style={{ background: "rgba(26,14,11,0.45)" }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            onClick={() => setViewing(null)}
          >
            <motion.article
              role="dialog"
              aria-label={viewing.title}
              initial={reduced ? false : { y: 16 }}
              animate={{ y: 0 }}
              transition={{ duration: 0.2, ease: [0.2, 0.7, 0.1, 1] }}
              style={{ ...card }}
              className="flex w-full max-w-3xl flex-col overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <header className="flex items-start justify-between gap-4 border-b p-6 md:px-10" style={{ borderColor: C.panel }}>
                <div>
                  <Eyebrow>
                    {fname(room.floorId)} · {DEPTS[room.dept].name} · finished {viewing.time}
                  </Eyebrow>
                  <div className="mt-1.5">
                    <Headline size={32}>{viewing.title}</Headline>
                  </div>
                </div>
                <button type="button" onClick={() => setViewing(null)} style={{ ...btnPrimary, flex: "none" }}>
                  Close
                </button>
              </header>
              <div data-lenis-prevent className="min-w-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6 md:px-10">
                {(() => {
                  const leads = viewing.title.startsWith("Shortlist") ? parseShortlist(viewing.body) : [];
                  return leads.length > 0 ? <CallList
                      leads={leads}
                      report={viewing.body}
                      roomId={isLive ? room.id : undefined}
                      loadCalls={live.calls}
                      saveOutcome={live.recordOutcome}
                      putBack={live.putBack}
                      followupApi={{ load: live.followups, edit: live.editFollowup, decide: live.decideFollowup, request: live.requestFollowup, setRung: live.setFollowupRung }}
                      planApi={{ load: live.plans, request: live.requestPlan }}
                    /> : <Markdown text={viewing.body} />;
                })()}
              </div>
            </motion.article>
          </motion.div>
        )}
      </AnimatePresence>

      {/* the Oval Office: ask the Chief of Staff */}
      <AnimatePresence>
        {loc.place === "oval" && (
          <Sheet
            key="oval"
            phone={lowPower}
            snap={snap}
            onSnap={setSnap}
            hostH={hostH}
            reduced={reduced}
            wide
            label="Chief of Staff"
            title="Chief of Staff"
            sub="Slide up to ask"
            dot={C.ink}
          >
            <div className="px-5 pb-2 pt-1 md:p-6 md:pb-3">
              <Eyebrow>Oval Office</Eyebrow>
              <div className="mt-1">
                <Headline size={lowPower ? 26 : 38}>Chief of Staff</Headline>
              </div>
            </div>
            {collapsed ? (
              <div className="px-5 pb-3">
                {(() => {
                  const last = chat.filter((m) => m.from === "chief").slice(-1)[0];
                  return last ? (
                    <button type="button" onClick={() => setSnap("full")} className="block w-full text-left">
                      <span style={{ font: `600 10.5px/1.4 ${SANS}`, letterSpacing: "0.16em", textTransform: "uppercase", color: "#7a6a62" }}>As of {last.time}</span>
                      <span className="mt-1 line-clamp-3" style={{ font: `300 18px/1.3 ${SERIF}`, letterSpacing: "-0.015em" }}>
                        {last.text}
                      </span>
                    </button>
                  ) : null;
                })()}
              </div>
            ) : (
              <div ref={chatBox} data-lenis-prevent className="flex flex-1 flex-col gap-3 overflow-y-auto px-5 pb-4 md:px-6">
                {chat.map((m) =>
                  m.from === "you" ? (
                    <div key={m.id} className="self-end rounded-2xl px-4 py-2.5" style={{ background: C.ink, color: C.surface, font: `500 15px/1.45 ${SANS}`, maxWidth: "85%" }}>
                      {m.text}
                    </div>
                  ) : (
                    <motion.div key={m.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="self-start">
                      <div style={{ font: `600 10.5px/1.4 ${SANS}`, letterSpacing: "0.16em", textTransform: "uppercase", color: "#7a6a62" }}>As of {m.time}</div>
                      <p className="mt-1" style={{ font: `300 ${lowPower ? 18 : 21}px/1.3 ${SERIF}`, letterSpacing: "-0.015em" }}>
                        {m.text}
                      </p>
                      {m.rooms.length > 0 && (
                        <div className="mt-2.5 flex flex-wrap gap-2">
                          {m.rooms.map((id) => {
                            const r = ROOM_BY_ID[id];
                            if (!r) return null;
                            return (
                              <button key={id} type="button" onClick={() => goRoom(id)} className="flex items-center gap-2" style={{ ...btnGhost, minHeight: 40, padding: "0 14px", fontSize: 13 }}>
                                <Dot color={stateColor(stateOf(id), r.dept)} />
                                Go to {fname(r.floorId)} {DEPTS[r.dept].name}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </motion.div>
                  ),
                )}
              </div>
            )}
            <div className="border-t p-3 md:p-4" style={{ borderColor: C.panel }}>
              <div className="flex gap-1.5 overflow-x-auto pb-1 md:flex-wrap md:overflow-visible md:pb-0" style={{ scrollbarWidth: "none" }}>
                {["What needs me?", "What failed?", "What has been finished?", demo ? "How is the software company doing?" : "How is Mastore doing?"].map((q) => (
                  <button key={q} type="button" onClick={() => ask(q)} className="flex-none whitespace-nowrap" style={{ ...btnGhost, minHeight: 40, padding: "0 14px", fontSize: 13 }}>
                    {q}
                  </button>
                ))}
              </div>
              <form
                className="mt-2 flex gap-2 md:mt-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  ask(draft);
                }}
              >
                <label htmlFor="ask-chief" className="sr-only">
                  Ask the Chief of Staff
                </label>
                {/* 16px: anything smaller makes iPhones zoom the page when the box is tapped */}
                <input
                  id="ask-chief"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={lowPower ? "Ask the Chief of Staff" : "Ask about a floor, a department, or what needs you"}
                  enterKeyHint="send"
                  className="min-h-12 min-w-0 flex-1 rounded-full px-4 outline-none focus:ring-2 focus:ring-[#1a0e0b]"
                  style={{ background: C.cream, color: C.ink, font: `400 16px/1 ${SANS}`, border: `1.5px solid ${C.blush}`, WebkitTapHighlightColor: "transparent" }}
                />
                <button type="submit" style={btnPrimary}>
                  Ask
                </button>
              </form>
              <p className={lowPower ? "hidden" : "mt-2.5"} style={{ font: `400 11.5px/1.45 ${SANS}`, color: "#7a6a62" }}>
                {isLive
                  ? "The Chief of Staff agent is not built yet. For now these answers are simple rules over the live state."
                  : "Prototype: these answers are worked out from the simulation by simple rules. The real Chief of Staff answers from the log."}
              </p>
            </div>
          </Sheet>
        )}
      </AnimatePresence>
        </>
      )}
    </div>
  );
}
