import { NextResponse } from "next/server";
import { readFileSync, writeFileSync, renameSync } from "fs";
import { join } from "path";

// Write JSON atomically: tmp file in the same directory, then rename. Prevents
// a crashed/interrupted handler from leaving node_config.json half-written.
function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

export const dynamic = "force-dynamic";

interface NodeEntry {
  name: string;
  ip: string;
  agent_port: number;
  setup_cmd?: string;
}

interface RenameBody {
  ip: string;
  agent_port: number;
  name: string;
}

// Rename flow — same topology as /api/nodes:
//   * master/both dashboards own the canonical nodes[] list → write locally.
//   * child dashboards have an empty local nodes[]; proxy the PATCH to master's
//     agent so the master config is the one that changes.
export async function POST(req: Request) {
  try {
    const body: RenameBody = await req.json();
    const { ip, agent_port, name } = body;

    if (!ip || !agent_port || !name) {
      return NextResponse.json({ error: "ip, agent_port, and name are required" }, { status: 400 });
    }

    const configPath = join(process.cwd(), "..", "node_config.json");
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      return NextResponse.json({ error: "node_config.json not readable" }, { status: 500 });
    }

    const role = config.role as string | undefined;
    const localNodes: NodeEntry[] = (config.nodes as NodeEntry[]) ?? [];
    const localMatch = localNodes.find(n => n.ip === ip && n.agent_port === agent_port);

    if (role !== "child" && localMatch) {
      // We own the canonical list — update in place.
      localMatch.name = name;
      config.nodes = localNodes;
      writeJsonAtomic(configPath, config);
      return NextResponse.json({ renamed: ip, name });
    }

    // Child dashboard, or master doesn't have this node: forward to master's agent.
    const masterIp = (config.master as { ip?: string } | undefined)?.ip;
    const masterAgentPort = (config.master as { agent_port?: number } | undefined)?.agent_port ?? 5000;
    if (!masterIp) {
      return NextResponse.json({ error: "No master IP configured — cannot proxy rename" }, { status: 500 });
    }

    // Hard timeout so an unreachable master can't tie up this route handler.
    let res: Response;
    try {
      res = await fetch(`http://${masterIp}:${masterAgentPort}/nodes/${encodeURIComponent(ip)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, agent_port }),
        signal: AbortSignal.timeout(8000),
      });
    } catch (e) {
      return NextResponse.json(
        { error: `Could not reach master agent at ${masterIp}:${masterAgentPort} — ${String(e)}` },
        { status: 504 },
      );
    }
    if (!res.ok) {
      const detail = await res.text();
      return NextResponse.json({ error: detail || `master agent → ${res.status}` }, { status: res.status });
    }
    return NextResponse.json(await res.json());
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
