import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import VaultCard from "./VaultCard";
import type { VaultFileInfo } from "./wikilink";

interface ProjectHubProps {
  refreshKey: number;
  projectPath: string;
  onOpenNotes: () => void;
  onOpenTodos: () => void;
}

function projectNameFromPath(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

export default function ProjectHub({ refreshKey, projectPath, onOpenNotes, onOpenTodos }: ProjectHubProps) {
  const [files, setFiles] = useState<VaultFileInfo[]>([]);
  const [hasTodos, setHasTodos] = useState(false);

  useEffect(() => {
    invoke<VaultFileInfo[]>("vault_all_files").then(setFiles).catch(() => setFiles([]));
    invoke<string>("vault_read_file", { relativePath: `${projectPath}/todos.md` })
      .then(() => setHasTodos(true))
      .catch(() => setHasTodos(false));
  }, [projectPath, refreshKey]);

  const noteCount = files.filter(
    (f) => f.path.startsWith(`${projectPath}/notes/`) && f.path.endsWith(".md")
  ).length;

  const name = projectNameFromPath(projectPath);

  return (
    <div className="vcolview-wrapper">
      <div className="vcolview">
        <div className="vcolview-header">
          <div className="vcolview-header-left">
            <h2 className="vcolview-title">{name}</h2>
          </div>
        </div>

        <div className="vgrid-pivot">
          <VaultCard
            variant="pivot"
            collection="projects"
            title="Notes"
            icon="❑"
            meta={<span>{noteCount} {noteCount === 1 ? "note" : "notes"}</span>}
            onClick={onOpenNotes}
          />
          <VaultCard
            variant="pivot"
            collection="projects"
            title="Todos"
            icon="✓"
            meta={<span>{hasTodos ? "Open todos.md" : "Create todos.md"}</span>}
            onClick={onOpenTodos}
          />
        </div>
      </div>
    </div>
  );
}
