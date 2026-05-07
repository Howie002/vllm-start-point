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

interface AddNodeBody {
  name: string;
  ip: string;
  agent_port: number;
}

export async function POST(req: Request) {
  try {
    const body: AddNodeBody = await req.json();
    const { name, ip, agent_port } = body;

    if (!name || !ip || !agent_port) {
      return NextResponse.json({ error: "name, ip, and agent_port are required" }, { status: 400 });
    }

    const configPath = join(process.cwd(), "..", "node_config.json");

    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      // No existing config — build minimal one
      config = { role: "master", nodes: [] };
    }

    const masterIp = (config.master as { ip?: string } | undefined)?.ip
      ?? (config.this_ip as string | undefined)
      ?? "MASTER_IP";

    // Store master agent_port so child dashboards can fetch the node list from master
    const masterAgentPort = (config.agent_port as number | undefined) ?? 5000;
    if (config.master && typeof config.master === "object") {
      (config.master as Record<string, unknown>).agent_port = masterAgentPort;
    }

    const setupCmd = [
      `VLLM_NONINTERACTIVE=1`,
      `VLLM_ROLE=child`,
      `VLLM_THIS_IP=${ip}`,
      `VLLM_MASTER_IP=${masterIp}`,
      `VLLM_MASTER_AGENT_PORT=${masterAgentPort}`,
      `VLLM_AGENT_PORT=${agent_port}`,
      `bash ./node.sh setup`,
    ].join(" ");

    const nodes: NodeEntry[] = (config.nodes as NodeEntry[]) ?? [];

    // Replace if same IP+port already registered, otherwise append
    const idx = nodes.findIndex((n) => n.ip === ip && n.agent_port === agent_port);
    if (idx >= 0) {
      nodes[idx] = { name, ip, agent_port, setup_cmd: setupCmd };
    } else {
      nodes.push({ name, ip, agent_port, setup_cmd: setupCmd });
    }

    config.nodes = nodes;
    writeJsonAtomic(configPath, config);

    return NextResponse.json({ added: { name, ip, agent_port }, setup_cmd: setupCmd });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
