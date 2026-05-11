"use client";

import { useEffect, useRef, useState } from "react";
import {
  Mic,
  MicOff,
  Loader2,
  Sparkles,
  X,
  Check,
} from "lucide-react";

/** Structured estimate fields the server extracts from the voice note.
 *  Mirrors `StructuredFields` in app/api/voice-note/route.ts — keep
 *  them in sync. Every field is optional; the parent merges only the
 *  fields that come back so existing rep-set values aren't overwritten
 *  by an ambiguous moment in the audio. */
export interface VoiceNoteResult {
  transcript: string;
  structured: {
    material?:
      | "asphalt-3tab"
      | "asphalt-architectural"
      | "metal-standing-seam"
      | "tile-concrete";
    complexity?: "simple" | "moderate" | "complex";
    serviceType?: "new" | "reroof-tearoff" | "layover" | "repair";
    ageYears?: number;
    carrier?: string;
    insuranceClaim?: boolean;
    customerName?: string;
    notes?: string;
    damageNotes?: string[];
    addOns?: {
      iceWater?: boolean;
      ridgeVent?: boolean;
      gutters?: boolean;
      skylight?: boolean;
    };
    timelineDays?: number;
  };
}

interface Props {
  /** Context the API forwards to Claude so it can reason about scale. */
  addressText?: string | null;
  currentSqft?: number | null;
  /** Called with the parsed result. Parent decides what to do with each
   *  field — typically merge into Assumptions / customer notes / etc. */
  onResult: (result: VoiceNoteResult) => void;
}

type RecState =
  | { kind: "idle" }
  | { kind: "permission-denied" }
  | { kind: "recording"; startedAt: number; analyser: AnalyserNode }
  | { kind: "processing" }
  | { kind: "error"; message: string };

const MAX_DURATION_SEC = 300; // 5 min — anything longer is probably accidental

/**
 * Voice-note recorder. Floating mic button at bottom-right of the
 * viewport; click to start, click again to stop. We:
 *   1. Capture from the mic via MediaRecorder (webm/opus on Chrome/Edge,
 *      MP4 on Safari)
 *   2. POST the audio + context to /api/voice-note
 *   3. Server transcribes (Whisper) → structures (Claude)
 *   4. We call `onResult` so the parent can merge the fields into the
 *      estimate state
 *
 * Privacy: nothing is stored — audio bytes hit /api/voice-note, get
 * transcribed in memory, dropped. The transcript and structured fields
 * stay client-side after the response.
 *
 * Browser support:
 *   - Chrome/Edge/Firefox desktop & Android: webm/opus
 *   - Safari (macOS/iOS): MP4 audio (we let the browser pick the type)
 *   - getUserMedia requires HTTPS or localhost
 */
