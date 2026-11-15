"use client";

import { useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { Person, type Pose } from "./Person";
import {
  AMBER,
  C,
  DEPTS,
  FLOORS,
  GREEN,
  RED,
  ROOMS,
  ROOM_BY_ID,
  SANS,
  STATE_LABEL,
  STATE_TEXT,
  stateColor,
  type Courier,
  type DeptKey,
  type Room,
  type RoomState,
  type Sim,
  type Vec3,
} from "./model";

/* One floor of the house, opened up like a doll's house. Each room is a
   department: a person at a standing desk and a wall screen of its work. */

export const ROOM_W = 8.4;
const D = 7; // room depth
const WALL_H = 5;

export function roomX(slot: number, count: number) {
  return (slot - (count - 1) / 2) * ROOM_W;
}

export function floorCamera(floorIndex: number, focusId: string | null, aspect: number): { pos: Vec3; look: Vec3 } {
  const floor = FLOORS[floorIndex];
  const n = floor?.depts.length ?? 3;
  const focus = focusId ? ROOM_BY_ID[focusId] : undefined;
  if (focus && focus.floorIndex === floorIndex) {
    const x = roomX(focus.slot, n);
    const wide = aspect > 1.25;
    return { pos: [x + (wide ? 0.3 : 0), wide ? 3.4 : 5, wide ? 12.5 : 15], look: [x + (wide ? 0.7 : 0), wide ? 2.3 : -1.6, -3.6] };
  }
  const width = n * ROOM_W + 1.5;
  const wide = aspect > 1.25;
  const tan = Math.tan((38 * Math.PI) / 360);
  const frac = wide ? 0.7 : 1; // the Places list covers the left of a wide screen
  const dist = Math.max(12, width / 2 / (tan * aspect * frac));
  const shift = wide ? (2 * dist * tan * aspect * (1 - frac)) / 2 : 0;
  return { pos: [-shift, 5.6 + dist * 0.12, dist + 1], look: [-shift, 2.3, -3.2] };
}

const std = (color: string, roughness = 0.9, extra: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness, ...extra });

const M = {
  wall: std("#FBF6EF"),
  wallSide: std("#F1E7DB"),
  skirting: std("#FFFFFF"),
  wood: std("#B98A5E"),
  woodDark: std("#8E6642"),
  slab: std("#E9DCCB"),
  runner: std(C.burgundy),
  runnerEdge: std(C.clay),
  desk: std("#F3ECE2", 0.6),
  metal: std("#2B2623", 0.5, { metalness: 0.4 }),
  screen: new THREE.MeshBasicMaterial({ color: "#16110F" }),
  pot: std("#D9CFC1"),
  leaf: std("#4F8A44"),
  leaf2: std("#6FA552"),
  sky: new THREE.MeshBasicMaterial({ color: "#CFE6FA" }),
  cloud: new THREE.MeshBasicMaterial({ color: "#FFFFFF" }),
  paper: std("#FFFFFF", 0.7),
  rack: std("#22262E", 0.6),
};

/* ------------------------------ wall screen ------------------------ */

type Item = { x: number; y: number; w: number; h: number; color: string; mode: "bar" | "line" | "pop" | "still" };

