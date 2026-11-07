// Shared constants + helpers for Pipeline frames (visual agent workflows).
//
// A Pipeline is a regular `frame` element with data.pipeline === true. Inside it
// live "node frames" (also frames) tagged with data.frameRole, laid out LEFT→RIGHT:
//   - "starter"     → "Starter Instructions" (optional, max 1) — only an Out port
//   - "step"        → a Step frame (status light), holds two locked child frames
//   - "instruction" → top child of a step (the task)
//   - "results"     → bottom child of a step (where the agent writes output)
//   - "final"       → "Final Results" (optional, max 1) — only an In port
// Pipeline structure is tracked by explicit links (NOT geometry):
//   - every node frame carries data.pipelineId = <container frame id>
//   - step children carry data.parentStepId = <step frame id>
// Connections reuse arrows with from_port/to_port ("in" = left edge, "out" = right edge).
//
// A step (or the starter) can be SIMPLE: data.stepVariant === "simple". It is one frame
// holding its note (data.parentStepId = the node) plus whatever the step produced,
// laid out freely: no panes, no dividers, no auto-fit. The default step since 13.3.37
// ("Step" in Add Node Frame); the three-pane step is the "Advanced Step Frame".

export const PIPELINE_STATUS = {
  WAITING: "waiting",
  IN_PROGRESS: "in_progress",
  // a step whose worker waits on someone (an Agent Boss's agent team)
  NEEDS: "needs",
  FINISHED: "finished",
  ERROR: "error",
};

export const PIPELINE_ROLE = {
  STARTER: "starter",
  STEP: "step",
  INSTRUCTION: "instruction",
  ASSETS: "assets",
  RESULTS: "results",
  FINAL: "final",
  CUSTOM: "frame", // a plain "Empty Frame" node (In + Out ports, no panes)
};

// The step variants: "simple" (one frame + a note), "compare" (a Compare step) or the default three-pane step.
export const STEP_VARIANT = { SIMPLE: "simple", COMPARE: "compare" };

// A simple step/starter: no panes; its contents move with it.
export function isSimpleNode(el) {
  return el?.type === "frame" && el?.data?.stepVariant === STEP_VARIANT.SIMPLE;
}

// A Compare step: no panes and no note. It ranks what the steps wired into it made, for the Starter's brief
// (backend/compare.py), and draws the ranking it keeps in data.compareResult.
export function isCompareStep(el) {
  return el?.type === "frame" && el?.data?.frameRole === PIPELINE_ROLE.STEP && el?.data?.stepVariant === STEP_VARIANT.COMPARE;
}

// The panes a node frame ELEMENT splits into: none for a simple node or a Compare step.
export function paneRolesOf(el) {
  if (!el || isSimpleNode(el) || isCompareStep(el)) return [];
  return nodePaneRoles(el.data?.frameRole);
}

// A step's three stacked panes, in order.
export const STEP_PANE_ROLES = ["instruction", "assets", "results"];

// The synced, stacked panes a node frame splits into (top→bottom), by role:
//   - "step"    → Instruction / Assets / Results (3 panes)
//   - "starter" → Instructions / Assets (2 panes)
// Any other role (final, container) has no panes.
export function nodePaneRoles(role) {
  if (role === "step") return ["instruction", "assets", "results"];
  if (role === "starter") return ["instruction", "assets"];
  return [];
}

// Friendly labels for pane frames (used when a node's panes are created).
export const PANE_LABELS = { instruction: "Instructions", assets: "Assets", results: "Results" };

export const STATUS_LABELS = {
  waiting: "Waiting",
  in_progress: "In Progress",
  needs: "Needs you",
  finished: "Finished",
  error: "Error",
};

export const STATUS_COLORS = {
  waiting: "#3b82f6",
  in_progress: "#eab308",
  needs: "#f97316",
  finished: "#22c55e",
  error: "#ef4444",
};

