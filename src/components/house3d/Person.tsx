"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

export type Pose = "idle" | "typing" | "wave" | "cheer" | "slump" | "walk" | "talk" | "carry";

const P = 1.8 / 32; // one block pixel; the figure stands 1.8 tall

const SKIN = ["#F1C9A5", "#D9A074", "#B97A4E", "#8A5433", "#F6D6BC", "#C68B5E"];
const HAIR = ["#2A1B14", "#4A2F1F", "#101010", "#7A4A25", "#C9A36A", "#5B5B5B"];
const SUIT = ["#1F2A44", "#2B2B31", "#3A2A24", "#6A1A18", "#24403A", "#3B3550"];

const mats = new Map<string, THREE.MeshStandardMaterial>();
function mat(color: string) {
  let m = mats.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: 0.85 });
    mats.set(color, m);
  }
  return m;
}

function Box({ size, pos, color }: { size: [number, number, number]; pos: [number, number, number]; color: string }) {
  return (
    <mesh position={[pos[0] * P, pos[1] * P, pos[2] * P]} material={mat(color)} castShadow>
      <boxGeometry args={[size[0] * P, size[1] * P, size[2] * P]} />
    </mesh>
  );
}

/** A blocky person in a suit. Faces +z. `tie` is the department colour. */
export function Person({
  seed = 0,
  tie = "#e55d40",
  pose = "idle",
  still = false,
  suit,
  longHair,
}: {
  seed?: number;
  tie?: string;
  pose?: Pose;
  still?: boolean;
  suit?: string;
  longHair?: boolean;
}) {
  const look = useMemo(() => {
    const skin = SKIN[seed % SKIN.length] ?? "#D9A074";
    const hair = HAIR[(seed * 3 + 1) % HAIR.length] ?? "#2A1B14";
    const jacket = suit ?? SUIT[(seed * 5 + 2) % SUIT.length] ?? "#1F2A44";
    return { skin, hair, jacket, long: longHair ?? seed % 3 === 1 };
  }, [seed, suit, longHair]);

  const root = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const armL = useRef<THREE.Group>(null);
  const armR = useRef<THREE.Group>(null);
  const legL = useRef<THREE.Group>(null);
  const legR = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    const t = still ? 0 : clock.elapsedTime + seed * 1.7;
    const a = { al: 0, ar: 0, alz: 0, arz: 0, ll: 0, lr: 0, hx: 0, hy: 0, y: 0, lean: 0 };
    if (pose === "idle") {
      a.al = Math.sin(t * 1.2) * 0.06;
      a.ar = -Math.sin(t * 1.2) * 0.06;
      a.hy = Math.sin(t * 0.6) * 0.35;
      a.y = Math.sin(t * 1.6) * 0.4;
    } else if (pose === "typing") {
      a.al = -1.25 + Math.sin(t * 15) * 0.14;
      a.ar = -1.25 + Math.sin(t * 15 + 1.9) * 0.14;
      a.hx = 0.16 + Math.sin(t * 2) * 0.04;
      a.lean = 0.06;
    } else if (pose === "wave") {
      a.arz = 2.5 + Math.sin(t * 9) * 0.4;
      a.al = Math.sin(t * 1.2) * 0.05;
      a.hy = Math.sin(t * 2) * 0.1;
      a.y = Math.abs(Math.sin(t * 4.5)) * 1.2;
    } else if (pose === "cheer") {
      a.alz = -2.7 - Math.sin(t * 10) * 0.15;
      a.arz = 2.7 + Math.sin(t * 10) * 0.15;
      a.y = Math.abs(Math.sin(t * 6)) * 2.4;
    } else if (pose === "slump") {
      a.hx = 0.55;
      a.lean = 0.14;
      a.al = 0.1;
      a.ar = 0.1;
    } else if (pose === "walk" || pose === "carry") {
      const s = Math.sin(t * 7);
      a.ll = s * 0.7;
      a.lr = -s * 0.7;
      a.al = pose === "carry" ? -1.1 : -s * 0.6;
      a.ar = pose === "carry" ? -1.1 : s * 0.6;
      a.y = Math.abs(Math.cos(t * 7)) * 0.6;
    } else if (pose === "talk") {
      a.ar = -0.9 + Math.sin(t * 3.2) * 0.35;
      a.arz = 0.25;
      a.al = Math.sin(t * 1.4) * 0.08;
      a.hx = Math.sin(t * 6) * 0.05;
      a.hy = Math.sin(t * 1.1) * 0.22;
    }
    const k = still ? 1 : 0.22;
    const set = (o: THREE.Object3D | null, x: number, z = 0, y = 0) => {
      if (!o) return;
      o.rotation.x += (x - o.rotation.x) * k;
      o.rotation.z += (z - o.rotation.z) * k;
      o.rotation.y += (y - o.rotation.y) * k;
    };
    set(armL.current, a.al, a.alz);
    set(armR.current, a.ar, a.arz);
    set(legL.current, a.ll);
    set(legR.current, a.lr);
    set(head.current, a.hx, 0, a.hy);
    if (root.current) {
      root.current.position.y += (a.y * P - root.current.position.y) * k;
      root.current.rotation.x += (a.lean - root.current.rotation.x) * k;
    }
  });

  const shoe = "#1B1512";
  return (
    <group ref={root}>
      {/* legs */}
      {(
        [
          [legL, -2],
          [legR, 2],
        ] as const
      ).map(([ref, x]) => (
        <group key={x} ref={ref} position={[x * P, 12 * P, 0]}>
          <Box size={[3.9, 10, 3.9]} pos={[0, -5, 0]} color={look.jacket} />
          <Box size={[4.1, 2, 4.6]} pos={[0, -11, 0.3]} color={shoe} />
        </group>
      ))}
      {/* body: jacket, shirt, tie, buttons */}
      <Box size={[8, 12, 4]} pos={[0, 18, 0]} color={look.jacket} />
      <Box size={[2.6, 8, 0.3]} pos={[0, 19.8, 2.05]} color="#FBF7F0" />
      <Box size={[1, 7, 0.3]} pos={[0, 19.6, 2.2]} color={tie} />
      <Box size={[1.5, 1.2, 0.3]} pos={[0, 23.2, 2.25]} color={tie} />
      <Box size={[1.6, 3.4, 0.3]} pos={[-2.1, 21.8, 2.1]} color={look.jacket} />
      <Box size={[1.6, 3.4, 0.3]} pos={[2.1, 21.8, 2.1]} color={look.jacket} />
      <Box size={[0.7, 0.7, 0.3]} pos={[0.9, 14.6, 2.1]} color="#0E0B0A" />
      <Box size={[8.1, 1, 4.1]} pos={[0, 12.6, 0]} color="#15110F" />
      {/* arms */}
      {(
        [
          [armL, -6],
          [armR, 6],
        ] as const
      ).map(([ref, x]) => (
        <group key={x} ref={ref} position={[x * P, 23 * P, 0]}>
          <Box size={[3.9, 9, 3.9]} pos={[0, -3.5, 0]} color={look.jacket} />
          <Box size={[4, 0.8, 4]} pos={[0, -8.2, 0]} color="#FBF7F0" />
          <Box size={[3.4, 2.6, 3.4]} pos={[0, -9.7, 0]} color={look.skin} />
        </group>
      ))}
      {/* head */}
      <group ref={head} position={[0, 24 * P, 0]}>
        <Box size={[8, 8, 8]} pos={[0, 4, 0]} color={look.skin} />
        <Box size={[8.4, 2.6, 8.4]} pos={[0, 7.2, 0]} color={look.hair} />
        <Box size={[8.4, 6, 2.4]} pos={[0, 5, -3.1]} color={look.hair} />
        {look.long && (
          <>
            <Box size={[1.4, 8, 6]} pos={[-4.2, 2.6, -0.8]} color={look.hair} />
            <Box size={[1.4, 8, 6]} pos={[4.2, 2.6, -0.8]} color={look.hair} />
          </>
        )}
        <Box size={[1.2, 1.5, 0.3]} pos={[-1.9, 4.2, 4.05]} color="#1B1512" />
        <Box size={[1.2, 1.5, 0.3]} pos={[1.9, 4.2, 4.05]} color="#1B1512" />
        <Box size={[2.4, 0.6, 0.3]} pos={[0, 1.8, 4.05]} color="#7A3B2E" />
      </group>
    </group>
  );
}