function screenItems(dept: DeptKey): Item[] {
  const c = DEPTS[dept].color;
  const cream = "#F4E8DE";
  if (dept === "data") {
    return [
      ...[0, 1, 2, 3, 4, 5, 6].map((i): Item => ({ x: -1.5 + i * 0.5, y: -0.75, w: 0.32, h: 1.5, color: i === 4 ? cream : c, mode: "bar" })),
      { x: 0, y: -0.82, w: 3.6, h: 0.04, color: cream, mode: "still" },
    ];
  }
  if (dept === "ads") {
    return [
      { x: -1.25, y: 0.2, w: 1, h: 1.1, color: c, mode: "pop" },
      { x: 0, y: 0.2, w: 1, h: 1.1, color: cream, mode: "pop" },
      { x: 1.25, y: 0.2, w: 1, h: 1.1, color: C.coral, mode: "pop" },
      { x: -1.85, y: -0.72, w: 3.7, h: 0.16, color: c, mode: "line" },
    ];
  }
  if (dept === "creative") {
    return [0, 1, 2, 3].flatMap((i): Item[] => [
      { x: -1.38 + i * 0.92, y: 0.25, w: 0.78, h: 0.95, color: i % 2 ? cream : c, mode: "pop" },
      { x: -1.77 + i * 0.92, y: -0.55, w: 0.78, h: 0.1, color: cream, mode: "line" },
    ]);
  }
  if (dept === "research") {
    return [
      { x: -1.85, y: 0.75, w: 2.4, h: 0.16, color: cream, mode: "line" },
      { x: -1.85, y: 0.42, w: 3.4, h: 0.1, color: c, mode: "line" },
      { x: -1.85, y: 0.18, w: 3.0, h: 0.1, color: cream, mode: "line" },
      { x: -1.2, y: -0.45, w: 0.9, h: 0.7, color: c, mode: "pop" },
      { x: 0, y: -0.45, w: 0.9, h: 0.7, color: cream, mode: "pop" },
      { x: 1.2, y: -0.45, w: 0.9, h: 0.7, color: C.coral, mode: "pop" },
    ];
  }
  if (dept === "cr") {
    return [0, 1, 2, 3].map((i): Item => ({ x: i % 2 ? 0.55 : -0.55, y: 0.72 - i * 0.48, w: 2.2, h: 0.34, color: i % 2 ? c : cream, mode: "pop" }));
  }
  return [0, 1, 2, 3, 4, 5].map((i): Item => ({ x: -1.85, y: 0.78 - i * 0.31, w: 1.4 + ((i * 7) % 5) * 0.45, h: 0.13, color: i === 2 ? "#3DDC97" : i === 4 ? c : cream, mode: "line" }));
}

function WallScreen({ dept, active, still }: { dept: DeptKey; active: boolean; still: boolean }) {
  const items = useMemo(() => screenItems(dept), [dept]);
  const refs = useRef<(THREE.Group | null)[]>([]);
  useFrame(({ clock }) => {
    const t = still || !active ? 1.3 : clock.elapsedTime;
    items.forEach((it, i) => {
      const g = refs.current[i];
      if (!g) return;
      if (it.mode === "bar") g.scale.y = 0.25 + 0.75 * Math.abs(Math.sin(t * 1.1 + i * 1.3));
      if (it.mode === "line") g.scale.x = 0.35 + 0.65 * Math.abs(Math.sin(t * 0.9 + i * 0.8));
      if (it.mode === "pop") {
        const k = active && !still ? Math.min(1, Math.max(0, ((t * 0.7 + i * 0.5) % 3) * 2)) : 1;
        g.scale.setScalar(0.001 + k);
      }
      const mesh = g.children[0] as THREE.Mesh | undefined;
      if (mesh) (mesh.material as THREE.MeshBasicMaterial).opacity = active ? 1 : 0.28;
    });
  });
  return (
    <group position={[0, 3.05, -D + 0.16]}>
      <mesh material={M.metal} position={[0, 0, -0.04]}>
        <boxGeometry args={[4.5, 2.5, 0.1]} />
      </mesh>
      <mesh material={M.screen} position={[0, 0, 0.02]}>
        <planeGeometry args={[4.2, 2.2]} />
      </mesh>
      {items.map((it, i) => (
        <group key={i} position={[it.x, it.y, 0.04]}>
          <group
            ref={(g) => {
              refs.current[i] = g;
            }}
          >
            <mesh position={[it.mode === "line" ? it.w / 2 : 0, it.mode === "bar" ? it.h / 2 : 0, 0]}>
              <planeGeometry args={[it.w, it.h]} />
              <meshBasicMaterial color={it.color} transparent toneMapped={false} />
            </mesh>
          </group>
        </group>
      ))}
    </group>
  );
}

/* ------------------------------ furniture -------------------------- */

function Plant({ pos }: { pos: Vec3 }) {
  return (
    <group position={pos}>
      <mesh position={[0, 0.3, 0]} material={M.pot} castShadow>
        <boxGeometry args={[0.6, 0.6, 0.6]} />
      </mesh>
      <mesh position={[0, 0.95, 0]} material={M.leaf} castShadow>
        <boxGeometry args={[0.8, 0.7, 0.8]} />
      </mesh>
      <mesh position={[0.15, 1.5, -0.1]} material={M.leaf2} castShadow>
        <boxGeometry args={[0.55, 0.55, 0.55]} />
      </mesh>
    </group>
  );
}

