// Static (three.js-free) pieces of the 3D model card, split out so both the real
// viewer and its lazy wrapper can render the identical placeholder. Keeping this
// module free of three/@react-three is the whole point: it stays in the eager
// canvas bundle while Model3DViewer.jsx is loaded on demand.
import { Box } from "lucide-react";

// eslint-disable-next-line react-refresh/only-export-components
export function getModelExt(url = "") {
  try {
    const clean = String(url).split("?")[0].split("#")[0];
    const match = clean.match(/\.[a-z0-9]+$/i);
    return match ? match[0].toLowerCase() : "";
  } catch {
    return "";
  }
}

export function FallbackCard({ title, ext, failed }) {
  return (
    <div className="element-ae-project element-3d-card">
      <div className="element-ae-icon"><Box size={34} /></div>
      <div className="element-ae-copy">
        <div className="element-ae-title">{title || "3D Model"}</div>
        <div className="element-ae-meta">{failed ? "3D preview unavailable" : `${ext || ".glb"} model`}</div>
      </div>
    </div>
  );
}
