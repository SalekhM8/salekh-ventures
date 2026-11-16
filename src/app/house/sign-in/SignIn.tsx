"use client";

import { useState } from "react";
import { requestHouseLink } from "@/app/actions/houseSignIn";

export function SignIn({ expired }: { expired: boolean }) {
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const send = async () => {
    if (state === "sending") return;
    setState("sending");
    await requestHouseLink();
    setState("sent");
  };
  return (
    <main className="flex min-h-dvh items-center justify-center bg-[#FBF3EE] px-4 text-[#1A1310]">
      <div className="w-full max-w-md rounded-3xl border border-[#E9D3C8] bg-white p-7">
        <h1 className="font-[family-name:var(--font-fraunces)] text-4xl font-light tracking-tight">The White House.</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-[#4a3b34]">
          Private. A sign-in link is emailed to the owner&apos;s address and nowhere else.
        </p>
        {expired && state === "idle" && (
          <p role="alert" className="mt-3 text-[14px] font-medium text-[#9a2c1c]">That link has expired or was not valid. Ask for a new one.</p>
        )}
        {state === "sent" ? (
          <p role="status" className="mt-5 text-[15px] leading-relaxed">
            If sign-in is set up, a link is on its way to the owner&apos;s inbox. It works for 15 minutes. One link a minute at most.
          </p>
        ) : (
          <button type="button" onClick={send} disabled={state === "sending"} className="mt-5 min-h-12 w-full rounded-full bg-[#1A1310] px-5 text-[15px] font-semibold text-white disabled:opacity-50">
            {state === "sending" ? "Sending…" : "Email me a sign-in link"}
          </button>
        )}
      </div>
    </main>
  );
}