function DeptProp({ dept, active, still }: { dept: DeptKey; active: boolean; still: boolean }) {
  const blink = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (!blink.current) return;
    blink.current.children.forEach((c, i) => {
      const on = active && !still ? Math.sin(clock.elapsedTime * (3 + (i % 4)) + i) > 0 : i % 3 === 0;
      (c as THREE.Mesh).visible = on;
    });
  });
  const color = DEPTS[dept].color;
  if (dept === "eng") {
    return (
      <group position={[-3.1, 0, -5.6]}>
        <mesh position={[0, 1.5, 0]} material={M.rack} castShadow>
          <boxGeometry args={[1.1, 3, 1]} />
        </mesh>
        <group ref={blink}>
          {Array.from({ length: 15 }, (_, i) => (
            <mesh key={i} position={[-0.33 + (i % 3) * 0.33, 0.5 + Math.floor(i / 3) * 0.5, 0.52]}>
              <boxGeometry args={[0.14, 0.14, 0.04]} />
              <meshBasicMaterial color={i % 4 === 0 ? "#3DDC97" : color} toneMapped={false} />
            </mesh>
          ))}
        </group>
      </group>
    );
  }
  if (dept === "creative") {
    return (
      <group position={[-2.9, 0, -4.6]} rotation={[0, 0.5, 0]}>
        {[-0.3, 0.3, 0].map((x, i) => (
          <mesh key={i} position={[x, 0.7, i === 2 ? -0.3 : 0.15]} material={M.metal} castShadow>
            <boxGeometry args={[0.08, 1.4, 0.08]} />
          </mesh>
        ))}
        <mesh position={[0, 1.6, 0]} material={M.metal} castShadow>
          <boxGeometry args={[0.7, 0.5, 0.5]} />
        </mesh>
        <mesh position={[0, 1.6, 0.36]} material={M.rack}>
          <boxGeometry args={[0.34, 0.34, 0.3]} />
        </mesh>
        <mesh position={[0.25, 1.92, 0]} visible={active}>
          <boxGeometry args={[0.12, 0.12, 0.12]} />
          <meshBasicMaterial color={RED} toneMapped={false} />
        </mesh>
        <mesh position={[1.3, 1.5, -0.9]} castShadow>
          <boxGeometry args={[0.2, 3, 2.2]} />
          <meshStandardMaterial color={color} roughness={1} />
        </mesh>
      </group>
    );
  }
  if (dept === "data") {
    return (
      <group position={[-3.2, 0, -5.9]}>
        {[0, 1].map((i) => (
          <group key={i} position={[i * 0.95, 0, 0]}>
            <mesh position={[0, 0.8, 0]} material={M.wallSide} castShadow>
              <boxGeometry args={[0.85, 1.6, 0.8]} />
            </mesh>
            {[0.35, 0.85, 1.35].map((y) => (
              <mesh key={y} position={[0, y, 0.42]} material={M.metal}>
                <boxGeometry args={[0.3, 0.06, 0.04]} />
              </mesh>
            ))}
          </group>
        ))}
        <mesh position={[0.45, 1.75, 0]} material={M.paper} castShadow>
          <boxGeometry args={[0.7, 0.3, 0.5]} />
        </mesh>
      </group>
    );
  }
  if (dept === "research") {
    return (
      <group position={[-3.2, 0, -6.2]}>
        <mesh position={[0.5, 1.6, 0]} material={M.woodDark} castShadow>
          <boxGeometry args={[2, 3.2, 0.7]} />
        </mesh>
        {[0.5, 1.3, 2.1, 2.9].map((y, r) =>
          [0, 1, 2, 3, 4, 5].map((i) => (
            <mesh key={`${r}${i}`} position={[-0.25 + i * 0.3, y + 0.05, 0.3]} castShadow>
              <boxGeometry args={[0.22, 0.5 + ((i + r) % 3) * 0.06, 0.3]} />
              <meshStandardMaterial color={[color, "#F4E8DE", C.burgundy, C.clay][(i + r) % 4] ?? color} roughness={1} />
            </mesh>
          )),
        )}
      </group>
    );
  }
  if (dept === "ads") {
    return (
      <group position={[-3.1, 0, -5.4]}>
        <mesh position={[0, 1.5, 0]} material={M.metal} castShadow>
          <boxGeometry args={[0.12, 3, 0.12]} />
        </mesh>
        <mesh position={[0, 2.5, 0.2]} castShadow>
          <boxGeometry args={[1.5, 1, 0.14]} />
          <meshStandardMaterial color={color} roughness={0.8} />
        </mesh>
        <mesh position={[0, 2.5, 0.28]}>
          <boxGeometry args={[0.9, 0.16, 0.04]} />
          <meshBasicMaterial color="#FFFFFF" />
        </mesh>
      </group>
    );
  }
  return (
    <group position={[-3, 0, -5.4]}>
      <mesh position={[0, 0.5, 0]} castShadow>
        <boxGeometry args={[1.5, 1, 1]} />
        <meshStandardMaterial color={color} roughness={1} />
      </mesh>
      <mesh position={[0, 1.25, -0.35]} castShadow>
        <boxGeometry args={[1.5, 0.6, 0.3]} />
        <meshStandardMaterial color={color} roughness={1} />
      </mesh>
      {[0, 1, 2].map((i) => (
        <mesh key={i} position={[1.4, 0.2 + i * 0.16, 0.2]} material={M.paper} castShadow>
          <boxGeometry args={[0.7, 0.12, 0.5]} />
        </mesh>
      ))}
    </group>
  );
}

