"use client";

import { useState, useTransition } from "react";
import { Check, Loader2 } from "lucide-react";
import { createOffice, inviteUser } from "./actions";

interface OfficeOption {
  slug: string;
  name: string;
}

export function CreateOfficeForm() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<
    | { kind: "idle" }
    | { kind: "ok" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const onSubmit = async (formData: FormData) => {
    setResult({ kind: "idle" });
    startTransition(async () => {
      const r = await createOffice(formData);
      if (r.ok) {
        setResult({ kind: "ok" });
        // Reset after the success state has a moment to flash.
        const form = document.getElementById("create-office-form") as HTMLFormElement | null;
        form?.reset();
        setTimeout(() => setResult({ kind: "idle" }), 2500);
      } else {
        setResult({ kind: "error", message: r.error });
      }
    });
  };

  return (
    <form id="create-office-form" action={onSubmit} className="space-y-3">
      <FormRow>
        <Field label="Slug" name="slug" placeholder="rss-tampa" required hint="lowercase, letters/digits/hyphens" />
        <Field label="State" name="state" placeholder="FL" maxLength={2} />
      </FormRow>
      <Field label="Name" name="name" placeholder="RSS Tampa Roofing" required />
      <FormRow>
        <Field label="Brand color" name="brand_color" placeholder="#7DD3FC" />
        <Field label="Inbound phone" name="inbound_number" placeholder="+18135551234" />
      </FormRow>
      <FormRow>
        <Field label="Twilio number" name="twilio_number" placeholder="+18135551234" />
        <Field label="LiveKit agent" name="livekit_agent_name" placeholder="sydney-tampa" />
      </FormRow>
      <div className="flex items-center gap-3 pt-2">
        <button type="submit" disabled={pending} className="glass-button-primary">
          {pending ? <Loader2 size={14} className="animate-spin" /> : null}
          {pending ? "Creating…" : "Create office"}
        </button>
        {result.kind === "ok" && (
          <span className="inline-flex items-center gap-1.5 text-mint text-[12.5px]">
            <Check size={13} /> Created
          </span>
        )}
        {result.kind === "error" && (
          <span className="text-rose-300 text-[12.5px]">{result.message}</span>
        )}
      </div>
    </form>
  );
}

export function InviteUserForm({ offices }: { offices: OfficeOption[] }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<
    | { kind: "idle" }
    | { kind: "ok"; email: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const onSubmit = async (formData: FormData) => {
    setResult({ kind: "idle" });
    const email = (formData.get("email") as string | null) ?? "";
    startTransition(async () => {
      const r = await inviteUser(formData);
      if (r.ok) {
        setResult({ kind: "ok", email });
        const form = document.getElementById("invite-user-form") as HTMLFormElement | null;
        form?.reset();
        setTimeout(() => setResult({ kind: "idle" }), 4000);
      } else {
        setResult({ kind: "error", message: r.error });
      }
    });
  };

  return (
    <form id="invite-user-form" action={onSubmit} className="space-y-3">
      <Field label="Email" name="email" type="email" placeholder="rep@office.com" required autoComplete="email" />
      <div>
        <label className="block">
          <span className="text-[11.5px] font-mono uppercase tracking-[0.14em] text-white/50 mb-1.5 block">
            Office
          </span>
          <select name="office_slug" className="glass-input" required>
            <option value="">— select —</option>
            {offices.map((o) => (
              <option key={o.slug} value={o.slug}>
                {o.name} ({o.slug})
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex items-center gap-3 pt-2">
        <button type="submit" disabled={pending} className="glass-button-primary">
          {pending ? <Loader2 size={14} className="animate-spin" /> : null}
          {pending ? "Sending…" : "Send invite"}
        </button>
        {result.kind === "ok" && (
          <span className="inline-flex items-center gap-1.5 text-mint text-[12.5px]">
            <Check size={13} /> Invite sent to {result.email}
          </span>
        )}
        {result.kind === "error" && (
          <span className="text-rose-300 text-[12.5px]">{result.message}</span>
        )}
      </div>
    </form>
  );
}

function FormRow({ children }: { children: React.ReactNode }) {
  return <div className="grid sm:grid-cols-2 gap-3">{children}</div>;
}

function Field({
  label,
  name,
  type = "text",
  placeholder,
  required,
  maxLength,
  autoComplete,
  hint,
}: {
  label: string;
  name: string;
  type?: string;
  placeholder?: string;
  required?: boolean;
  maxLength?: number;
  autoComplete?: string;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="text-[11.5px] font-mono uppercase tracking-[0.14em] text-white/50 mb-1.5 block">
        {label}
      </span>
      <input
        name={name}
        type={type}
        placeholder={placeholder}
        required={required}
        maxLength={maxLength}
        autoComplete={autoComplete}
        className="glass-input"
      />
      {hint && (
        <span className="text-[10.5px] text-white/40 mt-1 block">{hint}</span>
      )}
    </label>
  );
}