export default function VoiceNoteRecorder({
  addressText,
  currentSqft,
  onResult,
}: Props) {
  const [state, setState] = useState<RecState>({ kind: "idle" });
  const [level, setLevel] = useState(0); // 0..1 normalized mic level for the pulse
  const [elapsed, setElapsed] = useState(0);
  const [lastTranscript, setLastTranscript] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  /** Tear down all the AudioContext / MediaStream / RAF plumbing on
   *  unmount or stop. Without this, the browser keeps the mic indicator
   *  lit and the AudioContext leaks. */
  const cleanup = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    audioCtxRef.current?.close().catch(() => undefined);
    audioCtxRef.current = null;
  };

  useEffect(() => () => cleanup(), []);

  // Tick elapsed time + animate level while recording
  useEffect(() => {
    if (state.kind !== "recording") return;
    let cancelled = false;
    const buf = new Uint8Array(state.analyser.fftSize);
    const tick = () => {
      if (cancelled) return;
      state.analyser.getByteTimeDomainData(buf);
      // RMS for a stable "is the rep talking" pulse — not a true VU.
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      setLevel(Math.min(1, rms * 6));
      setElapsed((Date.now() - state.startedAt) / 1000);
      if ((Date.now() - state.startedAt) / 1000 >= MAX_DURATION_SEC) {
        stop();
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.kind]);

  const start = async () => {
    setLastTranscript(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      // Pick the best supported mime — webm/opus everywhere except
      // Safari, where mp4/aac is the only option. Whisper handles both.
      const mimeCandidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
        "",
      ];
      const mime =
        mimeCandidates.find(
          (m) => !m || MediaRecorder.isTypeSupported(m),
        ) ?? "";

      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = () => handleStopped(mr.mimeType || mime || "audio/webm");
      mediaRecorderRef.current = mr;

      // AudioContext + AnalyserNode for the visual pulse
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx: AudioContext = new Ctx();
      audioCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);

      mr.start(250);
      setState({ kind: "recording", startedAt: Date.now(), analyser });
      setElapsed(0);
    } catch (err) {
      console.warn("[voice-note] getUserMedia failed:", err);
      // Most likely the user denied permission, but could be no mic, etc.
      const msg = err instanceof Error ? err.message : "";
      if (/denied|notallowed/i.test(msg)) {
        setState({ kind: "permission-denied" });
      } else {
        setState({ kind: "error", message: "Couldn't access microphone." });
      }
    }
  };

  const stop = () => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
  };

  const handleStopped = async (mime: string) => {
    setState({ kind: "processing" });
    const blob = new Blob(chunksRef.current, { type: mime });
    cleanup();
    chunksRef.current = [];

    if (blob.size < 1024) {
      setState({
        kind: "error",
        message: "Recording too short — try again, hold the mic for a few seconds.",
      });
      return;
    }

    try {
      const fd = new FormData();
      fd.append("audio", blob, `voice-note.${mime.includes("mp4") ? "mp4" : "webm"}`);
      if (addressText) fd.append("addressText", addressText);
      if (currentSqft != null) fd.append("currentSqft", String(currentSqft));

      const res = await fetch("/api/voice-note", {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`${res.status}: ${body.slice(0, 120)}`);
      }
      const data = (await res.json()) as VoiceNoteResult;
      setLastTranscript(data.transcript);
      onResult(data);
      setState({ kind: "idle" });
    } catch (err) {
      console.warn("[voice-note] upload failed:", err);
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "Upload failed.",
      });
    }
  };

  // ─── UI ────────────────────────────────────────────────────────────
  const recording = state.kind === "recording";
  const processing = state.kind === "processing";
  const elapsedStr = formatElapsed(elapsed);

  return (
    <>
      {/* Floating mic button */}
      <button
        type="button"
        onClick={recording ? stop : start}
        disabled={processing}
        aria-label={recording ? "Stop voice note" : "Record voice note"}
        className={`fixed bottom-6 right-6 z-50 flex items-center gap-2.5 rounded-full pl-4 pr-5 py-3 transition-all border ${
          recording
            ? "bg-rose-500 hover:bg-rose-400 border-rose-300/40 text-white"
            : processing
              ? "bg-cy-300/20 border-cy-300/40 text-cy-100 cursor-wait"
              : "bg-cy-300 hover:bg-cy-200 border-cy-200/40 text-[#051019]"
        }`}
        style={
          recording
            ? {
                boxShadow: `inset 0 1.5px 0 rgba(255,255,255,0.45), inset 0 -1px 0 rgba(0,0,0,0.18), 0 8px 24px -6px rgba(244,63,94,0.55), 0 0 ${
                  4 + level * 28
                }px ${2 + level * 8}px rgba(244,63,94,${0.18 + level * 0.45})`,
              }
            : {
                boxShadow:
                  "inset 0 1.5px 0 rgba(255,255,255,0.7), inset 0 -1px 0 rgba(0,0,0,0.18), 0 8px 24px -4px rgba(103,220,255,0.55), 0 18px 48px -16px rgba(167,139,250,0.30)",
              }
        }
      >
        {processing ? (
          <Loader2 size={16} className="animate-spin" />
        ) : recording ? (
          <MicOff size={16} />
        ) : (
          <Mic size={16} />
        )}
        <span className="text-[13px] font-medium tracking-tight">
          {processing
            ? "Transcribing…"
            : recording
              ? `Recording · ${elapsedStr}`
              : "Voice note"}
        </span>
      </button>

      {/* Tiny floating transcript toast after success — gives the rep
          immediate proof "yes I heard what you said" and shows what the
          form just auto-filled with. Auto-dismisses after 12s OR click
          the X. */}
      {lastTranscript && state.kind === "idle" && (
        <ToastTranscript
          text={lastTranscript}
          onDismiss={() => setLastTranscript(null)}
        />
      )}

      {/* Error / permission-denied toasts */}
      {state.kind === "permission-denied" && (
        <ErrorToast
          title="Microphone blocked"
          body="Allow microphone access in your browser settings to use voice notes."
          onDismiss={() => setState({ kind: "idle" })}
        />
      )}
      {state.kind === "error" && (
        <ErrorToast
          title="Voice note failed"
          body={state.message}
          onDismiss={() => setState({ kind: "idle" })}
        />
      )}
    </>
  );
}

function formatElapsed(s: number): string {
  const total = Math.floor(s);
  const m = Math.floor(total / 60);
  const r = total % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function ToastTranscript({
  text,
  onDismiss,
}: {
  text: string;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 12_000);
    return () => clearTimeout(t);
  }, [onDismiss]);
  return (
    <div
      className="fixed bottom-24 right-6 z-50 max-w-md rounded-2xl border border-cy-300/30 bg-[#0c1118]/95 backdrop-blur-md px-4 py-3 shadow-2xl"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-2.5">
        <Sparkles size={14} className="text-cy-300 mt-0.5 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-[10.5px] font-mono uppercase tracking-[0.14em] text-cy-300/90 mb-1.5">
            <Check size={11} /> Voice note transcribed · estimate auto-filled
          </div>
          <p className="text-[12.5px] text-slate-200 leading-relaxed">
            &ldquo;{text}&rdquo;
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-slate-500 hover:text-slate-300 flex-shrink-0 -mt-0.5"
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

function ErrorToast({
  title,
  body,
  onDismiss,
}: {
  title: string;
  body: string;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 8_000);
    return () => clearTimeout(t);
  }, [onDismiss]);
  return (
    <div
      className="fixed bottom-24 right-6 z-50 max-w-sm rounded-2xl border border-rose-400/30 bg-[#0c1118]/95 backdrop-blur-md px-4 py-3 shadow-2xl"
      role="alert"
    >
      <div className="flex items-start gap-2.5">
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-semibold text-rose-300 mb-0.5">
            {title}
          </div>
          <p className="text-[12px] text-slate-300 leading-relaxed">{body}</p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-slate-500 hover:text-slate-300 flex-shrink-0 -mt-0.5"
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