function Sign({ state }: { state: RoomState }) {
  const ref = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (ref.current) {
      ref.current.position.y = 2.95 + Math.sin(clock.elapsedTime * 4) * 0.08;
      ref.current.rotation.y = clock.elapsedTime * 1.4;
    }
  });
  if (state !== "waiting" && state !== "failed" && state !== "done") return null;
  const color = state === "waiting" ? AMBER : state === "failed" ? RED : GREEN;
  return (
    <group ref={ref} position={[0, 2.95, -3.5]}>
      {state === "done" ? (
        <>
          <mesh position={[-0.12, -0.05, 0]} rotation={[0, 0, 0.8]}>
            <boxGeometry args={[0.14, 0.34, 0.14]} />
            <meshBasicMaterial color={color} toneMapped={false} />
          </mesh>
          <mesh position={[0.1, 0.08, 0]} rotation={[0, 0, -0.7]}>
            <boxGeometry args={[0.14, 0.62, 0.14]} />
            <meshBasicMaterial color={color} toneMapped={false} />
          </mesh>
        </>
      ) : (
        <>
          <mesh position={[0, 0.16, 0]}>
            <boxGeometry args={[0.16, 0.5, 0.16]} />
            <meshBasicMaterial color={color} toneMapped={false} />
          </mesh>
          <mesh position={[0, -0.24, 0]}>
            <boxGeometry args={[0.16, 0.16, 0.16]} />
            <meshBasicMaterial color={color} toneMapped={false} />
          </mesh>
        </>
      )}
    </group>
  );
}

const POSE: Record<RoomState, Pose> = { idle: "idle", working: "typing", waiting: "wave", done: "cheer", failed: "slump", handoff: "talk" };

