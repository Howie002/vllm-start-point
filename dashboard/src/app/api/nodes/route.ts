import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";

export const dynamic = "force-dynamic";

interface NodeEntry {
  name: string;
  ip: string;
  agent_port: number;
}

export function GET() {
  try {
    // node_config.json lives one level above the dashboard directory
    const configPath = join(process.cwd(), "..", "node_config.json");
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);
    const nodes: NodeEntry[] = (config.nodes ?? []).map((n: NodeEntry) => ({
      name: n.name,
      ip: n.ip,
      agent_port: n.agent_port ?? 5000,
    }));
    return NextResponse.json(nodes);
  } catch {
    // No config found — fall back to local agent
    return NextResponse.json([{ name: "Local", ip: "localhost", agent_port: 5000 }]);
  }
}