// Default geometry (canvas units).
export const STEP_SIDE_PAD = 22; // horizontal inset of panes inside a step
export const STEP_LABEL_SPACE = 34; // top room inside a step for the Instruction label
export const STEP_LABEL_GAP = 30; // gap between panes (room for the Results label)
export const STEP_BOTTOM_PAD = 20;
export const STEP_DEFAULT_SPLIT = 0.5;
export const NODE_GAP = 56; // horizontal gap between node frames (left→right)
export const PIPELINE_PAD = 28; // padding between container edge and node frames
export const HEADER_SPACE = 40; // room reserved for a frame's title chrome inside a container

// Default sizes when a node frame is first created. Nodes sit side by side, so
// they're tall (to hold a step's three stacked panes) and a fixed column width.
export const NODE_DEFAULT_SIZE = {
  starter: { width: 460, height: 620 },
  step: { width: 460, height: 860 },
  final: { width: 460, height: 560 },
  simpleStep: { width: 520, height: 560 },
};

const PANE_MIN_FRAC = 0.12;

// Normalize N pane fractions so they're each at least PANE_MIN_FRAC and sum to 1.
export function clampSplitsN(arr, n) {
  if (!Number.isInteger(n) || n < 1) return [];
  const raw = Array.isArray(arr) && arr.length === n
    ? arr.map((v) => (Number.isFinite(v) && v >= 0 ? v : 0))
    : Array.from({ length: n }, () => 1);
  let rawTotal = raw.reduce((a, b) => a + b, 0);
  if (rawTotal <= 0) {
    raw.fill(1);
    rawTotal = n;
  }

  // Project the normalized values onto a simplex with a real lower bound.
  // Clamping every value and then normalizing again made the clamped pane fall
  // below the minimum; treating a negative dragged value as 1/n made a divider
  // jump back toward the middle as soon as the pointer crossed the edge.
  const normalized = raw.map((v) => v / rawTotal);
  const min = Math.min(PANE_MIN_FRAC, 1 / n);
  const result = Array(n).fill(0);
  let remaining = Array.from({ length: n }, (_, i) => i);
  let remainingMass = 1;

  while (remaining.length) {
    const weight = remaining.reduce((sum, i) => sum + normalized[i], 0);
    const underMin = remaining.filter((i) => (
      weight > 0 ? remainingMass * normalized[i] / weight : remainingMass / remaining.length
    ) < min);
    if (!underMin.length) {
      remaining.forEach((i) => {
        result[i] = weight > 0
          ? remainingMass * normalized[i] / weight
          : remainingMass / remaining.length;
      });
      break;
    }
    const underMinSet = new Set(underMin);
    underMin.forEach((i) => { result[i] = min; });
    remainingMass -= min * underMin.length;
    remaining = remaining.filter((i) => !underMinSet.has(i));
  }
  return result;
}

// Move one divider while preserving the combined size of its two adjacent
// panes. The other pane fractions do not drift, and dragging beyond either
// minimum stays pinned there instead of wrapping back toward an equal split.
export function resizeAdjacentPaneSplits(arr, n, dividerIndex, delta) {
  const splits = clampSplitsN(arr, n);
  if (dividerIndex < 0 || dividerIndex >= n - 1 || !Number.isFinite(delta)) return splits;
  const pairTotal = splits[dividerIndex] + splits[dividerIndex + 1];
  const min = Math.min(PANE_MIN_FRAC, pairTotal / 2);
  const first = Math.max(min, Math.min(pairTotal - min, splits[dividerIndex] + delta));
  const next = splits.slice();
  next[dividerIndex] = first;
  next[dividerIndex + 1] = pairTotal - first;
  return next;
}

// Back-compat: a step's three fractions ([instruction, assets, results]).
export function clampSplits(arr) {
  return clampSplitsN(arr, 3);
}

