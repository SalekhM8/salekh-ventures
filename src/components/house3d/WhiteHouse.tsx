"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { Html, Trail } from "@react-three/drei";
import * as THREE from "three";
import { Person } from "./Person";
import {
  C,
  CHIEF_POINT,
  DEPTS,
  FLOORS,
  FLOOR_WIN,
  ROOMS,
  ROOM_BY_ID,
  SANS,
  SERIF,
  STATE_LABEL,
  STATE_TEXT,
  stateColor,
  type Courier,
  type Room,
  type RoomState,
  type Sim,
  type Vec3,
} from "./model";

/* ------------------------------ materials -------------------------- */

const std = (color: string, roughness = 0.82, extra: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness, ...extra });

const MAT = {
  wall: std("#F5F2EA"),
  base: std("#ECE8DD"),
  trim: std("#FFFFFF", 0.7),
  iron: std("#22252B", 0.5, { metalness: 0.5 }),
  door: std("#1E4A35", 0.55),
  roof: std("#C9C6BC"),
  glassDark: std("#1C2533", 0.15, { metalness: 0.3 }),
  glassWarm: std("#3A2E1C", 0.3, { emissive: new THREE.Color("#FFC878"), emissiveIntensity: 0.55 }),
  lawn: std("#6F9E57", 1),
  lawnLight: std("#83B266", 1),
  path: std("#E6DCC8", 1),
  stone: std("#DAD5C8", 0.9),
  water: std("#6FC6EA", 0.15, { metalness: 0.2 }),
  trunk: std("#6B4A2E", 1),
  leafA: std("#3F7D3A", 1, { flatShading: true }),
  leafB: std("#56963F", 1, { flatShading: true }),
  leafC: std("#7FB24C", 1, { flatShading: true }),
  hedge: std("#3B6E36", 1),
  lamp: std("#FFE2A6", 0.4, { emissive: new THREE.Color("#FFD27A"), emissiveIntensity: 2.2 }),
  groove: std("#CFC9BB", 1),
};

/* Labels are drawn into a layer the house owns, not into the canvas wrapper. */
export type Layer = React.RefObject<HTMLElement>;

const SZ = 13; // south wall
const arc = (a: number, r: number, y: number): Vec3 => [Math.sin(a) * r, y, SZ + Math.cos(a) * r];

function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/* ------------------------------ small parts ------------------------ */

function Posts({ points, size, material }: { points: Vec3[]; size: Vec3; material: THREE.Material }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    points.forEach((p, i) => {
      m.makeTranslation(p[0], p[1], p[2]);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [points]);
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, points.length]} material={material} castShadow>
      <boxGeometry args={size} />
    </instancedMesh>
  );
}

function Column({ pos, h, r }: { pos: Vec3; h: number; r: number }) {
  return (
    <group position={pos}>
      <mesh position={[0, 0.18, 0]} material={MAT.trim} castShadow>
        <cylinderGeometry args={[r * 1.3, r * 1.45, 0.36, 20]} />
      </mesh>
      <mesh position={[0, 0.36 + (h - 1) / 2, 0]} material={MAT.trim} castShadow receiveShadow>
        <cylinderGeometry args={[r * 0.86, r, h - 1, 24]} />
      </mesh>
      <mesh position={[0, h - 0.5, 0]} material={MAT.trim} castShadow>
        <cylinderGeometry args={[r * 1.2, r * 0.88, 0.3, 20]} />
      </mesh>
      <mesh position={[0, h - 0.18, 0]} material={MAT.trim} castShadow>
        <boxGeometry args={[r * 2.8, 0.36, r * 2.8]} />
      </mesh>
    </group>
  );
}

type Hood = "tri" | "arc" | undefined;

function WindowFrame({ w, h, hood }: { w: number; h: number; hood?: Hood }) {
  return (
    <>
      <mesh position={[0, -h / 2 - 0.08, 0.14]} material={MAT.trim} castShadow>
        <boxGeometry args={[w + 0.56, 0.16, 0.32]} />
      </mesh>
      <mesh position={[0, h / 2 + 0.09, 0.1]} material={MAT.trim}>
        <boxGeometry args={[w + 0.44, 0.18, 0.24]} />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[s * (w / 2 + 0.08), 0, 0.08]} material={MAT.trim}>
          <boxGeometry args={[0.16, h, 0.2]} />
        </mesh>
      ))}
      <mesh position={[0, 0, 0.05]} material={MAT.trim}>
        <boxGeometry args={[0.07, h, 0.06]} />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[0, (s * h) / 6, 0.05]} material={MAT.trim}>
          <boxGeometry args={[w, 0.06, 0.06]} />
        </mesh>
      ))}
      {hood === "tri" && (
        <mesh position={[0, h / 2 + 0.52, 0.16]} rotation={[Math.PI / 2, 0, 0]} scale={[1, 1, 0.44]} material={MAT.trim} castShadow>
          <cylinderGeometry args={[(w + 1) / 1.732, (w + 1) / 1.732, 0.34, 3, 1, false, Math.PI]} />
        </mesh>
      )}
      {hood === "arc" && (
        <mesh position={[0, h / 2 + 0.2, 0.16]} rotation={[Math.PI / 2, 0, 0]} scale={[1, 1, 0.5]} material={MAT.trim} castShadow>
          <cylinderGeometry args={[(w + 0.8) / 2, (w + 0.8) / 2, 0.34, 20, 1, false, Math.PI / 2, Math.PI]} />
        </mesh>
      )}
    </>
  );
}

