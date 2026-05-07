import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";

export const dynamic = "force-dynamic";

interface NodeEntry {
  name: string;
  ip: string;
  agent_port: number;
  setup_cmd?: string;
}

export async function GET() {
  try {
    const configPath = join(process.cwd(), "..", "node_config.json");
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);

    // Child node: fetch the full cluster node list from master's agent
    if (config.role === "child") {
      const masterIp = config.master?.ip;
      const masterAgentPort = config.master?.agent_port ?? 5000;
      if (masterIp) {
        try {
          // Hard cap so an unreachable master doesn't tie up the route
          // handler (and by extension the child dashboard's poll loop).
          const res = await fetch(`http://${masterIp}:${masterAgentPort}/nodes`, {
            cache: "no-store",
            signal: AbortSignal.timeout(5000),
          });
          if (res.ok) {
            return NextResponse.json(await res.json());
          }
        } catch {
          // Master unreachable / timed out — fall through to local config
        }
      }
    }

    // Master or fallback: use local node list
    const nodes: NodeEntry[] = (config.nodes ?? []).map((n: NodeEntry) => ({
      name: n.name,
      ip: n.ip,
      agent_port: n.agent_port ?? 5000,
      ...(n.setup_cmd ? { setup_cmd: n.setup_cmd } : {}),
    }));
    return NextResponse.json(nodes);
  } catch {
    return NextResponse.json([{ name: "Local", ip: "localhost", agent_port: 5000 }]);
  }
}