// Absolute geometry of a split node's stacked locked panes + the divider lines,
// derived purely from the node element. Used identically by the canvas reflow and
// the divider handles so they never disagree. Works for steps (3 panes) and the
// starter (2 panes); returns null for nodes that don't split.
export function computeNodePaneLayout(node) {
  const roles = paneRolesOf(node);
  const n = roles.length;
  if (!n) return null;
  const innerX = node.x + STEP_SIDE_PAD;
  const innerW = Math.max(120, node.width - STEP_SIDE_PAD * 2);
  const top = node.y + STEP_LABEL_SPACE;
  // N panes => N-1 inter-pane gaps (room for the lower panes' labels).
  const avail = Math.max(120, node.height - STEP_LABEL_SPACE - STEP_LABEL_GAP * (n - 1) - STEP_BOTTOM_PAD);
  const splits = clampSplitsN(node.data && node.data.paneSplits, n);
  const heights = [];
  let used = 0;
  for (let i = 0; i < n; i++) {
    const h = i < n - 1 ? Math.max(36, Math.round(avail * splits[i])) : Math.max(36, avail - used);
    heights.push(h);
    used += h;
  }
  const out = { dividers: [], avail, roles };
  let y = top;
  roles.forEach((role, i) => {
    out[role] = { x: innerX, y, width: innerW, height: heights[i] };
    if (i < n - 1) out.dividers.push(y + heights[i] + STEP_LABEL_GAP / 2);
    y += heights[i] + STEP_LABEL_GAP;
  });
  return out;
}

// Resize a split node so one pane reaches an Autolayout-derived size while every
// sibling keeps its current pixel height. The node grows/shrinks by only the
// selected pane's delta, and new split fractions persist those resulting sizes.
// Consequently, panes after the selected one move with its bottom edge instead
// of copying its size.
export function resizeNodeToFitPane(node, paneRole, targetSize = {}) {
  const currentLayout = computeNodePaneLayout(node);
  const currentPane = currentLayout?.[paneRole];
  if (!currentLayout || !currentPane) return null;

  const targetWidth = Number(targetSize.width);
  const targetHeight = Number(targetSize.height);
  const nextNode = { ...node };

  if (Number.isFinite(targetWidth) && targetWidth > 0) {
    const widthDelta = Math.max(120, targetWidth) - currentPane.width;
    nextNode.width = Math.max(STEP_SIDE_PAD * 2 + 120, Math.round(node.width + widthDelta));
  }

  if (Number.isFinite(targetHeight) && targetHeight > 0) {
    const fixedHeight = node.height - currentLayout.avail;
    const heights = currentLayout.roles.map((role) => (
      role === paneRole
        ? Math.max(36, Math.round(targetHeight))
        : currentLayout[role].height
    ));
    const nextAvail = heights.reduce((sum, height) => sum + height, 0);
    nextNode.height = fixedHeight + nextAvail;
    nextNode.data = {
      ...(node.data || {}),
      paneSplits: heights.map((height) => height / nextAvail),
    };
  }

  return { node: nextNode, layout: computeNodePaneLayout(nextNode) };
}

// Back-compat alias used throughout the step code paths.
export function computeStepPaneLayout(step) {
  return computeNodePaneLayout(step) || { instruction: null, assets: null, results: null, dividers: [], avail: 150, roles: [] };
}

// Does this node frame split into synced, divider-resized panes (step or starter)?
export function isSplitNode(el) {
  return paneRolesOf(el).length > 0;
}

export function isPipelineFrame(el) {
  return el?.type === "frame" && !!(el.data && el.data.pipeline);
}

export function frameRole(el) {
  return (el?.type === "frame" && el.data && el.data.frameRole) || null;
}

export function isNodeFrame(el) {
  return !!frameRole(el);
}

export function isStepFrame(el) {
  return frameRole(el) === PIPELINE_ROLE.STEP;
}

// A step's locked panes can't be freely moved/resized; only the dividers edit them.
// An AI Social frame's managed parts are locked the same way (the backend lays them out).
export function isLockedPane(el) {
  return STEP_PANE_ROLES.includes(frameRole(el)) || isSocialPart(el);
}

