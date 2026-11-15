"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { Person } from "./Person";
import { FLOORS, ROOMS, stateColor, type RoomState, type Sim } from "./model";

const std = (color: string, roughness = 0.8, extra: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness, ...extra });

const M = {
  wall: std("#F1E9D6", 0.9, { side: THREE.BackSide }),
  wainscot: std("#FBF8F0", 0.8, { side: THREE.BackSide }),
  floor: std("#9A6B45", 0.55),
  floorDark: std("#7C5334", 0.55),
  rug: std("#23406E", 1),
  rugLine: std("#E9DDBE", 1),
  ceiling: std("#FFFFFF", 1),
  wood: std("#5B3A22", 0.45),
  woodDark: std("#47301D", 0.5),
  brass: std("#C9A24B", 0.35, { metalness: 0.7 }),
  sofa: std("#EFE6D2", 1),
  curtain: std("#6a1a18", 0.95),
  sky: new THREE.MeshBasicMaterial({ color: "#FFDDAA" }),
  trim: std("#FFFFFF", 0.7),
  leaf: std("#3F7D3A", 1, { flatShading: true }),
  pot: std("#D8D2C4", 0.8),
};

/** The oval room. The Chief of Staff stands in front of the desk, facing the door. */
export function Interior({ sim, stopped, still, talking }: { sim: Sim; stopped: boolean; still: boolean; talking: boolean }) {
  const board = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (board.current && !still) {
      board.current.position.y = 2.75 + Math.sin(clock.elapsedTime * 1.4) * 0.06;
      board.current.rotation.y = 2.7 + Math.sin(clock.elapsedTime * 0.5) * 0.06;
    }
  });

  return (
    <group>
      <ambientLight intensity={0.75} color="#FFF1DC" />
      <pointLight position={[0, 5.4, 0]} intensity={70} color="#FFE8C4" distance={30} />
      <directionalLight position={[0, 6, 12]} intensity={1.6} color="#FFD9A8" />

      {/* shell */}
      <group scale={[1.3, 1, 1]}>
        <mesh position={[0, 3.4, 0]} material={M.wall}>
          <cylinderGeometry args={[9, 9, 6.8, 64, 1, true]} />
        </mesh>
        <mesh position={[0, 0.55, 0]} material={M.wainscot}>
          <cylinderGeometry args={[8.96, 8.96, 1.1, 64, 1, true]} />
        </mesh>
        <mesh position={[0, 1.12, 0]} rotation={[Math.PI / 2, 0, 0]} material={M.trim}>
          <torusGeometry args={[8.93, 0.05, 6, 64]} />
        </mesh>
        <mesh rotation={[-Math.PI / 2, 0, 0]} material={M.floor} receiveShadow>
          <circleGeometry args={[9, 64]} />
        </mesh>
        <mesh position={[0, 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]} material={M.floorDark}>
          <ringGeometry args={[7.4, 7.7, 64]} />
        </mesh>
        <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]} material={M.rug}>
          <circleGeometry args={[6.2, 64]} />
        </mesh>
        <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]} material={M.rugLine}>
          <ringGeometry args={[5.5, 5.7, 64]} />
        </mesh>
        <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]} material={M.rugLine}>
          <ringGeometry args={[1.5, 1.62, 48]} />
        </mesh>
        <mesh position={[0, 6.8, 0]} rotation={[Math.PI / 2, 0, 0]} material={M.ceiling}>
          <circleGeometry args={[9, 64]} />
        </mesh>
        <mesh position={[0, 6.74, 0]} rotation={[Math.PI / 2, 0, 0]} material={M.trim}>
          <torusGeometry args={[5, 0.12, 8, 64]} />
        </mesh>
        <mesh position={[0, 6.6, 0]} rotation={[Math.PI / 2, 0, 0]} material={M.trim}>
          <torusGeometry args={[8.9, 0.16, 8, 64]} />
        </mesh>
      </group>

      {/* three tall windows behind the desk */}
      {[-0.42, 0, 0.42].map((a) => (
        <group key={a} position={[Math.sin(a) * 11.4, 0, Math.cos(a) * 8.75]} rotation={[0, a * 0.75 + Math.PI, 0]}>
          <mesh position={[0, 3.3, 0]} material={M.sky}>
            <planeGeometry args={[2.1, 4.6]} />
          </mesh>
          <mesh position={[0, 3.3, 0.04]} material={M.trim}>
            <boxGeometry args={[0.07, 4.6, 0.05]} />
          </mesh>
          {[2.2, 3.3, 4.4].map((y) => (
            <mesh key={y} position={[0, y, 0.04]} material={M.trim}>
              <boxGeometry args={[2.1, 0.06, 0.05]} />
            </mesh>
          ))}
          {[-1, 1].map((s) => (
            <mesh key={s} position={[s * 1.3, 3.2, 0.25]} material={M.curtain}>
              <boxGeometry args={[0.34, 5.2, 0.24]} />
            </mesh>
          ))}
          <mesh position={[0, 5.9, 0.3]} material={M.curtain}>
            <boxGeometry args={[3, 0.34, 0.3]} />
          </mesh>
        </group>
      ))}

      {/* desk and chair */}
      <group position={[0, 0, 5]}>
        <mesh position={[0, 0.98, 0]} material={M.wood} castShadow>
          <boxGeometry args={[3.6, 0.14, 1.6]} />
        </mesh>
        <mesh position={[0, 0.48, 0.1]} material={M.woodDark} castShadow>
          <boxGeometry args={[3.3, 0.9, 1.2]} />
        </mesh>
        <mesh position={[0, 0.5, -0.52]} material={M.wood}>
          <boxGeometry args={[1.5, 0.6, 0.04]} />
        </mesh>
        <mesh position={[-1.2, 1.2, 0.1]} material={M.brass}>
          <cylinderGeometry args={[0.05, 0.14, 0.3, 12]} />
        </mesh>
        <mesh position={[-1.2, 1.46, 0.1]}>
          <sphereGeometry args={[0.16, 14, 14]} />
          <meshStandardMaterial color="#FFE2A6" emissive="#FFD27A" emissiveIntensity={2} />
        </mesh>
        <mesh position={[0, 1.2, 1.5]} material={M.woodDark}>
          <boxGeometry args={[1.1, 2.3, 0.2]} />
        </mesh>
      </group>

      {/* sofas and table */}
      {[-1, 1].map((s) => (
        <group key={s} position={[s * 3.5, 0, -1.4]}>
          <mesh position={[0, 0.42, 0]} material={M.sofa} castShadow>
            <boxGeometry args={[1.3, 0.84, 3.6]} />
          </mesh>
          <mesh position={[s * 0.55, 0.95, 0]} material={M.sofa}>
            <boxGeometry args={[0.3, 0.8, 3.6]} />
          </mesh>
        </group>
      ))}
      <mesh position={[0, 0.4, -1.4]} material={M.wood} castShadow>
        <boxGeometry args={[1.6, 0.14, 2.4]} />
      </mesh>
      <mesh position={[0, 0.18, -1.4]} material={M.woodDark}>
        <boxGeometry args={[1.2, 0.36, 2]} />
      </mesh>
      {[-1, 1].map((s) => (
        <group key={s} position={[s * 9.4, 0, 3.2]}>
          <mesh position={[0, 0.4, 0]} material={M.pot}>
            <cylinderGeometry args={[0.45, 0.35, 0.8, 14]} />
          </mesh>
          <mesh position={[0, 1.7, 0]} material={M.leaf}>
            <icosahedronGeometry args={[0.95, 1]} />
          </mesh>
        </group>
      ))}

      {/* the Chief of Staff */}
      <group position={[0, 0, 2.6]} rotation={[0, Math.PI, 0]} scale={1.55}>
        <Person seed={4} tie="#e55d40" suit="#1F2A44" pose={stopped ? "idle" : talking ? "talk" : "idle"} still={still} longHair={false} />
      </group>

      {/* live board: one light per room, one row per floor */}
      <group ref={board} position={[-3.6, 2.75, 3.4]} rotation={[0, 2.7, 0]}>
        <mesh position={[0, 0, -0.06]}>
          <planeGeometry args={[2.5, 1.9]} />
          <meshBasicMaterial color="#0B0D12" transparent opacity={0.82} side={THREE.DoubleSide} />
        </mesh>
        {FLOORS.map((f, fi) =>
          ROOMS.filter((r) => r.floorId === f.id).map((room, i) => {
            const state: RoomState = stopped ? "idle" : (sim[room.id]?.state ?? "idle");
            const lit = state !== "idle";
            return (
              <mesh key={room.id} position={[1.0 - i * 0.42, 0.62 - fi * 0.42, 0]} scale={lit ? 1 : 0.6}>
                <sphereGeometry args={[0.13, 14, 14]} />
                <meshBasicMaterial color={stateColor(state, room.dept)} transparent opacity={lit ? 1 : 0.4} toneMapped={false} />
              </mesh>
            );
          }),
        )}
      </group>
    </group>
  );
}
