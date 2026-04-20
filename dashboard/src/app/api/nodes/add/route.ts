import { NextResponse } from "next/server";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

export const dynamic = "force-dynamic";

interface NodeEntry {
  name: string;
  ip: string;
  agent_port: number;
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

    const nodes: NodeEntry[] = (config.nodes as NodeEntry[]) ?? [];

    // Replace if same IP+port already registered, otherwise append
    const idx = nodes.findIndex((n) => n.ip === ip && n.agent_port === agent_port);
    if (idx >= 0) {
      nodes[idx] = { name, ip, agent_port };
    } else {
      nodes.push({ name, ip, agent_port });
    }

    config.nodes = nodes;
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    // Build the setup one-liner for the child machine
    const masterIp = (config.master as { ip?: string } | undefined)?.ip
      ?? (config.this_ip as string | undefined)
      ?? "MASTER_IP";

    const setupCmd = [
      `VLLM_NONINTERACTIVE=1`,
      `VLLM_ROLE=child`,
      `VLLM_THIS_IP=${ip}`,
      `VLLM_MASTER_IP=${masterIp}`,
      `VLLM_AGENT_PORT=${agent_port}`,
      `bash ./node.sh setup`,
    ].join(" ");

    return NextResponse.json({ added: { name, ip, agent_port }, setup_cmd: setupCmd });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
