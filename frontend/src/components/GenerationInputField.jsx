import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import GenerationInputPopover from "./GenerationInputPopover";
import { Model3DThumbnail } from "./Model3DViewerLazy";
import AudioPlayButton from "./AudioPlayButton";

const MEDIA_BASE = "";

// A field the provider publishes with no default of its own has nothing to
// preselect, and a controlled <select> whose value matches none of its options
// renders BLANK — so every one of Pika's ~100 optional dropdowns (Seedream 5.0
// Pro's 1K/2K Size among them) looked like it had no options at all. Give that
// state a visible, selectable entry: choosing it sends no value, so the vendor
// applies its own documented default, exactly as an untouched field did before.
// Only offered when the field has no default and the options carry no empty
// value themselves, and it stays in the list after a pick so the vendor default
// is reachable again.
export function selectOptions(field) {
  const options = field?.options || [];
  const offerVendorDefault =
    (field?.default ?? null) === null && !options.some((opt) => String(opt) === "");
  return [
    ...(offerVendorDefault ? [{ value: "", label: "Default" }] : []),
    ...options.map((opt) => ({ value: opt, label: String(opt) })),
  ];
}

// Single image/video input with popover, clear button, and preview
// `fallbackUrl`: a picture the empty slot shows instead of its icon — e.g. the After
// Effects layer's own footage, which a replacement would override (no clear button).
export function MediaInput({ fieldType, value, onChange, elements, unsortedItems, onRemove, popoverPlacement = "top", compact = false, onRecorded, uploadBoardId = null, multiUpload = false, triggerLabel = null, onSelectMany = null, fallbackUrl = null }) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const triggerRef = useRef(null);
  const [popoverPos, setPopoverPos] = useState(null);

  const [resolvedPlacement, setResolvedPlacement] = useState(popoverPlacement);

  useEffect(() => {
    if (popoverOpen && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPopoverPos({ top: rect.top, left: rect.left, width: rect.width, height: rect.height });

      // Auto-flip vertical placement based on available space
      const preferTop = popoverPlacement.startsWith("top");
      const spaceAbove = rect.top;
      const spaceBelow = window.innerHeight - rect.bottom;
      const popoverHeight = 260; // approximate popover height
      let vertical = preferTop ? "top" : "bottom";
      if (preferTop && spaceAbove < popoverHeight && spaceBelow > spaceAbove) {
        vertical = "bottom";
      } else if (!preferTop && spaceBelow < popoverHeight && spaceAbove > spaceBelow) {
        vertical = "top";
      }
      /*
       * HORIZONTAL FLIP — the vertical one above already existed; this side did
       * not, and the popover simply left the screen.
       *
       * "-left" anchors the popover's RIGHT edge to the trigger's right edge and
       * extends LEFTWARD (see the transform below). That is right for a panel on
       * the RIGHT of the window and wrong for the same panel docked LEFT, where
       * there is nothing to extend into — which is exactly what the project
       * settings do: the identical component mounts in the right inspector and
       * in the left rail. So the caller cannot know the correct placement, and
       * it has to be decided here, from the trigger's actual position.
       */
      let suffix = popoverPlacement.includes("-left") ? "-left" : "";
      const POPOVER_WIDTH = 335;   // .generation-popover-portal: min(335px, 100vw - 80px)
      const MARGIN = 8;
      if (suffix === "-left" && rect.right - POPOVER_WIDTH < MARGIN) {
        suffix = "";               // no room leftward — extend right instead
      } else if (suffix === "" && rect.left + POPOVER_WIDTH > window.innerWidth - MARGIN) {
        suffix = "-left";          // and the mirror case, for completeness
      }
      setResolvedPlacement(vertical + suffix);
    }
  }, [popoverOpen, popoverPlacement]);

  const displayUrl = value
    ? value.startsWith("http") ? value : `${MEDIA_BASE}${value}`
    : null;
  const isVideoAsset = !!displayUrl && /\.(mp4|webm|mov|m4v|avi)(\?.*)?$/i.test(displayUrl);
  const isModelAsset = fieldType === "model" || (!!displayUrl && /\.(glb|gltf|obj)(\?.*)?$/i.test(displayUrl));
  const isAudioAsset = fieldType === "audio" || (!!displayUrl && /\.(mp3|wav|m4a|aac|ogg|flac|opus)(\?.*)?$/i.test(displayUrl));

  return (
    <div className="generation-media-input-wrapper" ref={triggerRef}>
      {triggerLabel ? (
        <button
          type="button"
          className="generation-media-trigger-btn"
          onMouseDown={(e) => { if (popoverOpen) e.stopPropagation(); }}
          onClick={() => setPopoverOpen((v) => !v)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
          <span>{triggerLabel}</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
        </button>
      ) : (
      <div
        className="generation-media-input"
        onMouseDown={(e) => { if (popoverOpen) e.stopPropagation(); }}
        onClick={() => setPopoverOpen((v) => !v)}
      >
        {displayUrl ? (
          isAudioAsset ? (
            <div className="generation-media-placeholder generation-media-audio-filled">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
              </svg>
            </div>
          ) : isModelAsset ? (
            <Model3DThumbnail url={displayUrl} title="" />
          ) : fieldType === "image" || (fieldType === "media" && !isVideoAsset) ? (
            <img src={displayUrl} alt="" draggable={false} />
          ) : (
            <video src={displayUrl} muted />
          )
        ) : fallbackUrl ? (
          <img className="generation-media-fallback" src={fallbackUrl} alt="" draggable={false} onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} />
        ) : (
          <div className="generation-media-placeholder">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              {fieldType === "audio" ? (
                <>
                  <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                </>
              ) : fieldType === "image" ? (
                <>
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <path d="M21 15l-5-5L5 21" />
                </>
              ) : fieldType === "model" ? (
                <>
                  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                  <path d="M3.27 6.96 12 12.01l8.73-5.05" />
                  <path d="M12 22.08V12" />
                </>
              ) : (
                <>
                  <rect x="2" y="4" width="20" height="16" rx="2" />
                  <polygon points="10,8 16,12 10,16" fill="currentColor" stroke="none" />
                </>
              )}
            </svg>
          </div>
        )}
        {isAudioAsset && displayUrl && <AudioPlayButton src={displayUrl} />}
      </div>
      )}
      {/* Clear / Remove button */}
      {(displayUrl || onRemove) && (
        <button
          className="generation-media-clear"
          onClick={(e) => {
            e.stopPropagation();
            if (displayUrl) onChange(null);
            else if (onRemove) onRemove();
          }}
          title={displayUrl ? "Clear" : "Remove"}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
      {popoverOpen && popoverPos && createPortal(
        <div
          className={`generation-popover-portal${compact ? " compact" : ""}`}
          style={{
            position: "fixed",
            top: resolvedPlacement.startsWith("bottom") ? popoverPos.top + popoverPos.height + 8 : popoverPos.top - 8,
            left: resolvedPlacement.endsWith("-left") ? popoverPos.left + popoverPos.width : popoverPos.left,
            transform: resolvedPlacement.startsWith("bottom")
              ? (resolvedPlacement.endsWith("-left") ? "translateX(-100%)" : "none")
              : (resolvedPlacement.endsWith("-left") ? "translate(-100%, -100%)" : "translateY(-100%)"),
            zIndex: 100001,
          }}
        >
          <GenerationInputPopover
            fieldType={fieldType}
            elements={elements}
            unsortedItems={unsortedItems}
            uploadBoardId={uploadBoardId}
            multiUpload={multiUpload}
            onSelect={(url) => { onChange(url); setPopoverOpen(false); }}
            onSelectMany={onSelectMany ? (urls) => { onSelectMany(urls); setPopoverOpen(false); } : null}
            onRecorded={onRecorded}
            onClose={() => setPopoverOpen(false)}
          />
        </div>,
        document.body
      )}
    </div>
  );
}

export default function GenerationInputField({ field, value, onChange, elements, unsortedItems, voiceButton }) {
  if (field.field_type === "image" || field.field_type === "video" || field.field_type === "media" || field.field_type === "audio") {
    return (
      <div className="generation-field generation-field-media">
        <label className="generation-label">{field.label}</label>
        <MediaInput
          fieldType={field.field_type}
          value={value}
          onChange={onChange}
          elements={elements}
          unsortedItems={unsortedItems}
        />
      </div>
    );
  }

  if (field.field_type === "range") {
    const val = value ?? field.default ?? 0;
    return (
      <div className="generation-field">
        <label className="generation-label">
          {field.label}
          <span className="generation-range-value">{val}</span>
        </label>
        <input
          type="range"
          className="generation-range-input"
          min={field.min ?? 0}
          max={field.max ?? 1}
          step={field.step ?? 0.01}
          value={val}
          onChange={(e) => onChange(parseFloat(e.target.value))}
        />
      </div>
    );
  }

  if (field.field_type === "select") {
    return (
      <div className="generation-field">
        <label className="generation-label">{field.label}</label>
        <select
          className="generation-select"
          value={value ?? field.default ?? ""}
          onChange={(e) => onChange(e.target.value)}
        >
          {selectOptions(field).map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>
    );
  }

  if (field.field_type === "number") {
    return (
      <div className="generation-field">
        <label className="generation-label">{field.label}</label>
        <input
          type="number"
          className="generation-number-input"
          value={value ?? field.default ?? ""}
          min={field.min}
          max={field.max}
          step={field.step}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          placeholder={field.placeholder}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
      </div>
    );
  }

  if (field.field_type === "textarea") {
    return (
      <div className="generation-field">
        <label className="generation-label">{field.label}</label>
        <div className="generation-textarea-wrap">
          <textarea
            className="generation-textarea"
            value={value ?? ""}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder}
            rows={3}
            autoComplete="off"
          />
          {voiceButton}
        </div>
      </div>
    );
  }

  return (
    <div className="generation-field">
      <label className="generation-label">{field.label}</label>
      <input
        type="text"
        className="generation-text-input"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        autoComplete="off"
      />
    </div>
  );
}
