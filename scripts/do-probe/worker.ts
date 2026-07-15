import { DurableObject } from "cloudflare:workers";

// Empirical probe for DO serialization claims:
//  /order  — fully synchronous handler: every request takes a sequence number
//            from an in-memory counter. CLAIM: 50 concurrent requests get 50
//            unique, gap-free sequence numbers (strict one-at-a-time delivery).
//  /gated  — read-modify-write through DO storage (awaits storage). CLAIM:
//            input/output gates keep this atomic — final count == N exactly.
//  /hazard — read in-memory value, await a TIMER (non-storage await), then
//            write back. CLAIM (the caveat): other requests interleave at the
//            await point, so increments are LOST — final count < N.
export class OrderProbe extends DurableObject {
  seq = 0;
  mem = 0;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/order") {
      const mine = ++this.seq; // synchronous — no await before or after
      return Response.json({ seq: mine });
    }

    if (url.pathname === "/gated") {
      const key = url.searchParams.get("k") || "n";
      const v = ((await this.ctx.storage.get<number>(key)) ?? 0) + 1;
      await this.ctx.storage.put(key, v);
      return Response.json({ n: v });
    }
    if (url.pathname === "/read") {
      const key = url.searchParams.get("k") || "n";
      return Response.json({ n: (await this.ctx.storage.get<number>(key)) ?? 0 });
    }

    if (url.pathname === "/hazard") {
      const v = this.mem; // read BEFORE the non-storage await
      await scheduler.wait(5 + Math.floor(Math.random() * 15));
      this.mem = v + 1;   // write-back — lost if another request interleaved
      return Response.json({ mem: this.mem });
    }

    if (url.pathname === "/report") {
      return Response.json({
        order_final_seq: this.seq,
        gated_final: (await this.ctx.storage.get<number>("n")) ?? 0,
        hazard_final: this.mem,
      });
    }

    return new Response("unknown", { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: { PROBE: DurableObjectNamespace }): Promise<Response> {
    const stub = env.PROBE.get(env.PROBE.idFromName("probe-1"));
    return stub.fetch(request);
  },
};
