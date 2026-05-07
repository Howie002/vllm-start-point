import { NextResponse } from "next/server";
import { readFileSync, writeFileSync, renameSync } from "fs";
import { join } from "path";

// Write JSON atomically: tmp file in the same directory, fsync-equivalent via
// renameSync. Prevents a crashed/interrupted handler from leaving
// node_config.json half-written and unparseable.
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

interface EditBody {
  // Identity of the node to update (current values)
  ip: string;
  agent_port: number;
  // New values
  name: string;
  new_ip: string;
  new_agent_port: number;
}

// Edit flow — same topology as /api/nodes/rename:
//   * master/both dashboards own the canonical nodes[] list → write locally.
//   * child dashboards have an empty local nodes[]; proxy the PATCH to master's
//     agent so the master config is the one that changes.
export async function POST(req: Request) {
  try {
    const body: EditBody = await req.json();
    const { ip, agent_port, name, new_ip, new_agent_port } = body;

    if (!ip || !agent_port || !name || !new_ip || !new_agent_port) {
      return NextResponse.json(
        { error: "ip, agent_port, name, new_ip, and new_agent_port are required" },
        { status: 400 },
      );
    }
    if (!/^\d{1,3}(\.\d{1,3}){3}$|^[a-zA-Z0-9.-]+$/.test(new_ip)) {
      return NextResponse.json({ error: "new_ip is not a valid IP or hostname" }, { status: 400 });
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
      const collision = localNodes.find(
        n => n !== localMatch && n.ip === new_ip && n.agent_port === new_agent_port,
      );
      if (collision) {
        return NextResponse.json(
          { error: `Another node is already registered at ${new_ip}:${new_agent_port}` },
          { status: 409 },
        );
      }
      const ipChanged = localMatch.ip !== new_ip;
      const portChanged = localMatch.agent_port !== new_agent_port;
      localMatch.name = name;
      localMatch.ip = new_ip;
      localMatch.agent_port = new_agent_port;

      if (ipChanged || portChanged) {
        const master = (config.master as { ip?: string; agent_port?: number } | undefined) ?? {};
        const masterIp = master.ip ?? (config.this_ip as string | undefined) ?? "MASTER_IP";
        const masterAgentPort = master.agent_port ?? 5000;
        localMatch.setup_cmd = [
          `VLLM_NONINTERACTIVE=1`,
          `VLLM_ROLE=child`,
          `VLLM_THIS_IP=${new_ip}`,
          `VLLM_MASTER_IP=${masterIp}`,
          `VLLM_MASTER_AGENT_PORT=${masterAgentPort}`,
          `VLLM_AGENT_PORT=${new_agent_port}`,
          `bash ./node.sh setup`,
        ].join(" ");
      }

      config.nodes = localNodes;
      writeJsonAtomic(configPath, config);
      return NextResponse.json({
        updated: { name, ip: new_ip, agent_port: new_agent_port },
      });
    }

    // Child dashboard, or master doesn't have this node: forward to master's agent.
    const masterIp = (config.master as { ip?: string } | undefined)?.ip;
    const masterAgentPort = (config.master as { agent_port?: number } | undefined)?.agent_port ?? 5000;
    if (!masterIp) {
      return NextResponse.json({ error: "No master IP configured — cannot proxy edit" }, { status: 500 });
    }

    // Hard timeout so an unreachable master can't tie up this route handler
    // (and by extension the user's tab) for the full TCP timeout window.
    let res: Response;
    try {
      res = await fetch(
        `http://${masterIp}:${masterAgentPort}/nodes/${encodeURIComponent(ip)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            agent_port,
            new_ip,
            new_agent_port,
          }),
          signal: AbortSignal.timeout(8000),
        },
      );
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