function RoomBox({
  room,
  x,
  state,
  still,
  focused,
  dimmed,
  showLabel,
  labelScale,
  layer,
  onSelect,
}: {
  layer: React.RefObject<HTMLElement>;
  labelScale: number;
  room: Room;
  x: number;
  state: RoomState;
  still: boolean;
  focused: boolean;
  dimmed: boolean;
  showLabel: boolean;
  onSelect: (id: string) => void;
}) {
  const [hover, setHover] = useState(false);
  const edge = useRef<THREE.MeshBasicMaterial>(null);
  const color = stateColor(state, room.dept);
  const active = state === "working" || state === "handoff";

  useFrame(({ clock }) => {
    if (!edge.current) return;
    const pulse = state === "waiting" && !still ? 0.55 + 0.45 * Math.abs(Math.sin(clock.elapsedTime * 3)) : 1;
    edge.current.opacity = (state === "idle" ? 0.35 : 1) * pulse;
  });

  return (
    <group
      position={[x, 0, 0]}
      onClick={(e) => {
        e.stopPropagation();
        document.body.style.cursor = "";
        onSelect(room.id);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHover(true);
        if (!focused) document.body.style.cursor = "pointer";
      }}
      onPointerOut={() => {
        setHover(false);
        document.body.style.cursor = "";
      }}
    >
      {/* shell */}
      <mesh position={[0, -0.1, -D / 2]} material={M.wood} receiveShadow>
        <boxGeometry args={[ROOM_W - 0.3, 0.2, D]} />
      </mesh>
      {[-2.4, -0.8, 0.8, 2.4].map((px) => (
        <mesh key={px} position={[px, 0.005, -D / 2]} material={M.woodDark}>
          <boxGeometry args={[0.04, 0.01, D]} />
        </mesh>
      ))}
      <mesh position={[0, WALL_H / 2, -D]} material={M.wall} receiveShadow>
        <boxGeometry args={[ROOM_W - 0.3, WALL_H, 0.2]} />
      </mesh>
      <mesh position={[0, 0.2, -D + 0.14]} material={M.skirting}>
        <boxGeometry args={[ROOM_W - 0.3, 0.4, 0.1]} />
      </mesh>
      <mesh position={[0, WALL_H - 0.22, -D + 0.13]}>
        <boxGeometry args={[ROOM_W - 0.3, 0.44, 0.08]} />
        <meshStandardMaterial color={DEPTS[room.dept].color} roughness={0.9} />
      </mesh>
      {/* front edge shows the room's state */}
      <mesh position={[0, 0.02, 0.06]}>
        <boxGeometry args={[ROOM_W - 0.3, 0.26, 0.14]} />
        <meshBasicMaterial ref={edge} color={hover && !focused ? "#FFFFFF" : color} transparent toneMapped={false} />
      </mesh>

      {/* window with a view */}
      <group position={[2.75, 2.9, -D + 0.13]}>
        <mesh material={M.sky}>
          <planeGeometry args={[1.5, 2.1]} />
        </mesh>
        <mesh position={[-0.2, 0.4, 0.01]} material={M.cloud}>
          <planeGeometry args={[0.6, 0.22]} />
        </mesh>
        <mesh position={[0, 0, 0.03]} material={M.skirting}>
          <boxGeometry args={[0.07, 2.1, 0.05]} />
        </mesh>
        <mesh position={[0, 0, 0.03]} material={M.skirting}>
          <boxGeometry args={[1.5, 0.07, 0.05]} />
        </mesh>
        {[
          [0, 1.1, 1.74, 0.14],
          [0, -1.1, 1.74, 0.14],
          [-0.8, 0, 0.14, 2.3],
          [0.8, 0, 0.14, 2.3],
        ].map(([px, py, w, h], i) => (
          <mesh key={i} position={[px ?? 0, py ?? 0, 0.04]} material={M.skirting}>
            <boxGeometry args={[w ?? 1, h ?? 1, 0.1]} />
          </mesh>
        ))}
      </group>

      <WallScreen dept={room.dept} active={active} still={still} />
      <DeptProp dept={room.dept} active={active} still={still} />
      <Plant pos={[3.3, 0, -1.1]} />

      {/* rug, standing desk, laptop */}
      <mesh position={[0.2, 0.012, -3.1]}>
        <boxGeometry args={[4.4, 0.02, 2.8]} />
        <meshStandardMaterial color={DEPTS[room.dept].color} roughness={1} transparent opacity={0.3} />
      </mesh>
      <group position={[0.2, 0, -2.5]}>
        <mesh position={[0, 1.2, 0]} material={M.desk} castShadow receiveShadow>
          <boxGeometry args={[3.2, 0.12, 1.2]} />
        </mesh>
        {[-1.4, 1.4].map((px) => (
          <mesh key={px} position={[px, 0.6, 0]} material={M.metal} castShadow>
            <boxGeometry args={[0.12, 1.2, 0.9]} />
          </mesh>
        ))}
        <mesh position={[0, 1.29, -0.1]} material={M.metal}>
          <boxGeometry args={[0.95, 0.05, 0.62]} />
        </mesh>
        <mesh position={[0, 1.6, 0.26]} rotation={[0.22, 0, 0]} material={M.metal} castShadow>
          <boxGeometry args={[0.95, 0.62, 0.05]} />
        </mesh>
        <mesh position={[0, 1.6, 0.3]} rotation={[0.22, 0, 0]}>
          <boxGeometry args={[0.2, 0.2, 0.02]} />
          <meshBasicMaterial color={active ? color : "#6B625C"} toneMapped={false} />
        </mesh>
        <mesh position={[1.15, 1.36, 0.1]} material={M.paper} castShadow>
          <boxGeometry args={[0.22, 0.2, 0.22]} />
        </mesh>
        {[0, 1, 2].map((i) => (
          <mesh key={i} position={[-1.05, 1.29 + i * 0.045, 0.05]} rotation={[0, 0.2 * i - 0.2, 0]} material={M.paper}>
            <boxGeometry args={[0.6, 0.04, 0.44]} />
          </mesh>
        ))}
      </group>

      <group position={[0.2, 0, -3.5]} scale={1.3}>
        <Person seed={room.index + 2} tie={DEPTS[room.dept].color} pose={POSE[state]} still={still} />
      </group>
      <Sign state={state} />

      {showLabel && (
        <Html portal={layer} position={[0, WALL_H + 1.05, -D]} center zIndexRange={[20, 0]} style={{ pointerEvents: "none", opacity: dimmed ? 0.35 : 1 }}>
          <div
            style={{
              width: 132,
              transform: `scale(${labelScale})`,
              transformOrigin: "50% 100%",
              textAlign: "center",
              padding: "8px 10px 9px",
              background: C.surface,
              border: `1.5px solid ${state === "idle" ? C.panel : color}`,
              borderRadius: 14,
              color: C.ink,
              boxShadow: "0 2px 0 rgba(26,14,11,0.12)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, font: `600 12.5px/1.2 ${SANS}` }}>
              <span style={{ flex: "none", width: 8, height: 8, borderRadius: 8, background: DEPTS[room.dept].color }} />
              {DEPTS[room.dept].name}
            </div>
            <div style={{ marginTop: 3, font: `${state === "idle" ? 400 : 600} 12px/1.2 ${SANS}`, color: STATE_TEXT[state] }}>{STATE_LABEL[state]}</div>
          </div>
        </Html>
      )}
    </group>
  );
}

function Document({ from, to, color, onDone }: { from: THREE.Vector3; to: THREE.Vector3; color: string; onDone: () => void }) {
  const ref = useRef<THREE.Group>(null);
  const t = useRef(0);
  const done = useRef(false);
  useFrame((_, dt) => {
    t.current = Math.min(1, t.current + dt / 1.1);
    const k = t.current;
    const e = k * k * (3 - 2 * k);
    if (ref.current) {
      ref.current.position.lerpVectors(from, to, e);
      ref.current.position.y += Math.sin(k * Math.PI) * 1.4;
      ref.current.rotation.y = k * 6;
    }
    if (k >= 1 && !done.current) {
      done.current = true;
      onDone();
    }
  });
  return (
    <group ref={ref} position={from}>
      <mesh material={M.paper} castShadow>
        <boxGeometry args={[0.7, 0.08, 0.5]} />
      </mesh>
      <mesh position={[0, 0.05, 0]}>
        <boxGeometry args={[0.7, 0.02, 0.12]} />
        <meshBasicMaterial color={color === "#FFFFFF" ? C.coral : color} toneMapped={false} />
      </mesh>
    </group>
  );
}

export function FloorScene({
  floorIndex,
  focusId,
  sim,
  stopped,
  still,
  couriers,
  onCourierDone,
  onSelect,
  layer,
}: {
  layer: React.RefObject<HTMLElement>;
  floorIndex: number;
  focusId: string | null;
  sim: Sim;
  stopped: boolean;
  still: boolean;
  couriers: Courier[];
  onCourierDone: (id: number) => void;
  onSelect: (id: string) => void;
}) {
  const floor = FLOORS[floorIndex];
  const rooms = useMemo(() => ROOMS.filter((r) => r.floorIndex === floorIndex), [floorIndex]);
  const n = rooms.length;
  const width = n * ROOM_W;
  const size = useThree((st) => st.size);
  const labelScale = useMemo(() => {
    const cam = floorCamera(floorIndex, null, size.width / size.height);
    const pxPerUnit = size.height / (2 * Math.tan((38 * Math.PI) / 360) * (cam.pos[2] + 7));
    return Math.max(0.62, Math.min(1, (ROOM_W * pxPerUnit - 8) / 132));
  }, [floorIndex, size.width, size.height]);

  const docs = useMemo(
    () =>
      couriers
        .map((c) => {
          const to = ROOM_BY_ID[c.toId];
          if (!to || to.floorIndex !== floorIndex) return null;
          const from = ROOM_BY_ID[c.fromId];
          const end = new THREE.Vector3(roomX(to.slot, n) - 0.85, 1.4, -2.45);
          const start = from && from.floorIndex === floorIndex ? new THREE.Vector3(roomX(from.slot, n) - 0.85, 1.4, -2.45) : new THREE.Vector3(roomX(to.slot, n), 7.5, -2.5);
          return { c, start, end };
        })
        .filter((d) => d !== null),
    [couriers, floorIndex, n],
  );

  if (!floor) return null;
  return (
    <group>
      <color attach="background" args={[C.light]} />
      <ambientLight intensity={1.25} color="#FFF4E8" />
      <directionalLight
        castShadow
        position={[10, 18, 14]}
        intensity={1.9}
        color="#FFE9D2"
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-28}
        shadow-camera-right={28}
        shadow-camera-top={16}
        shadow-camera-bottom={-12}
        shadow-bias={-0.0004}
      />
      {/* studio floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.42, 0]} receiveShadow>
        <planeGeometry args={[400, 400]} />
        <meshStandardMaterial color={C.cream} roughness={1} />
      </mesh>

      {/* the slab and the corridor in front of the rooms */}
      <mesh position={[0, -0.3, -1.6]} material={M.slab} castShadow receiveShadow>
        <boxGeometry args={[width + 0.6, 0.24, D + 4.2]} />
      </mesh>
      <mesh position={[0, -0.17, 1.4]} material={M.runner} receiveShadow>
        <boxGeometry args={[width - 0.4, 0.03, 1.5]} />
      </mesh>
      {[0.62, 2.18].map((z) => (
        <mesh key={z} position={[0, -0.165, z]} material={M.runnerEdge}>
          <boxGeometry args={[width - 0.4, 0.035, 0.07]} />
        </mesh>
      ))}
      {/* walls between rooms */}
      {Array.from({ length: n + 1 }, (_, i) => (
        <mesh key={i} position={[(i - n / 2) * ROOM_W, WALL_H / 2, -D / 2]} material={M.wallSide} castShadow receiveShadow>
          <boxGeometry args={[0.3, WALL_H, D + 0.2]} />
        </mesh>
      ))}
      <mesh position={[0, WALL_H + 0.12, -D]} material={M.skirting} castShadow>
        <boxGeometry args={[width + 0.5, 0.24, 0.5]} />
      </mesh>

      {rooms.map((room) => {
        const state: RoomState = stopped ? "idle" : (sim[room.id]?.state ?? "idle");
        return (
          <RoomBox
            key={room.id}
            room={room}
            x={roomX(room.slot, n)}
            state={state}
            still={still}
            focused={focusId === room.id}
            dimmed={!!focusId && focusId !== room.id}
            showLabel={!focusId}
            labelScale={labelScale}
            layer={layer}
            onSelect={onSelect}
          />
        );
      })}

      {/* someone always walking the corridor */}
      {!stopped && <Walker width={width} still={still} />}

      {docs.map((d) => (
        <Document key={d.c.id} from={d.start} to={d.end} color={d.c.color} onDone={() => onCourierDone(d.c.id)} />
      ))}
    </group>
  );
}

function Walker({ width, still }: { width: number; still: boolean }) {
  const ref = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    const g = ref.current;
    if (!g) return;
    const span = width / 2 - 1;
    const t = still ? 0.3 : clock.elapsedTime * 0.16;
    const phase = (t % 2) < 1 ? t % 1 : 1 - (t % 1);
    g.position.x = -span + phase * span * 2;
    g.rotation.y = (t % 2) < 1 ? Math.PI / 2 : -Math.PI / 2;
  });
  return (
    <group ref={ref} position={[0, -0.16, 1.4]} scale={1.3}>
      <Person seed={11} tie={C.coral} pose={still ? "idle" : "carry"} still={still} suit="#2B2B31" />
      <mesh position={[0, 0.78, 0.42]} material={M.paper}>
        <boxGeometry args={[0.34, 0.05, 0.26]} />
      </mesh>
    </group>
  );
}
