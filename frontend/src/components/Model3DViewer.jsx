import { Component, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useLoader, useThree } from "@react-three/fiber";
import { Bounds, Center, Environment, OrbitControls, useGLTF } from "@react-three/drei";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { X } from "lucide-react";
import { FallbackCard, getModelExt } from "./model3dFallback";

// 3D model viewer for canvas elements (.glb / .gltf / .obj). Two exports:
//   - <Model3DThumbnail>  : the on-board poster. Renders ONE frame to an image
//                           then drops its WebGL context, so a board can hold
//                           many models without hitting the browser's live-
//                           context cap. Falls back to a static card.
//   - <Model3DViewerModal>: the full interactive orbit/zoom viewer, opened on
//                           demand (mirrors how AE/Blender elements open their
//                           inspector panel).
// Lighting/environment mirror the mockup generator (MockupScene.jsx): the HDR
// is bundled in /public/hdr so it works fully offline.

const HDR_URL = `${import.meta.env.BASE_URL || "/"}hdr/potsdamer_platz_1k.hdr`.replace(/([^:])\/{2,}/g, "$1/");

// At most this many poster captures render concurrently; the rest queue. Keeps
// the number of simultaneous WebGL contexts tiny regardless of board size.
const MAX_CONCURRENT_CAPTURES = 2;
const posterCache = new Map(); // url -> dataURL | "failed"
let activeCaptures = 0;
const captureQueue = [];

function acquireCaptureSlot() {
  if (activeCaptures < MAX_CONCURRENT_CAPTURES) {
    activeCaptures += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => captureQueue.push(resolve));
}

function releaseCaptureSlot() {
  const next = captureQueue.shift();
  if (next) {
    next(); // hand the slot straight to the next waiter (activeCaptures unchanged)
  } else {
    activeCaptures = Math.max(0, activeCaptures - 1);
  }
}

// Catches loader failures (bad file, missing .bin/textures) inside the R3F tree
// so a broken model degrades to a fallback instead of blanking the <Canvas>.
class ModelErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    if (typeof console !== "undefined") {
      console.warn("[3d-viewer] model failed to load:", error?.message || error);
    }
    this.props.onError?.(error);
  }

  render() {
    if (this.state.failed) return this.props.fallback ?? null;
    return this.props.children;
  }
}

function GltfModel({ url }) {
  const { scene } = useGLTF(url);
  // Clone so the same cached gltf can appear in the poster and the modal at
  // once (a three Object3D can only have one parent).
  const object = useMemo(() => scene.clone(true), [scene]);
  return <primitive object={object} />;
}

function ObjModel({ url }) {
  const obj = useLoader(OBJLoader, url);
  const object = useMemo(() => {
    const root = obj.clone(true);
    // OBJ has no embedded materials; give bare meshes a neutral PBR material so
    // they aren't rendered invisible/black.
    root.traverse((child) => {
      if (child.isMesh) {
        const hasMaterial = Array.isArray(child.material) ? child.material.length > 0 : Boolean(child.material);
        if (!hasMaterial) {
          child.material = new THREE.MeshStandardMaterial({ color: 0xb8bcc6, metalness: 0.05, roughness: 0.75 });
        }
      }
    });
    return root;
  }, [obj]);
  return <primitive object={object} />;
}

function ModelObject({ url }) {
  return getModelExt(url) === ".obj" ? <ObjModel url={url} /> : <GltfModel url={url} />;
}

// Shared scene: lights + offline HDR + auto-framed model. `controls` adds orbit
// interaction (modal); the poster omits it and relies on Bounds for framing.
function ModelStage({ url, controls = false, autoRotate = false }) {
  return (
    <>
      <ambientLight intensity={0.55} />
      <directionalLight position={[6, 8, 6]} intensity={1.15} />
      <directionalLight position={[-6, 4, -4]} intensity={0.35} />
      <ModelErrorBoundaryEnv>
        <Environment files={HDR_URL} />
      </ModelErrorBoundaryEnv>
      <Suspense fallback={null}>
        <Bounds fit clip observe margin={1.15}>
          <Center>
            <ModelObject url={url} />
          </Center>
        </Bounds>
      </Suspense>
      {controls && (
        <OrbitControls makeDefault enablePan enableZoom autoRotate={autoRotate} autoRotateSpeed={1.0} />
      )}
    </>
  );
}

// Poster scene used only for thumbnail capture. CaptureFrames lives INSIDE the
// model's Suspense, so it only mounts (and starts counting frames) once the
// model has finished loading — otherwise it could snapshot a blank frame.
function PosterScene({ url, onCapture }) {
  return (
    <>
      <ambientLight intensity={0.55} />
      <directionalLight position={[6, 8, 6]} intensity={1.15} />
      <directionalLight position={[-6, 4, -4]} intensity={0.35} />
      <ModelErrorBoundaryEnv>
        <Environment files={HDR_URL} />
      </ModelErrorBoundaryEnv>
      <Suspense fallback={null}>
        <Bounds fit clip observe margin={1.15}>
          <Center>
            <ModelObject url={url} />
          </Center>
        </Bounds>
        <CaptureFrames onCapture={onCapture} />
      </Suspense>
    </>
  );
}

// Same idea as MockupScene's EnvironmentBoundary: a missing/failed HDR must not
// take down the canvas — lighting just falls back to the lights above.
function ModelErrorBoundaryEnv({ children }) {
  return (
    <ModelErrorBoundary fallback={null}>
      <Suspense fallback={null}>{children}</Suspense>
    </ModelErrorBoundary>
  );
}