// --- AI Social (trend research) ---------------------------------------------
// A Trends frame (data.managedBy "social", data.social.kind "trends") is laid out
// by the backend. Its headline, summary, section frames, chips and captions are
// managed parts (data.social = { part, frame }): locked, and deleted only together
// with their frame. Its trend cards (data.social.kind "trend") are ordinary cards
// the layout places; a drag or a delete on one asks the backend instead.
export const SOCIAL_TRENDS_LOOKS = [
  { id: "feed", label: "Feed" },
  { id: "table", label: "Table" },
  { id: "swipe", label: "Swipe file" },
  { id: "standouts", label: "Standouts" },
];

// The look a Trends frame draws: a current one as is; the looks before 15.0.x (editorial / ledger / cards, still in
// older frames and workflow briefs) and none at all are Feed, as backend/social_layout.py normalize_look does.
export function socialTrendsLook(look) {
  return SOCIAL_TRENDS_LOOKS.some((l) => l.id === look) ? look : "feed";
}

export function isSocialPart(el) {
  return el?.data?.managedBy === "social" && !!el.data.social?.part;
}

export function isSocialTrendsFrame(el) {
  return el?.type === "frame" && el.data?.managedBy === "social" && el.data.social?.kind === "trends";
}

export function isSocialTrendCard(el) {
  return el?.data?.social?.kind === "trend" && !!el.data.social.frame;
}

// --- AI Social (posting) ------------------------------------------------------
// Posts live in Pulse. A Posts frame (data.social.kind "posts"), its managed parts and its post cards (data.social.kind
// "post") stay in the board's data, so the API, export, duplicate and archive keep them, and no board shows them.
export function isSocialPostsFrame(el) {
  return el?.type === "frame" && el.data?.managedBy === "social" && el.data.social?.kind === "posts";
}

export function isSocialPostCard(el) {
  return el?.data?.social?.kind === "post" && !!el.data.social.frame;
}

/** One card from the change feed, with no board around it to look its frame up in. */
export function isPostsElement(el) {
  return isSocialPostsFrame(el) || isSocialPostCard(el) || (isSocialPart(el) && el.data.social.of === "posts");
}

/** What a board shows: every card but the Posts frames, their parts and their post cards. A post card whose frame is gone is
 *  a plain card again: Pulse doesn't list it, so hiding it would lose it. */
export function boardVisible(els) {
  if (!Array.isArray(els)) return els;
  const frames = new Set(els.filter(isSocialPostsFrame).map((el) => el.id));
  if (!frames.size) return els;
  return els.filter((el) => !frames.has(el.id) && !((isSocialPostCard(el) || isSocialPart(el)) && frames.has(el.data.social.frame)));
}

const POST_HOLD_MIN = 10;
// A post's status as it reads now (backend social_posts_layout.status_now): a post
// waiting for an OK past its slot is missed; a Full auto post inside its 10-minute
// hold shows "Posts soon"; a scheduled post more than the hold late was missed.
export function postStatusNow(rec, account, now = Date.now()) {
  const st = rec?.status || "draft";
  if (st === "posted" || st === "failed" || st === "posting" || st === "yours") return st;
  const at = rec?.slot_at ? new Date(String(rec.slot_at).slice(0, 16)).getTime() : NaN;
  if (!Number.isFinite(at) || st === "draft") return "draft";
  // Post it myself (social_posts_layout.status_now): its time never passes into Missed, it is the user's turn
  if (account?.provider === "manual" && (st === "scheduled" || st === "needs")) return at <= now ? "yours" : "scheduled";
  if (st === "needs") return at <= now ? "missed" : "needs";
  if (st === "scheduled") {
    if (at <= now - POST_HOLD_MIN * 60000) return "missed";
    if (at > now && account?.approval === "auto" && at - now <= POST_HOLD_MIN * 60000) return "hold";
  }
  return st;
}

