// Lazy façade over Model3DViewer.jsx.
//
// Model3DViewer pulls in three, @react-three/fiber, @react-three/drei and
// OBJLoader — several hundred KB that most boards never need, since only
// `3d-model` cards render it. Importing it statically from Canvas/CanvasElement
// put all of that in the initial canvas bundle. Everything goes through this
// module instead, so the three.js chunk is fetched only when a 3D model is
// actually shown.
//
// The API is drop-in compatible with Model3DViewer's three exports.
import { lazy, Suspense } from "react";
import { FallbackCard, getModelExt } from "./model3dFallback";

const loadViewer = () => import("./Model3DViewer");

const LazyThumbnail = lazy(() => loadViewer().then((m) => ({ default: m.Model3DThumbnail })));
const LazyInlineViewer = lazy(() => loadViewer().then((m) => ({ default: m.Model3DInlineViewer })));
const LazyViewerModal = lazy(() => loadViewer().then((m) => ({ default: m.Model3DViewerModal })));

// While the chunk loads we show the exact placeholder the real thumbnail shows
// before its poster capture finishes, so there is no flash on the swap.
export function Model3DThumbnail({ url, title }) {
  if (!url) return <FallbackCard title={title} ext="" failed={false} />;
  return (
    <Suspense fallback={<div className="element-3d-thumb"><FallbackCard title={title} ext={getModelExt(url)} failed={false} /></div>}>
      <LazyThumbnail url={url} title={title} />
    </Suspense>
  );
}

export function Model3DInlineViewer({ url, title, autoRotate = true }) {
  if (!url) return null;
  return (
    <Suspense fallback={<div className="model3d-inline" />}>
      <LazyInlineViewer url={url} title={title} autoRotate={autoRotate} />
    </Suspense>
  );
}

// Gated on `open` so merely rendering the modal in the canvas tree (its normal
// always-mounted-but-closed state) does not pull the three.js chunk.
export function Model3DViewerModal({ open, url, title, onClose }) {
  if (!open || !url) return null;
  return (
    <Suspense fallback={null}>
      <LazyViewerModal open={open} url={url} title={title} onClose={onClose} />
    </Suspense>
  );
}
