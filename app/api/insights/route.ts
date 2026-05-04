import { NextResponse } from "next/server";

interface InsightRequest {
  address: string;
  zip?: string;
  sqft: number;
  pitch: string;
  material: string;
  ageYears: number;
  total: number;
}

export async function POST(req: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY not set on server" },
      { status: 503 }
    );
  }

  let body: InsightRequest;
  try {
    body = (await req.json()) as InsightRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const prompt = `You are a roofing sales assistant. In 3 short bullet points, give the rep tactical
notes they can use on a sales call. Be concrete, no fluff.

Property: ${body.address}${body.zip ? " (" + body.zip + ")" : ""}
Roof: ${body.sqft} sq ft, ${body.pitch} pitch, ${body.material}, ~${body.ageYears} yrs old.
Estimate: $${body.total.toLocaleString()}.

Cover: (1) likely condition concerns at this age, (2) one upsell opportunity worth pitching,
(3) one objection to be ready for. Output as a markdown bulleted list, nothing else.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.5, maxOutputTokens: 400 },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json({ error: "Gemini error", detail: text }, { status: 502 });
  }
  const data = await res.json();
  const text =
    data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "No insights returned.";
  return NextResponse.json({ text });
}