// What deleting `ids` really does once the AI Social rules apply:
//  - a managed part goes only with its Trends frame (or once that frame is gone, so a leftover part can never become
//    undeletable);
//  - a Trends frame takes its parts with it but leaves its cards;
//  - a trend card whose frame stays is hidden ("not interested") instead.
// Returns { deleteIds, hide: [{ frameId, cardId }] }, in the order of `ids`; ids not on the board drop out. With no social
// element among `ids` it is one pass over the board.
export function planSocialDelete(ids, elements) {
  const idSet = new Set(ids);
  const byId = new Map();
  for (const el of elements) if (idSet.has(el.id)) byId.set(el.id, el);
  const picked = [...idSet].filter((id) => byId.has(id)).map((id) => byId.get(id));
  if (!picked.some((el) => el.data?.social)) return { deleteIds: picked.map((el) => el.id), hide: [] };
  const onBoard = new Set(elements.filter(isSocialTrendsFrame).map((el) => el.id));
  const going = new Set(picked.filter(isSocialTrendsFrame).map((el) => el.id));
  const deleteIds = [];
  const hide = [];
  for (const el of picked) {
    const frameId = el.data?.social?.frame;
    if (isSocialPart(el)) {
      if (going.has(frameId) || !onBoard.has(frameId)) deleteIds.push(el.id);
    } else if (isSocialTrendCard(el) && onBoard.has(frameId)) {
      if (!going.has(frameId)) hide.push({ frameId, cardId: el.id });
    } else {
      deleteIds.push(el.id);
    }
  }
  if (going.size) {
    for (const el of elements) {
      if (!idSet.has(el.id) && isSocialPart(el) && going.has(el.data.social.frame)) deleteIds.push(el.id);
    }
  }
  return { deleteIds, hide };
}

// A trend card released at `end` (its new top-left) without its frame moving:
// { frameId, inside } — inside when its centre is still within `frame` — or null
// when `frame` isn't this card's Trends frame (an orphan drags like any card).
export function socialTrendDrop(card, end, frame) {
  if (!isSocialTrendCard(card) || !isSocialTrendsFrame(frame) || frame.id !== card.data.social.frame) return null;
  const cx = end.x + (card.width || 0) / 2;
  const cy = end.y + (card.height || 0) / 2;
  const inside = cx >= frame.x && cx <= frame.x + frame.width && cy >= frame.y && cy <= frame.y + frame.height;
  return { frameId: frame.id, inside };
}

export function pipelineStatus(el) {
  return (el?.data && el.data.pipelineStatus) || PIPELINE_STATUS.WAITING;
}

// Has a visible status light: the container itself and each step frame.
export function hasStatusLight(el) {
  return isPipelineFrame(el) || isStepFrame(el);
}

// Connection ports allowed for a given node role.
export function portsForRole(role) {
  switch (role) {
    case PIPELINE_ROLE.STARTER:
      return { in: false, out: true };
    case PIPELINE_ROLE.FINAL:
      return { in: true, out: false };
    case PIPELINE_ROLE.STEP:
      return { in: true, out: true };
    case PIPELINE_ROLE.CUSTOM:
      return { in: true, out: true }; // a plain "Empty Frame" node — wire it freely
    default:
      return { in: false, out: false };
  }
}

// Absolute coords of a node's connection port. "in" = left-center, "out" = right-center
// (nodes flow left→right, so connections run rightward).
export function portPosition(el, port) {
  if (!el) return null;
  const cy = el.y + el.height / 2;
  if (port === "in") return { x: el.x, y: cy };
  if (port === "out") return { x: el.x + el.width, y: cy };
  return { x: el.x + el.width / 2, y: cy };
}

// All node frames that belong to a pipeline container (by explicit link).
export function pipelineMembers(containerId, elements) {
  return elements.filter((e) => e?.data?.pipelineId === containerId);
}

// The three locked panes of a step frame (Instruction, Assets, Results).
export function stepPanes(stepId, elements) {
  const panes = elements.filter((e) => e?.data?.parentStepId === stepId);
  const instruction = panes.find((p) => frameRole(p) === PIPELINE_ROLE.INSTRUCTION) || null;
  const assets = panes.find((p) => frameRole(p) === PIPELINE_ROLE.ASSETS) || null;
  const results = panes.find((p) => frameRole(p) === PIPELINE_ROLE.RESULTS) || null;
  return { instruction, assets, results };
}
