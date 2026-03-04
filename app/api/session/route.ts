import { VOICE } from "@/lib/config";
import { MODEL, REALTIME_CLIENT_SECRETS_URL } from "@/lib/constants";

// Mint a short-lived Realtime client secret for the browser WebRTC session.
export async function GET() {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "OPENAI_API_KEY is not configured" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }

  try {
    const response = await fetch(REALTIME_CLIENT_SECRETS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        expires_after: {
          anchor: "created_at",
          seconds: 600,
        },
        session: {
          type: "realtime",
          model: MODEL,
          audio: {
            output: {
              voice: VOICE,
            },
          },
        },
      }),
      cache: "no-store",
    });

    const body = await response.text();

    return new Response(body, {
      status: response.status,
      headers: {
        "Content-Type":
          response.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (error: any) {
    console.error("Failed to create realtime client secret:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }
}
