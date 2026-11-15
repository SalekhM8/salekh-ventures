"use client";

import { useSyncExternalStore } from "react";

/* The agents a visitor has ticked in the catalogue. Shared between the
   catalogue, the buttons and the form. Lives only in the page: nothing is
   stored or sent until they submit the form. */

let picks: string[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function togglePick(name: string) {
  picks = picks.includes(name) ? picks.filter((p) => p !== name) : [...picks, name];
  emit();
}
export function getPicks() {
  return picks;
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const none: string[] = [];
export function usePicks() {
  return useSyncExternalStore(subscribe, getPicks, () => none);
}