// Renders a few frames (so Bounds framing + env settle) then captures the
// canvas to a PNG data URL and reports it up exactly once.
function CaptureFrames({ onCapture }) {
  const { gl, scene, camera } = useThree();
  const frame = useRef(0);
  const done = useRef(false);
  useFrame(() => {
    if (done.current) return;
    frame.current += 1;
    if (frame.current < 6) return;
    done.current = true;
    try {
      gl.render(scene, camera);
      onCapture(gl.domElement.toDataURL("image/png"));
    } catch {
      onCapture(null);
    }
  });
  return null;
}

export function Model3DThumbnail({ url, title }) {
  const ext = getModelExt(url);
  const [poster, setPoster] = useState(() => {
    const cached = url ? posterCache.get(url) : null;
    return cached && cached !== "failed" ? cached : null;
  });
  const [failed, setFailed] = useState(() => (url ? posterCache.get(url) === "failed" : false));
  const [capturing, setCapturing] = useState(false);
  const hasSlot = useRef(false);

  useEffect(() => {
    // Already resolved (the useState initializers above read the cache on mount;
    // url is stable per canvas element) — nothing to schedule.
    if (!url || poster || failed || posterCache.has(url)) return undefined;
    let cancelled = false;
    // setCapturing runs in a microtask after the slot frees, not synchronously
    // in the effect body, so it doesn't trigger a cascading render.
    acquireCaptureSlot().then(() => {
      if (cancelled) {
        releaseCaptureSlot();
        return;
      }
      hasSlot.current = true;
      setCapturing(true);
    });
    return () => {
      cancelled = true;
      if (hasSlot.current) {
        hasSlot.current = false;
        releaseCaptureSlot();
      }
    };
  }, [url, poster, failed]);

  const handleCaptured = useCallback(
    (dataUrl) => {
      if (dataUrl) {
        posterCache.set(url, dataUrl);
        setPoster(dataUrl);
      } else {
        posterCache.set(url, "failed");
        setFailed(true);
      }
      setCapturing(false);
      if (hasSlot.current) {
        hasSlot.current = false;
        releaseCaptureSlot();
      }
    },
    [url]
  );

  if (poster) {
    return <img className="element-3d-poster" src={poster} alt={title || "3D model preview"} draggable={false} />;
  }

  return (
    <div className="element-3d-thumb">
      <FallbackCard title={title} ext={ext} failed={failed} />
      {capturing && !failed && (
        <div className="element-3d-capture" aria-hidden="true">
          <Canvas
            frameloop="always"
            dpr={1}
            gl={{ antialias: true, preserveDrawingBuffer: true, alpha: true }}
            camera={{ position: [0, 0, 3], fov: 45 }}
            onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}
          >
            <ModelErrorBoundary key={url} onError={() => handleCaptured(null)} fallback={null}>
              <PosterScene url={url} onCapture={handleCaptured} />
            </ModelErrorBoundary>
          </Canvas>
        </div>
      )}
    </div>
  );
}

// Inline interactive viewer — same orbit/zoom scene as the modal, but renders
// straight into its container (no overlay/chrome). Used by the Lightbox so a
// .glb/.gltf/.obj opens as a live 3D model instead of a broken <img>.
export function Model3DInlineViewer({ url, title, autoRotate = true }) {
  const [erroredUrl, setErroredUrl] = useState(null);
  const errored = erroredUrl === url;

  if (!url) return null;

  return (
    <div className="model3d-inline" title={title || undefined}>
      {errored ? (
        <div className="model3d-inline-error">Could not load this 3D model.</div>
      ) : (
        <Canvas dpr={[1, 2]} gl={{ antialias: true }} camera={{ position: [0, 0, 3.2], fov: 45 }}>
          <ModelErrorBoundary key={url} onError={() => setErroredUrl(url)} fallback={null}>
            <ModelStage url={url} controls autoRotate={autoRotate} />
          </ModelErrorBoundary>
        </Canvas>
      )}
    </div>
  );
}

export function Model3DViewerModal({ open, url, title, onClose }) {
  // Track which url errored rather than a boolean, so a new url is automatically
  // "not errored" without a state-resetting effect.
  const [erroredUrl, setErroredUrl] = useState(null);
  const errored = erroredUrl === url;

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !url) return null;

  return (
    <div className="model3d-modal-overlay" onClick={onClose}>
      <div className="model3d-modal" onClick={(event) => event.stopPropagation()}>
        <div className="model3d-modal-header">
          <span className="model3d-modal-title">{title || "3D Model"}</span>
          <button type="button" className="model3d-modal-close" onClick={onClose} title="Close (Esc)">
            <X size={18} />
          </button>
        </div>
        <div className="model3d-modal-body">
          {errored ? (
            <div className="model3d-modal-error">Could not load this 3D model.</div>
          ) : (
            <Canvas dpr={[1, 2]} gl={{ antialias: true }} camera={{ position: [0, 0, 3.2], fov: 45 }}>
              <ModelErrorBoundary key={url} onError={() => setErroredUrl(url)} fallback={null}>
                <ModelStage url={url} controls autoRotate />
              </ModelErrorBoundary>
            </Canvas>
          )}
        </div>
        <div className="model3d-modal-hint">Drag to orbit · Scroll to zoom · Right-drag to pan</div>
      </div>
    </div>
  );
}
