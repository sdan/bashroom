// Fire N requests with a concurrency pool (dev server chokes on 50 raw
// sockets; 10 overlapping in-flight keeps real concurrency at the DO).
const BASE = process.argv[2] || "http://localhost:8791";
const N = 50;
const POOL = 10;

async function get(path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await fetch(BASE + path).then((r) => r.json()); }
    catch { await new Promise((r) => setTimeout(r, 30)); }
  }
  throw new Error("gave up: " + path);
}

async function blast(path) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: POOL }, async () => {
    while (next < N) { next++; results.push(await get(path)); }
  }));
  return results;
}

const order = await blast("/order");
const seqs = order.map((r) => r.seq).sort((a, b) => a - b);
const unique = new Set(seqs).size;
const gapFree = seqs.every((s, i) => s === i + 1);

await blast("/gated");
await blast("/hazard");

const report = await get("/report");

console.log(JSON.stringify({
  order: { requests: N, unique_seqs: unique, gap_free: gapFree, verdict: unique === N && gapFree ? "SERIALIZED" : "INTERLEAVED" },
  gated: { requests: N, final: report.gated_final, verdict: report.gated_final === N ? "ATOMIC (input gates held)" : "LOST UPDATES" },
  hazard: { requests: N, final: report.hazard_final, verdict: report.hazard_final < N ? "INTERLEAVED AT AWAIT (caveat confirmed)" : "no interleaving observed" },
}, null, 2));
