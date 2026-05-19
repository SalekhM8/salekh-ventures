"use server";

type ContactPayload = {
  name: string;
  email: string;
  company?: string;
  budget?: string;
  message: string;
};

export type ContactResult =
  | { ok: true }
  | { ok: false; error: string };

export async function submitContact(
  _prev: ContactResult | null,
  formData: FormData
): Promise<ContactResult> {
  const payload: ContactPayload = {
    name: String(formData.get("name") ?? "").trim(),
    email: String(formData.get("email") ?? "").trim(),
    company: String(formData.get("company") ?? "").trim() || undefined,
    budget: String(formData.get("budget") ?? "").trim() || undefined,
    message: String(formData.get("message") ?? "").trim(),
  };

  // Validation
  if (!payload.name) return { ok: false, error: "Name is required." };
  if (!payload.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
    return { ok: false, error: "Please enter a valid email." };
  }
  if (!payload.message || payload.message.length < 10) {
    return {
      ok: false,
      error: "Message is too short — give us a sentence or two.",
    };
  }

  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.CONTACT_TO_EMAIL || "hello@salekhventures.com";
  const from = process.env.CONTACT_FROM_EMAIL || "Salekh Ventures <onboarding@resend.dev>";

  // If no Resend key is configured yet, log and accept — so the form works locally.
  if (!apiKey) {
    console.log("[contact] No RESEND_API_KEY set. Submission:", payload);
    return { ok: true };
  }

  const body = {
    from,
    to,
    reply_to: payload.email,
    subject: `New enquiry — ${payload.name}`,
    text: [
      `Name: ${payload.name}`,
      `Email: ${payload.email}`,
      payload.company ? `Company: ${payload.company}` : null,
      payload.budget ? `Budget: ${payload.budget}` : null,
      "",
      payload.message,
    ]
      .filter(Boolean)
      .join("\n"),
  };

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("[contact] Resend error:", res.status, text);
      return {
        ok: false,
        error: "Could not send right now. Please email salekhventures@gmail.com directly.",
      };
    }

    return { ok: true };
  } catch (err) {
    console.error("[contact] Network error:", err);
    return {
      ok: false,
      error: "Network error. Please try again or email directly.",
    };
  }
}