function PlainWindow({ pos, rotY = 0, w, h, hood, warm }: { pos: Vec3; rotY?: number; w: number; h: number; hood?: Hood; warm?: boolean }) {
  return (
    <group position={pos} rotation={[0, rotY, 0]}>
      <mesh position={[0, 0, 0.02]} material={warm ? MAT.glassWarm : MAT.glassDark}>
        <planeGeometry args={[w, h]} />
      </mesh>
      <WindowFrame w={w} h={h} hood={hood} />
    </group>
  );
}

/* A room: a window on the south front that lights in its department's colour. */
function RoomWindow({
  room,
  state,
  hood,
  showLabel,
  floorLabel,
  layer,
  labelSize,
  onSelect,
}: {
  labelSize: number;
  layer: Layer;
  floorLabel: string;
  room: Room;
  state: RoomState;
  hood?: Hood;
  showLabel: boolean;
  onSelect: (id: string) => void;
}) {
  const mat = useRef<THREE.MeshStandardMaterial>(null);
  const [hover, setHover] = useState(false);
  const color = stateColor(state, room.dept);
  const target = useMemo(() => new THREE.Color(color), [color]);

  useFrame(({ clock }) => {
    const m = mat.current;
    if (!m) return;
    const t = clock.elapsedTime;
    m.emissive.lerp(target, 0.12);
    let k = 0.22;
    if (state === "working" || state === "handoff") k = 1.5 + Math.sin(t * 7 + room.pos[0]) * 0.25;
    if (state === "waiting") k = 1.5 + Math.sin(t * 5) * 0.9;
    if (state === "done") k = 1.9;
    if (state === "failed") k = Math.sin(t * 9) > 0 ? 1.8 : 0.5;
    m.emissiveIntensity += ((hover ? k + 0.6 : k) - m.emissiveIntensity) * 0.15;
  });

  const over = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setHover(true);
    document.body.style.cursor = "pointer";
  };
  const out = () => {
    setHover(false);
    document.body.style.cursor = "";
  };

  return (
    <group position={room.pos}>
      <mesh
        position={[0, 0, 0.02]}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(room.id);
        }}
        onPointerOver={over}
        onPointerOut={out}
      >
        <planeGeometry args={[room.w + 0.5, room.h + 0.5]} />
        <meshStandardMaterial ref={mat} color="#10151D" emissive={color} emissiveIntensity={0.22} roughness={0.3} />
      </mesh>
      <WindowFrame w={room.w} h={room.h} hood={hood} />
      {showLabel && (state === "waiting" || state === "failed" || hover) && (
        <Html portal={layer} position={[0, room.h / 2 + 1.05, 0.6]} center distanceFactor={labelSize} zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
          <div
            style={{
              whiteSpace: "nowrap",
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "6px 12px",
              background: C.surface,
              border: `1.5px solid ${color}`,
              borderRadius: 999,
              color: C.ink,
              font: `600 13px/1 ${SANS}`,
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: 8, background: DEPTS[room.dept].color }} />
            {floorLabel} · {DEPTS[room.dept].name}
            <span style={{ color: STATE_TEXT[state], fontWeight: 500 }}>{STATE_LABEL[state]}</span>
          </div>
        </Html>
      )}
    </group>
  );
}

function CourierOrb({ c, onDone }: { c: Courier; onDone: (id: number) => void }) {
  const ref = useRef<THREE.Mesh>(null);
  const t = useRef(0);
  const curve = useMemo(() => {
    const a = new THREE.Vector3(...(ROOM_BY_ID[c.fromId]?.pos ?? CHIEF_POINT));
    const b = new THREE.Vector3(...(ROOM_BY_ID[c.toId]?.pos ?? CHIEF_POINT));
    const mid = a.clone().add(b).multiplyScalar(0.5).add(new THREE.Vector3(0, 5, 9));
    return new THREE.QuadraticBezierCurve3(a, mid, b);
  }, [c]);
  const dur = useMemo(() => Math.max(1.1, curve.getLength() / 22), [curve]);

  useFrame((_, dt) => {
    t.current += dt / dur;
    if (t.current >= 1) {
      onDone(c.id);
      return;
    }
    if (ref.current) ref.current.position.copy(curve.getPoint(t.current));
  });

  return (
    <Trail width={2.2} length={7} color={c.color} attenuation={(w) => w * w}>
      <mesh ref={ref} position={ROOM_BY_ID[c.fromId]?.pos ?? CHIEF_POINT}>
        <boxGeometry args={[0.5, 0.5, 0.5]} />
        <meshBasicMaterial color={c.color} toneMapped={false} />
      </mesh>
    </Trail>
  );
}

function Tree({ pos, s, phase }: { pos: Vec3; s: number; phase: number }) {
  const ref = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (ref.current) ref.current.rotation.z = Math.sin(clock.elapsedTime * 0.8 + phase) * 0.02;
  });
  return (
    <group ref={ref} position={pos} scale={s}>
      <mesh position={[0, 1.6, 0]} material={MAT.trunk} castShadow>
        <boxGeometry args={[0.7, 3.2, 0.7]} />
      </mesh>
      <mesh position={[0, 4.2, 0]} material={MAT.leafA} castShadow>
        <boxGeometry args={[4.2, 2, 4.2]} />
      </mesh>
      <mesh position={[0, 5.9, 0]} material={MAT.leafB} castShadow>
        <boxGeometry args={[3, 1.4, 3]} />
      </mesh>
      <mesh position={[0, 7, 0]} material={MAT.leafC} castShadow>
        <boxGeometry args={[1.6, 0.9, 1.6]} />
      </mesh>
    </group>
  );
}

