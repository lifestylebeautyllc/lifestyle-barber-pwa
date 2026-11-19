// deno-lint-ignore no-import-prefix
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
// deno-lint-ignore no-import-prefix
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/**
 * Calculates the exact next 7:00 AM in America/Los_Angeles (PST/PDT-aware) as an ISO-8601 UTC string.
 */
function getNext7AMPacificISO(now: Date = new Date()): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(now);
  const getPart = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value || "0");

  const laYear = getPart("year");
  const laMonth = getPart("month");
  const laDay = getPart("day");
  const laHour = getPart("hour");

  // If it's currently before 7:00 AM Pacific, schedule for 7:00 AM today; otherwise 7:00 AM tomorrow.
  const targetLocalDate = new Date(
    Date.UTC(laYear, laMonth - 1, laHour < 7 ? laDay : laDay + 1),
  );
  const tYear = targetLocalDate.getUTCFullYear();
  const tMonth = targetLocalDate.getUTCMonth();
  const tDay = targetLocalDate.getUTCDate();

  // 07:00 PST is 15:00 UTC; 07:00 PDT is 14:00 UTC.
  const candidateUtc = new Date(Date.UTC(tYear, tMonth, tDay, 15, 0, 0));
  const candidateParts = formatter.formatToParts(candidateUtc);
  const candidateLaHour = Number(
    candidateParts.find((p) => p.type === "hour")?.value || "7",
  );
  const hourDiff = candidateLaHour - 7;
  const exact7AmUtc = new Date(
    candidateUtc.getTime() - hourDiff * 60 * 60 * 1000,
  );

  return exact7AmUtc.toISOString();
}

async function sendTwilioSms(
  accountSid: string,
  authToken: string,
  fromNumber: string,
  to: string,
  message: string,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const endpoint =
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const body = new URLSearchParams({
    To: to,
    From: fromNumber,
    Body: message,
  });

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${btoa(`${accountSid}:${authToken}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const data = (await response.json()) as Record<string, unknown>;
  return { ok: response.ok, status: response.status, data };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const payload = await req.json();
    const {
      to,
      message,
      scheduleFor7AM,
      appointmentId,
      action,
    } = payload as {
      to?: string;
      message?: string;
      scheduleFor7AM?: boolean;
      appointmentId?: string | null;
      action?: string;
    };

    const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID");
    const authToken = Deno.env.get("TWILIO_AUTH_TOKEN");
    const fromNumber = Deno.env.get("TWILIO_PHONE_NUMBER");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    // 1. FLUSH QUEUE ACTION (invoked every 15 minutes by pg_cron / pg_net)
    if (action === "flush_queue") {
      if (!supabaseUrl || !supabaseServiceRoleKey) {
        return new Response(
          JSON.stringify({
            error: "Supabase service role credentials not configured",
          }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      if (!accountSid || !authToken || !fromNumber) {
        return new Response(
          JSON.stringify({
            error: "Twilio credentials not configured on backend",
          }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
      const nowIso = new Date().toISOString();

      const { data: pendingRows, error: fetchErr } = await supabaseAdmin
        .from("scheduled_sms_queue")
        .select("*")
        .eq("status", "pending")
        .lte("send_after", nowIso)
        .order("send_after", { ascending: true })
        .limit(50);

      if (fetchErr) {
        return new Response(JSON.stringify({ error: fetchErr.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      let sentCount = 0;
      let failedCount = 0;

      for (const row of pendingRows || []) {
        try {
          const result = await sendTwilioSms(
            accountSid,
            authToken,
            fromNumber,
            row.to_phone,
            row.message,
          );

          if (result.ok) {
            sentCount++;
            await supabaseAdmin
              .from("scheduled_sms_queue")
              .update({
                status: "sent",
                sent_at: new Date().toISOString(),
                error_message: null,
              })
              .eq("id", row.id);
          } else {
            failedCount++;
            const errMsg = typeof result.data?.message === "string"
              ? result.data.message
              : `Twilio HTTP ${result.status}`;
            await supabaseAdmin
              .from("scheduled_sms_queue")
              .update({
                status: "failed",
                error_message: errMsg,
              })
              .eq("id", row.id);
          }
        } catch (sendErr: unknown) {
          failedCount++;
          const errMsg = sendErr instanceof Error
            ? sendErr.message
            : "Unknown Twilio send error";
          await supabaseAdmin
            .from("scheduled_sms_queue")
            .update({
              status: "failed",
              error_message: errMsg,
            })
            .eq("id", row.id);
        }
      }

      return new Response(
        JSON.stringify({
          status: "flushed",
          processed: (pendingRows || []).length,
          sent: sentCount,
          failed: failedCount,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Validate `to` and `message` for single SMS (immediate or queued)
    if (!to || !message) {
      return new Response(
        JSON.stringify({ error: "Missing 'to' or 'message' field" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // 2. QUIET-HOURS QUEUE MODE (scheduleFor7AM: true)
    if (scheduleFor7AM === true) {
      if (!supabaseUrl || !supabaseServiceRoleKey) {
        return new Response(
          JSON.stringify({
            error: "Supabase service role credentials not configured",
          }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
      const sendAfterIso = getNext7AMPacificISO();

      const { data: queuedRow, error: insertErr } = await supabaseAdmin
        .from("scheduled_sms_queue")
        .insert({
          to_phone: to,
          message,
          send_after: sendAfterIso,
          status: "pending",
          appointment_id: appointmentId || null,
        })
        .select("*")
        .single();

      if (insertErr) {
        return new Response(JSON.stringify({ error: insertErr.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(
        JSON.stringify({
          status: "queued",
          queued: true,
          send_after: sendAfterIso,
          data: queuedRow,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // 3. DEFAULT IMMEDIATE SEND VIA TWILIO
    if (!accountSid || !authToken || !fromNumber) {
      return new Response(
        JSON.stringify({
          error: "Twilio credentials not configured on backend",
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const result = await sendTwilioSms(
      accountSid,
      authToken,
      fromNumber,
      to,
      message,
    );

    return new Response(JSON.stringify(result.data), {
      status: result.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error
      ? error.message
      : "Unknown error occurred";
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
