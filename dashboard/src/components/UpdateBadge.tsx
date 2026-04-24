"use client";

import type { ClusterNodeStatus } from "@/lib/types";

interface Props {
  nodeStatuses: ClusterNodeStatus[];
  onClick: () => void;
}

export function UpdateBadge({ nodeStatuses, onClick }: Props) {
  const updates = nodeStatuses
    .map(ns => ns.status?.update)
    .filter((u): u is NonNullable<typeof u> => !!u);

  if (updates.length === 0) return null;

  const totalBehind = updates.reduce((s, u) => s + u.behind, 0);
  const anyError   = updates.some(u => !!u.error);
  const anyDirty   = updates.some(u => u.dirty);
  const anyBehind  = updates.some(u => u.behind > 0);

  if (!anyBehind && !anyError && !anyDirty) return null;

  let label: string;
  let tone: "red" | "amber";
  if (anyError) {
    label = "update check failed";
    tone = "red";
  } else if (anyBehind) {
    label = `${totalBehind} commit${totalBehind !== 1 ? "s" : ""} behind`;
    tone = "amber";
  } else {
    label = "local changes";
    tone = "amber";
  }

  const toneClasses = tone === "red"
    ? "bg-red-900/30 border-red-700 text-red-300 hover:bg-red-900/50"
    : "bg-amber-900/30 border-amber-700 text-amber-300 hover:bg-amber-900/50";

  return (
    <button
      onClick={onClick}
      className={`text-[11px] px-2.5 py-1 rounded-lg border transition-colors flex items-center gap-1.5 ${toneClasses}`}
      title="Open Settings"
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
      {label}
    </button>
  );
}
