"use client";

import { useState } from "react";
import type { GPU, VLLMInstance } from "@/lib/types";

function vramPct(gpu: GPU) {
  return Math.round((gpu.vram_used_mb / gpu.vram_total_mb) * 100);
}

function vramGB(mb: number) {
  return (mb / 1024).toFixed(1);
}

function barColor(pct: number) {
  if (pct < 60) return "bg-emerald-500";
  if (pct < 85) return "bg-amber-400";
  return "bg-red-500";
}

function tempColor(c: number) {
  if (c < 70) return "text-emerald-400";
  if (c < 85) return "text-amber-400";
  return "text-red-400";
}

function fmt(val: number | null | undefined, decimals = 0, fallback = "—") {
  if (val == null) return fallback;
  return decimals > 0 ? val.toFixed(decimals) : String(Math.round(val));
}

interface StatBoxProps {
  label: string;
  value: string;
  sub?: string;
  valueClass?: string;
  bar?: { pct: number; color: string };
}

function StatBox({ label, value, sub, valueClass = "text-white", bar }: StatBoxProps) {
  return (
    <div className="bg-slate-800/60 rounded-lg px-3 py-2.5 space-y-1">
      <p className="text-xs text-slate-500 uppercase tracking-wider">{label}</p>
      <p className={`text-sm font-semibold leading-tight ${valueClass}`}>{value}</p>
      {sub && <p className="text-xs text-slate-500">{sub}</p>}
      {bar && (
        <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden mt-1">
          <div
            className={`h-full rounded-full ${bar.color}`}
            style={{ width: `${Math.min(bar.pct, 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

interface Props {
  gpus: GPU[];
  instances: VLLMInstance[];
}

export function GPUGrid({ gpus, instances }: Props) {
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {gpus.map((gpu) => {
          const pct      = vramPct(gpu);
          const isOpen   = expanded === gpu.index;

          return (
            <div
              key={gpu.index}
              className={`bg-card border rounded-xl p-4 space-y-3 cursor-pointer transition-colors ${
                isOpen ? "border-blue-500/60" : "border-border hover:border-slate-600"
              }`}
              onClick={() => setExpanded(isOpen ? null : gpu.index)}
            >
              {/* Header */}
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
                  GPU {gpu.index}
                </span>
                <div className="flex items-center gap-2">
                  {gpu.temperature_c != null && (
                    <span className={`text-xs font-medium ${tempColor(gpu.temperature_c)}`}>
                      {gpu.temperature_c}°C
                    </span>
                  )}
                  <span className="text-xs text-slate-500">{gpu.utilization_pct}%</span>
                  <span className="text-slate-600 text-xs">{isOpen ? "▲" : "▼"}</span>
                </div>
              </div>

              <p className="text-sm font-medium text-white leading-tight truncate" title={gpu.name}>
                {gpu.name}
              </p>

              {/* VRAM bar */}
              <div>
                <div className="flex justify-between text-xs text-slate-400 mb-1">
                  <span>{vramGB(gpu.vram_used_mb)} GB used</span>
                  <span>{vramGB(gpu.vram_total_mb)} GB total</span>
                </div>
                <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${barColor(pct)}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>

              {/* Processes */}
              {gpu.processes && gpu.processes.length > 0 ? (
                <div className="space-y-1">
                  {gpu.processes.map((proc) => {
                    const isVllm = proc.label.startsWith("vllm");
                    const vllmInst = isVllm
                      ? instances.find((i) => i.gpu_index === gpu.index)
                      : undefined;

                    return (
                      <div
                        key={proc.pid}
                        className="flex items-center gap-2 text-xs bg-slate-800 rounded px-2 py-1.5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {isVllm ? (
                          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                            vllmInst?.status === "healthy"
                              ? "bg-emerald-400"
                              : "bg-amber-400 animate-pulse"
                          }`} />
                        ) : (
                          <span className="w-2 h-2 rounded-full flex-shrink-0 bg-slate-500" />
                        )}
                        <span className="text-slate-300 truncate flex-1 min-w-0" title={proc.label}>
                          {proc.label}
                        </span>
                        <span className="text-slate-500 flex-shrink-0">
                          {vramGB(proc.vram_used_mb)}G
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs text-slate-600 italic">No processes</p>
              )}
            </div>
          );
        })}
      </div>

      {/* Expanded detail panel */}
      {expanded !== null && (() => {
        const gpu = gpus.find((g) => g.index === expanded);
        if (!gpu) return null;

        const memPct      = vramPct(gpu);
        const powerPct    = gpu.power_limit_w ? (gpu.power_draw_w ?? 0) / gpu.power_limit_w * 100 : 0;
        const powerColor  = powerPct > 95 ? "bg-red-500" : powerPct > 80 ? "bg-amber-400" : "bg-emerald-500";

        return (
          <div className="bg-slate-900/70 border border-blue-500/30 rounded-xl px-5 py-4 space-y-4">
            {/* Title */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-white">{gpu.name}</p>
                <p className="text-xs text-slate-500 font-mono mt-0.5">GPU {gpu.index}</p>
              </div>
              <button
                onClick={() => setExpanded(null)}
                className="text-slate-500 hover:text-white text-lg leading-none"
              >
                ✕
              </button>
            </div>

            {/* Stats grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <StatBox
                label="Temperature"
                value={gpu.temperature_c != null ? `${gpu.temperature_c}°C` : "—"}
                valueClass={gpu.temperature_c != null ? tempColor(gpu.temperature_c) : "text-slate-500"}
              />
              <StatBox
                label="Fan Speed"
                value={gpu.fan_speed_pct != null ? `${Math.round(gpu.fan_speed_pct)}%` : "—"}
                sub={gpu.fan_speed_pct != null ? "active cooling" : "passive / N/A"}
                bar={gpu.fan_speed_pct != null
                  ? { pct: gpu.fan_speed_pct, color: "bg-blue-400" }
                  : undefined}
              />
              <StatBox
                label="GPU Load"
                value={`${gpu.utilization_pct}%`}
                bar={{ pct: gpu.utilization_pct, color: barColor(gpu.utilization_pct) }}
              />
              <StatBox
                label="Memory"
                value={`${memPct}%`}
                sub={`${vramGB(gpu.vram_used_mb)} / ${vramGB(gpu.vram_total_mb)} GB`}
                bar={{ pct: memPct, color: barColor(memPct) }}
              />
              <StatBox
                label="Clock Speed"
                value={gpu.clock_mhz != null ? `${fmt(gpu.clock_mhz)} MHz` : "—"}
              />
              <StatBox
                label="Power Draw"
                value={gpu.power_draw_w != null
                  ? `${gpu.power_draw_w.toFixed(1)} W`
                  : "—"}
                sub={gpu.power_limit_w != null
                  ? `limit ${gpu.power_limit_w.toFixed(0)} W`
                  : undefined}
                bar={gpu.power_draw_w != null && gpu.power_limit_w != null
                  ? { pct: powerPct, color: powerColor }
                  : undefined}
              />
            </div>
          </div>
        );
      })()}
    </div>
  );
}