function Fountain({ still }: { still: boolean }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const N = 70;
  const seeds = useMemo(() => {
    const r = seeded(5);
    return Array.from({ length: N }, () => ({ a: r() * Math.PI * 2, v: 0.6 + r() * 1.6, p: r() }));
  }, []);
  const m = useMemo(() => new THREE.Matrix4(), []);
  useFrame(({ clock }) => {
    const mesh = ref.current;
    if (!mesh) return;
    const time = still ? 0.4 : clock.elapsedTime * 0.55;
    seeds.forEach((s, i) => {
      const t = (time + s.p) % 1;
      const rad = s.v * t * 2.2;
      m.makeTranslation(Math.cos(s.a) * rad, 0.9 + 9 * t - 9 * t * t * 1.05, Math.sin(s.a) * rad);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });
  return (
    <group position={[0, 0, 52]}>
      <mesh position={[0, 0.3, 0]} material={MAT.stone} castShadow receiveShadow>
        <cylinderGeometry args={[5.2, 5.5, 0.6, 48]} />
      </mesh>
      <mesh position={[0, 0.62, 0]} material={MAT.water}>
        <cylinderGeometry args={[4.7, 4.7, 0.06, 48]} />
      </mesh>
      <mesh position={[0, 0.9, 0]} material={MAT.stone} castShadow>
        <cylinderGeometry args={[0.5, 0.8, 0.9, 16]} />
      </mesh>
      <instancedMesh ref={ref} args={[undefined, undefined, N]}>
        <sphereGeometry args={[0.11, 6, 6]} />
        <meshBasicMaterial color="#DDF4FF" />
      </instancedMesh>
    </group>
  );
}

function Smoke({ pos, still }: { pos: Vec3; still: boolean }) {
  const group = useRef<THREE.Group>(null);
  const puffs = useMemo(() => Array.from({ length: 6 }, (_, i) => i / 6), []);
  useFrame(({ clock }) => {
    const g = group.current;
    if (!g) return;
    g.children.forEach((child, i) => {
      const t = ((still ? 0.3 : clock.elapsedTime * 0.16) + (puffs[i] ?? 0)) % 1;
      child.position.set(Math.sin(t * 5 + i) * 0.5 + t * 2.4, t * 7, 0);
      child.scale.setScalar(0.5 + t * 1.5);
      const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
      mat.opacity = 0.6 * (1 - t);
    });
  });
  return (
    <group ref={group} position={pos}>
      {puffs.map((p) => (
        <mesh key={p}>
          <sphereGeometry args={[0.7, 10, 10]} />
          <meshBasicMaterial color="#FFFFFF" transparent opacity={0.4} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
}

function Patrol({ radius, centre, speed, y, color, still, phase, sx = 1 }: { radius: number; centre: Vec3; speed: number; y: number; color: string; still: boolean; phase: number; sx?: number }) {
  const ref = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    const g = ref.current;
    if (!g) return;
    const a = (still ? 0 : clock.elapsedTime * speed) + phase;
    const nx = Math.cos(a) * radius * sx * Math.sign(speed || 1);
    const nz = -Math.sin(a) * radius * Math.sign(speed || 1);
    g.position.set(centre[0] + Math.sin(a) * radius * sx, y, centre[2] + Math.cos(a) * radius);
    g.rotation.y = Math.atan2(nx, nz);
  });
  return (
    <group ref={ref} scale={2.1}>
      <Person seed={Math.round(phase * 3) + 1} tie={color} pose={still ? "idle" : "walk"} still={still} />
    </group>
  );
}

function Clouds({ still }: { still: boolean }) {
  const ref = useRef<THREE.Group>(null);
  const clouds = useMemo(() => {
    const r = seeded(21);
    return Array.from({ length: 9 }, () => ({
      x: -160 + r() * 320,
      y: 46 + r() * 22,
      z: -120 + r() * 90,
      s: 3 + r() * 4,
      v: 0.5 + r() * 0.8,
    }));
  }, []);
  useFrame((_, dt) => {
    if (still || !ref.current) return;
    ref.current.children.forEach((c, i) => {
      c.position.x += dt * (clouds[i]?.v ?? 0.5);
      if (c.position.x > 180) c.position.x = -180;
    });
  });
  return (
    <group ref={ref}>
      {clouds.map((c, i) => (
        <group key={i} position={[c.x, c.y, c.z]} scale={c.s}>
          {[
            [0, 0, 0, 1.4],
            [1.5, 0.2, 0, 1.1],
            [-1.5, 0.1, 0.2, 1],
            [0.5, 0.7, -0.2, 0.95],
          ].map(([x, y, z, s], k) => (
            <mesh key={k} position={[x ?? 0, y ?? 0, z ?? 0]} scale={s}>
              <boxGeometry args={[2.4, 0.7, 1.7]} />
              <meshBasicMaterial color="#FFF4E6" />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  );
}

/* ------------------------------ the house -------------------------- */

const SIDE_BAYS = [-23.5, -19.5, -15.5, -11.5, 11.5, 15.5, 19.5, 23.5];
const BOW_COLS = [-72, -43, -14, 14, 43, 72].map((d) => (d * Math.PI) / 180);

export function WhiteHouse({
  sim,
  stopped,
  still,
  couriers,
  onCourierDone,
  onSelect,
  onEnter,
  onFloor,
  names,
  layer,
  phone = false,
}: {
  phone?: boolean;
  layer: Layer;
  names: Record<string, string>;
  sim: Sim;
  stopped: boolean;
  still: boolean;
  couriers: Courier[];
  onCourierDone: (id: number) => void;
  onSelect: (id: string) => void;
  onEnter: () => void;
  onFloor: (floorIndex: number) => void;
}) {
  const labelSize = phone ? 92 : 36;
  const [front, setFront] = useState(true);
  const frontRef = useRef(true);
  const [doorHover, setDoorHover] = useState(false);
  const beacon = useRef<THREE.Mesh>(null);

  useFrame(({ camera, clock }) => {
    const f = camera.position.z > 8;
    if (f !== frontRef.current) {
      frontRef.current = f;
      setFront(f);
    }
    if (beacon.current) {
      const s = stopped ? 1 : 1 + (Math.sin(clock.elapsedTime * 3) + 1) * 0.35;
      beacon.current.scale.setScalar(s);
    }
  });

  const roomAt = useMemo(() => {
    const map = new Map<string, Room>();
    for (const r of ROOMS) map.set(`${r.floorIndex}:${r.pos[0]}`, r);
    return map;
  }, []);

  const plain = useMemo(() => {
    const rnd = seeded(3);
    const out: { key: string; pos: Vec3; rotY: number; w: number; h: number; hood: Hood; warm: boolean }[] = [];
    FLOOR_WIN.forEach((fw, fi) => {
      const bays = fi === 0 ? SIDE_BAYS.filter((x) => Math.abs(x) < 23) : SIDE_BAYS;
      bays.forEach((x, bi) => {
        const hood: Hood = fi === 2 ? (bi % 2 === 0 ? "tri" : "arc") : undefined;
        if (!roomAt.has(`${fi}:${x}`)) out.push({ key: `s${fi}${x}`, pos: [x, fw.y, fw.z], rotY: 0, w: fw.w, h: fw.h, hood, warm: rnd() > 0.55 });
        out.push({ key: `n${fi}${x}`, pos: [x, fw.y, -fw.z], rotY: Math.PI, w: fw.w, h: fw.h, hood, warm: rnd() > 0.5 });
      });
      if (fi > 0) {
        [-8, 0, 8].forEach((z) => {
          out.push({ key: `e${fi}${z}`, pos: [25.52, fw.y, z], rotY: Math.PI / 2, w: fw.w, h: fw.h, hood: undefined, warm: rnd() > 0.5 });
          out.push({ key: `w${fi}${z}`, pos: [-25.52, fw.y, z], rotY: -Math.PI / 2, w: fw.w, h: fw.h, hood: undefined, warm: rnd() > 0.5 });
        });
      }
    });
    // the bow
    [-0.62, 0, 0.62].forEach((a) => {
      out.push({ key: `b2${a}`, pos: arc(a, 6.82, 7.3), rotY: a, w: 1.6, h: 3.7, hood: "arc", warm: true });
      out.push({ key: `b1${a}`, pos: arc(a, 6.82, 12.9), rotY: a, w: 1.5, h: 2.7, hood: undefined, warm: a !== 0 });
    });
    return out;
  }, [roomAt]);

  const roofPosts = useMemo(() => {
    const pts: Vec3[] = [];
    for (let x = -25.3; x <= 25.3; x += 0.62) {
      if (Math.abs(x) > 9.4) pts.push([x, 17.2, 12.8]);
      pts.push([x, 17.2, -12.8]);
    }
    for (let z = -12.2; z <= 12.2; z += 0.62) {
      pts.push([25.3, 17.2, z]);
      pts.push([-25.3, 17.2, z]);
    }
    return pts;
  }, []);
  const bowPosts = useMemo(() => {
    const pts: Vec3[] = [];
    for (let a = -1.5; a <= 1.5; a += 0.068) pts.push(arc(a, 9.1, 17.45));
    return pts;
  }, []);
  const terracePosts = useMemo(() => {
    const pts: Vec3[] = [];
    for (let a = -1.45; a <= 1.45; a += 0.09) pts.push(arc(a, 8.85, 4.75));
    return pts;
  }, []);
  const balconyPosts = useMemo(() => {
    const pts: Vec3[] = [];
    for (let a = -1.45; a <= 1.45; a += 0.1) pts.push(arc(a, 7.9, 10.95));
    return pts;
  }, []);
  const wingCols = useMemo(() => {
    const pts: Vec3[] = [];
    for (const s of [-1, 1]) for (let x = 27.5; x <= 52.5; x += 2.5) pts.push([s * x, 2.2, 3.4]);
    return pts;
  }, []);
  const wingPosts = useMemo(() => {
    const pts: Vec3[] = [];
    for (const s of [-1, 1]) for (let x = 26; x <= 53.5; x += 0.62) pts.push([s * x, 5.15, 3.6]);
    return pts;
  }, []);

  const details = useMemo(() => {
    const dentils: Vec3[] = [];
    for (let x = -25.4; x <= 25.4; x += 0.7) {
      if (Math.abs(x) > 9.5) dentils.push([x, 15.42, 13.18]);
      dentils.push([x, 15.42, -13.18]);
    }
    for (let z = -12.6; z <= 12.6; z += 0.7) {
      dentils.push([25.68, 15.42, z]);
      dentils.push([-25.68, 15.42, z]);
    }
    const bowDentils: Vec3[] = [];
    for (let a = -1.5; a <= 1.5; a += 0.076) bowDentils.push(arc(a, 9.28, 14.5));
    const quoins: Vec3[] = [];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (let y = 4.9; y < 15; y += 1) quoins.push([sx * 25.35, y, sz * 12.85]);
    const flowers: { pos: Vec3; color: string }[] = [];
    const palette = [C.coral, "#F4E8DE", "#E8559F", C.clay, "#FFD27A"];
    for (const s of [-1, 1]) for (let i = 0; i < 34; i++) flowers.push({ pos: [s * (27.5 + i * 0.75), 0.28, 10.9 + (i % 2) * 0.6], color: palette[(i * 3 + (s > 0 ? 1 : 0)) % palette.length] ?? C.coral });
    const lamps: Vec3[] = [];
    for (const s of [-1, 1]) for (const z of [26, 34, 42]) lamps.push([s * 4.2, 0, z]);
    return { dentils, bowDentils, quoins, flowers, lamps };
  }, []);

  const stairs = useMemo(() => {
    const steps: { key: string; pos: Vec3; rotY: number; len: number; h: number }[] = [];
    const rails: { key: string; pos: Vec3; quat: THREE.Quaternion; len: number }[] = [];
    for (const s of [-1, 1]) {
      const top = new THREE.Vector3(s * 8.9, 4.2, 14.6);
      const bottom = new THREE.Vector3(s * 19, 0, 20);
      const flat = new THREE.Vector3(bottom.x - top.x, 0, bottom.z - top.z);
      const rotY = Math.atan2(flat.x, flat.z);
      const n = 16;
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        const p = top.clone().lerp(bottom, t);
        const h = 4.2 * (1 - (i + 1) / n) + 0.26;
        steps.push({ key: `${s}${i}`, pos: [p.x, h / 2, p.z], rotY, len: flat.length() / n + 0.04, h });
      }
      const dir = bottom.clone().sub(top);
      const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().normalize());
      const side = new THREE.Vector3(flat.z, 0, -flat.x).normalize();
      for (const e of [-1, 1]) {
        const mid = top.clone().add(bottom).multiplyScalar(0.5).add(side.clone().multiplyScalar(e * 1.3));
        rails.push({ key: `${s}${e}`, pos: [mid.x, mid.y + 1.1, mid.z], quat, len: dir.length() * 0.92 });
      }
    }
    return { steps, rails };
  }, []);

  const trees = useMemo(() => {
    const rnd = seeded(9);
    const out: { pos: Vec3; s: number; phase: number }[] = [
      { pos: [-33, 0, 22], s: 2.1, phase: 0 },
      { pos: [35, 0, 24], s: 1.9, phase: 1 },
      { pos: [-44, 0, 34], s: 1.6, phase: 2 },
      { pos: [47, 0, 36], s: 1.7, phase: 3 },
    ];
    let guard = 0;
    while (out.length < 46 && guard < 900) {
      guard += 1;
      const x = -120 + rnd() * 240;
      const z = -95 + rnd() * 185;
      const nearHouse = Math.abs(x) < 66 && Math.abs(z) < 24;
      const southView = Math.abs(x) < 32 && z > 10;
      const northView = Math.abs(x) < 16 && z < -10;
      if (nearHouse || southView || northView) continue;
      out.push({ pos: [x, 0, z], s: 1.1 + rnd() * 1.3, phase: rnd() * 6 });
    }
    return out;
  }, []);

  return (
    <group>
      {/* grounds */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} material={MAT.lawn} receiveShadow>
        <circleGeometry args={[190, 72]} />
      </mesh>
      <mesh position={[0, 0.02, 52]} rotation={[-Math.PI / 2, 0, 0]} scale={[1.5, 1, 1]} material={MAT.lawnLight} receiveShadow>
        <circleGeometry args={[27, 64]} />
      </mesh>
      <mesh position={[0, 0.04, 52]} rotation={[-Math.PI / 2, 0, 0]} scale={[1.5, 1, 1]} material={MAT.path} receiveShadow>
        <ringGeometry args={[26.5, 29.5, 72]} />
      </mesh>
      <mesh position={[0, 0.05, 13]} rotation={[-Math.PI / 2, 0, 0]} material={MAT.path} receiveShadow>
        <circleGeometry args={[14, 48]} />
      </mesh>
      <mesh position={[0, 0.045, 34.5]} rotation={[-Math.PI / 2, 0, 0]} material={MAT.path} receiveShadow>
        <planeGeometry args={[5, 24]} />
      </mesh>
      <mesh position={[0, 0.045, -30]} rotation={[-Math.PI / 2, 0, 0]} material={MAT.path} receiveShadow>
        <planeGeometry args={[9, 34]} />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[s * 40, 0.6, 9.5]} material={MAT.hedge} castShadow>
          <boxGeometry args={[26, 1.2, 1.6]} />
        </mesh>
      ))}
      <Fountain still={still} />
      {trees.map((t, i) => (
        <Tree key={i} pos={t.pos} s={t.s} phase={still ? 0 : t.phase} />
      ))}
      <Clouds still={still} />

      {/* main block */}
      <mesh position={[0, 2.1, 0]} material={MAT.base} castShadow receiveShadow>
        <boxGeometry args={[51, 4.2, 26]} />
      </mesh>
      <mesh position={[0, 9.9, 0]} material={MAT.wall} castShadow receiveShadow>
        <boxGeometry args={[51, 11.4, 26]} />
      </mesh>
      <mesh position={[0, 4.2, 0]} material={MAT.trim} castShadow>
        <boxGeometry args={[51.8, 0.32, 26.8]} />
      </mesh>
      <mesh position={[0, 10.4, 0]} material={MAT.trim}>
        <boxGeometry args={[51.36, 0.18, 26.36]} />
      </mesh>
      <mesh position={[0, 16.1, 0]} material={MAT.trim} castShadow>
        <boxGeometry args={[52.4, 1, 27.4]} />
      </mesh>
      <mesh position={[0, 15.35, 0]} material={MAT.wall}>
        <boxGeometry args={[51.5, 0.5, 26.5]} />
      </mesh>
      {/* corner pilasters */}
      {[-1, 1].flatMap((sx) => [-1, 1].map((sz) => [sx, sz] as const)).map(([sx, sz]) => (
        <mesh key={`${sx}${sz}`} position={[sx * 25.35, 9.9, sz * 12.85]} material={MAT.trim} castShadow>
          <boxGeometry args={[1, 11.4, 1]} />
        </mesh>
      ))}

      {/* roof: balustrade, third floor, chimneys, mast */}
      <Posts points={roofPosts} size={[0.18, 0.9, 0.18]} material={MAT.trim} />
      {[
        [17.2, 17.72, 12.8, 16.4, 0.16, 0.3],
        [-17.2, 17.72, 12.8, 16.4, 0.16, 0.3],
        [0, 17.72, -12.8, 51, 0.16, 0.3],
        [25.3, 17.72, 0, 0.3, 0.16, 25.6],
        [-25.3, 17.72, 0, 0.3, 0.16, 25.6],
      ].map(([x, y, z, w, h, d], i) => (
        <mesh key={i} position={[x ?? 0, y ?? 0, z ?? 0]} material={MAT.trim} castShadow>
          <boxGeometry args={[w ?? 1, h ?? 1, d ?? 1]} />
        </mesh>
      ))}
      <mesh position={[0, 18.1, 0]} material={MAT.wall} castShadow receiveShadow>
        <boxGeometry args={[46, 3, 20]} />
      </mesh>
      <mesh position={[0, 19.75, 0]} material={MAT.roof} castShadow>
        <boxGeometry args={[47, 0.3, 21]} />
      </mesh>
      {[-13, 13].map((x) => (
        <group key={x}>
          <mesh position={[x, 20.8, -2]} material={MAT.wall} castShadow>
            <boxGeometry args={[1.8, 1.9, 1.3]} />
          </mesh>
          <mesh position={[x, 21.85, -2]} material={MAT.trim}>
            <boxGeometry args={[2.1, 0.22, 1.6]} />
          </mesh>
          {!stopped && <Smoke pos={[x, 22.4, -2]} still={still} />}
        </group>
      ))}
      <mesh position={[0, 23.6, 0]} material={MAT.trim}>
        <cylinderGeometry args={[0.07, 0.11, 7.6, 8]} />
      </mesh>
      <mesh ref={beacon} position={[0, 27.6, 0]}>
        <sphereGeometry args={[0.3, 16, 16]} />
        <meshBasicMaterial color={stopped ? "#777777" : "#FFFFFF"} toneMapped={false} />
      </mesh>
      {!stopped && (
        <group position={[8, 19.9, 3]} rotation={[0, 0.6, 0]} scale={2}>
          <Person seed={7} tie={C.coral} pose="idle" still={still} />
        </group>
      )}

      {/* south bow */}
      <mesh position={[0, 2.1, SZ]} material={MAT.base} castShadow receiveShadow>
        <cylinderGeometry args={[9, 9, 4.2, 56, 1, false, -Math.PI / 2, Math.PI]} />
      </mesh>
      <mesh position={[0, 4.28, SZ]} material={MAT.trim}>
        <cylinderGeometry args={[9.3, 9.3, 0.3, 56, 1, false, -Math.PI / 2, Math.PI]} />
      </mesh>
      <mesh position={[0, 9.9, SZ]} material={MAT.wall} castShadow receiveShadow>
        <cylinderGeometry args={[6.8, 6.8, 11.4, 48, 1, false, -Math.PI / 2, Math.PI]} />
      </mesh>
      <mesh position={[0, 10.4, SZ]} material={MAT.trim} castShadow>
        <cylinderGeometry args={[8, 8, 0.32, 48, 1, false, -Math.PI / 2, Math.PI]} />
      </mesh>
      {BOW_COLS.map((a) => (
        <Column key={a} pos={arc(a, 8.3, 4.4)} h={10.2} r={0.6} />
      ))}
      <mesh position={[0, 15.6, SZ]} material={MAT.wall} castShadow>
        <cylinderGeometry args={[9.1, 9.1, 2, 56, 1, false, -Math.PI / 2, Math.PI]} />
      </mesh>
      <mesh position={[0, 16.75, SZ]} material={MAT.trim} castShadow>
        <cylinderGeometry args={[9.6, 9.5, 0.34, 56, 1, false, -Math.PI / 2, Math.PI]} />
      </mesh>
      <Posts points={bowPosts} size={[0.2, 0.9, 0.2]} material={MAT.trim} />
      {[17.95, 16.98].map((y) => (
        <mesh key={y} position={[0, y, SZ]} rotation={[Math.PI / 2, 0, 0]} material={MAT.trim}>
          <torusGeometry args={[9.1, 0.11, 6, 56, Math.PI]} />
        </mesh>
      ))}
      <Posts points={terracePosts} size={[0.07, 1, 0.07]} material={MAT.iron} />
      <mesh position={[0, 5.25, SZ]} rotation={[Math.PI / 2, 0, 0]} material={MAT.iron}>
        <torusGeometry args={[8.85, 0.06, 6, 56, Math.PI]} />
      </mesh>
      <Posts points={balconyPosts} size={[0.06, 1, 0.06]} material={MAT.iron} />
      <mesh position={[0, 11.45, SZ]} rotation={[Math.PI / 2, 0, 0]} material={MAT.iron}>
        <torusGeometry args={[7.9, 0.055, 6, 48, Math.PI]} />
      </mesh>

      {/* garden doors and lanterns in the base of the bow */}
      {[-0.62, 0, 0.62].map((a) => (
        <group key={a} position={arc(a, 9.02, 0)} rotation={[0, a, 0]}>
          <mesh position={[0, 1.3, 0]} material={MAT.door}>
            <boxGeometry args={[1.7, 2.6, 0.14]} />
          </mesh>
          <mesh position={[0, 2.6, 0]} rotation={[Math.PI / 2, 0, 0]} material={a === 0 && doorHover ? MAT.lamp : MAT.glassWarm}>
            <cylinderGeometry args={[0.85, 0.85, 0.14, 20, 1, false, Math.PI / 2, Math.PI]} />
          </mesh>
          <mesh position={[0, 1.3, 0.08]} material={MAT.trim}>
            <boxGeometry args={[0.06, 2.6, 0.04]} />
          </mesh>
        </group>
      ))}
      {[-0.31, 0.31].map((a) => (
        <mesh key={a} position={arc(a, 9.25, 3)} material={MAT.lamp}>
          <boxGeometry args={[0.28, 0.5, 0.28]} />
        </mesh>
      ))}
      <pointLight position={[0, 3, 23.5]} color="#FFD27A" intensity={doorHover ? 60 : 24} distance={18} />

      {/* the way in to the Chief of Staff */}
      <mesh
        position={[0, 1.8, 22.4]}
        onClick={(e) => {
          e.stopPropagation();
          document.body.style.cursor = "";
          onEnter();
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          setDoorHover(true);
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          setDoorHover(false);
          document.body.style.cursor = "";
        }}
      >
        <boxGeometry args={[3.4, 3.8, 1.2]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      {front && (
        <Html portal={layer} position={[0, 0.5, 25]} center distanceFactor={labelSize} zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
          <div
            style={{
              whiteSpace: "nowrap",
              padding: "8px 16px",
              background: doorHover ? C.ink : C.surface,
              color: doorHover ? C.surface : C.ink,
              border: `1.5px solid ${C.ink}`,
              borderRadius: 999,
              font: `600 13px/1 ${SANS}`,
            }}
          >
            Oval Office · Chief of Staff
          </div>
        </Html>
      )}

      {/* garden stairs */}
      {stairs.steps.map((s) => (
        <mesh key={s.key} position={s.pos} rotation={[0, s.rotY, 0]} material={MAT.stone} castShadow receiveShadow>
          <boxGeometry args={[2.6, s.h, s.len]} />
        </mesh>
      ))}
      {stairs.rails.map((r) => (
        <mesh key={r.key} position={r.pos} quaternion={r.quat} material={MAT.iron}>
          <boxGeometry args={[0.08, 0.08, r.len]} />
        </mesh>
      ))}

      {/* detail: dentils under the cornice, grooves in the base, quoins, flower beds, lamps */}
      <Posts points={details.dentils} size={[0.3, 0.32, 0.3]} material={MAT.trim} />
      <Posts points={details.bowDentils} size={[0.3, 0.32, 0.3]} material={MAT.trim} />
      <Posts points={details.quoins} size={[1.16, 0.5, 1.16]} material={MAT.trim} />
      {[1.05, 2.1, 3.15].map((y) => (
        <group key={y}>
          <mesh position={[0, y, 0]} material={MAT.groove}>
            <boxGeometry args={[51.04, 0.06, 26.04]} />
          </mesh>
          <mesh position={[0, y, SZ]} material={MAT.groove}>
            <cylinderGeometry args={[9.02, 9.02, 0.06, 56, 1, false, -Math.PI / 2, Math.PI]} />
          </mesh>
        </group>
      ))}
      {details.flowers.map((f, i) => (
        <mesh key={i} position={f.pos} castShadow>
          <boxGeometry args={[0.55, 0.55, 0.55]} />
          <meshStandardMaterial color={f.color} roughness={1} />
        </mesh>
      ))}
      {details.lamps.map((l, i) => (
        <group key={i} position={l}>
          <mesh position={[0, 1.5, 0]} material={MAT.iron} castShadow>
            <boxGeometry args={[0.18, 3, 0.18]} />
          </mesh>
          <mesh position={[0, 3.2, 0]} material={MAT.lamp}>
            <boxGeometry args={[0.5, 0.5, 0.5]} />
          </mesh>
          <mesh position={[0, 3.52, 0]} material={MAT.iron}>
            <boxGeometry args={[0.66, 0.12, 0.66]} />
          </mesh>
        </group>
      ))}

      {/* windows */}
      {plain.map((w) => (
        <PlainWindow key={w.key} pos={w.pos} rotY={w.rotY} w={w.w} h={w.h} hood={w.hood} warm={w.warm && !stopped} />
      ))}
      {ROOMS.map((room) => {
        const state: RoomState = stopped ? "idle" : (sim[room.id]?.state ?? "idle");
        const bi = SIDE_BAYS.indexOf(room.pos[0]);
        const hood: Hood = room.floorIndex === 2 ? (bi % 2 === 0 ? "tri" : "arc") : undefined;
        return <RoomWindow key={room.id} room={room} state={state} hood={hood} showLabel={front} floorLabel={names[room.floorId] ?? room.floorName} layer={layer} labelSize={labelSize} onSelect={onSelect} />;
      })}

      {/* floor names */}
      {front &&
        !phone &&
        FLOORS.map((f, fi) => (
          <Html portal={layer} key={f.id} position={[27.6, FLOOR_WIN[fi]?.y ?? 0, 13.4]} center distanceFactor={labelSize} zIndexRange={[20, 0]}>
            <button
              type="button"
              onClick={() => onFloor(fi)}
              style={{
                whiteSpace: "nowrap",
                transform: "translateX(55%)",
                padding: "8px 16px",
                background: C.surface,
                border: `1.5px solid ${C.panel}`,
                borderRadius: 14,
                color: C.ink,
                textAlign: "left",
                cursor: "pointer",
              }}
            >
              <div style={{ font: `600 9px/1.4 ${SANS}`, letterSpacing: "0.2em", color: C.terracotta }}>FLOOR {f.level}</div>
              <div style={{ font: `300 19px/1.1 ${SERIF}`, letterSpacing: "-0.02em" }}>{names[f.id] ?? f.name}</div>
            </button>
          </Html>
        ))}

      {/* north portico */}
      <mesh position={[0, 0.4, -17.2]} material={MAT.stone} castShadow receiveShadow>
        <boxGeometry args={[17.4, 0.8, 8.6]} />
      </mesh>
      <mesh position={[0, 0.2, -22.4]} material={MAT.stone} receiveShadow>
        <boxGeometry args={[12, 0.4, 2.2]} />
      </mesh>
      {[-6.6, -2.2, 2.2, 6.6].map((x) => (
        <Column key={x} pos={[x, 0.8, -20.4]} h={13.8} r={0.62} />
      ))}
      {[-6.6, 6.6].map((x) => (
        <Column key={x} pos={[x, 0.8, -16.6]} h={13.8} r={0.62} />
      ))}
      <mesh position={[0, 15.4, -17.2]} material={MAT.wall} castShadow>
        <boxGeometry args={[16.4, 1.6, 8.8]} />
      </mesh>
      <mesh position={[0, 16.32, -17.2]} material={MAT.trim} castShadow>
        <boxGeometry args={[17.2, 0.26, 9.4]} />
      </mesh>
      <mesh position={[0, 16.45 + 1.1, -17.2]} rotation={[Math.PI / 2, 0, 0]} scale={[1, 1, 0.238]} material={MAT.wall} castShadow>
        <cylinderGeometry args={[9.6, 9.6, 9, 3, 1, false, Math.PI]} />
      </mesh>
      <mesh position={[0, 2.7, -13.06]} material={MAT.door}>
        <boxGeometry args={[2.4, 3.8, 0.16]} />
      </mesh>

      {/* wings */}
      {[-1, 1].map((s) => (
        <group key={s}>
          <mesh position={[s * 40, 2.2, -1]} material={MAT.wall} castShadow receiveShadow>
            <boxGeometry args={[29, 4.4, 8]} />
          </mesh>
          <mesh position={[s * 40, 4.55, 0]} material={MAT.trim} castShadow>
            <boxGeometry args={[29.6, 0.3, 10.4]} />
          </mesh>
          <mesh position={[s * 58, 3.2, -1]} material={MAT.wall} castShadow receiveShadow>
            <boxGeometry args={[8, 6.4, 12]} />
          </mesh>
          <mesh position={[s * 58, 6.55, -1]} material={MAT.trim} castShadow>
            <boxGeometry args={[8.8, 0.3, 12.8]} />
          </mesh>
          {[-1.6, 1.6].map((dx) => (
            <PlainWindow key={dx} pos={[s * 58 + dx, 3.3, 5.02]} w={1.3} h={2.6} warm />
          ))}
          <mesh position={[s * 40, 5.62, 3.6]} material={MAT.trim}>
            <boxGeometry args={[28.4, 0.14, 0.26]} />
          </mesh>
        </group>
      ))}
      <Posts points={wingCols} size={[0.5, 4.4, 0.5]} material={MAT.trim} />
      <Posts points={wingPosts} size={[0.14, 0.9, 0.14]} material={MAT.trim} />

      {/* things cooking */}
      {!stopped && (
        <>
          <Patrol radius={9.5} centre={[0, 0, 52]} speed={0.35} y={0} color="#3BA7FF" still={still} phase={0} />
          <Patrol radius={9.5} centre={[0, 0, 52]} speed={0.35} y={0} color="#FF6AC1" still={still} phase={Math.PI} />
          <Patrol radius={28} sx={1.5} centre={[0, 0, 52]} speed={-0.12} y={0} color="#35E0D0" still={still} phase={1.2} />
          <Patrol radius={28} sx={1.5} centre={[0, 0, 52]} speed={-0.12} y={0} color="#A78BFA" still={still} phase={4.1} />
        </>
      )}
      {couriers.map((c) => (
        <CourierOrb key={c.id} c={c} onDone={onCourierDone} />
      ))}
    </group>
  );
}
