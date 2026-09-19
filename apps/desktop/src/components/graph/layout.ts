/**
 * A small, deterministic force layout for the knowledge graph: no dependency,
 * no animation. Pages repel each other, facts cling to the page they feed,
 * people sit between the pages they contribute to. Same input, same picture.
 */
import type { KnowledgeGraph, KnowledgeNode } from '../../api/types';

export interface Placed extends KnowledgeNode {
  x: number;
  y: number;
}

/** A stable pseudo-random number in [0, 1) from a string. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

const REST: Record<string, number> = { feeds: 34, contributes: 150, relates: 190 };
const PULL: Record<string, number> = { feeds: 0.2, contributes: 0.02, relates: 0.035 };

export function layout(graph: KnowledgeGraph, width: number, height: number, iterations = 320): Placed[] {
  const pages = graph.nodes.filter((n) => n.type === 'page');
  const people = graph.nodes.filter((n) => n.type === 'person');
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.min(width, height) * 0.32;

  const at = new Map<string, { x: number; y: number; vx: number; vy: number }>();
  pages.forEach((n, i) => {
    const a = (i / Math.max(1, pages.length)) * Math.PI * 2;
    at.set(n.id, { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r * (height / width), vx: 0, vy: 0 });
  });
  people.forEach((n, i) => {
    const a = ((i + 0.5) / Math.max(1, people.length)) * Math.PI * 2;
    at.set(n.id, { x: cx + Math.cos(a) * r * 0.45, y: cy + Math.sin(a) * r * 0.4, vx: 0, vy: 0 });
  });
  for (const n of graph.nodes) {
    if (at.has(n.id)) continue;
    const home = n.pageId ? at.get(n.pageId) : undefined;
    const a = hash(n.id) * Math.PI * 2;
    const d = 30 + hash(`${n.id}:d`) * 30;
    at.set(n.id, { x: (home?.x ?? cx) + Math.cos(a) * d, y: (home?.y ?? cy) + Math.sin(a) * d, vx: 0, vy: 0 });
  }

  const nodes = graph.nodes.map((n) => ({ n, p: at.get(n.id)! }));
  const edges = graph.edges.map((e) => ({ e, a: at.get(e.from), b: at.get(e.to) })).filter((x) => x.a && x.b) as { e: KnowledgeGraph['edges'][number]; a: { x: number; y: number; vx: number; vy: number }; b: { x: number; y: number; vx: number; vy: number } }[];
  const charge = (n: KnowledgeNode) => (n.type === 'page' ? 6400 : n.type === 'person' ? 2600 : 170);

  for (let it = 0; it < iterations; it += 1) {
    const cool = 1 - it / iterations;
    for (let i = 0; i < nodes.length; i += 1) {
      const A = nodes[i]!;
      for (let j = i + 1; j < nodes.length; j += 1) {
        const B = nodes[j]!;
        let dx = A.p.x - B.p.x;
        let dy = A.p.y - B.p.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          dx = hash(A.n.id + B.n.id) - 0.5;
          dy = hash(B.n.id + A.n.id) - 0.5;
          d2 = dx * dx + dy * dy;
        }
        if (d2 > 90000) continue;
        const f = Math.sqrt(charge(A.n) * charge(B.n)) / d2;
        const d = Math.sqrt(d2);
        A.p.vx += (dx / d) * f;
        A.p.vy += (dy / d) * f;
        B.p.vx -= (dx / d) * f;
        B.p.vy -= (dy / d) * f;
      }
    }
    for (const { e, a, b } of edges) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - REST[e.type]!) * PULL[e.type]!;
      a.vx += (dx / d) * f;
      a.vy += (dy / d) * f;
      b.vx -= (dx / d) * f;
      b.vy -= (dy / d) * f;
    }
    for (const { p } of nodes) {
      p.vx += (cx - p.x) * 0.007 * Math.min(1.5, height / width);
      p.vy += (cy - p.y) * 0.007 * Math.min(1.5, width / height);
      const step = Math.min(18 * cool + 1, Math.hypot(p.vx, p.vy));
      const len = Math.hypot(p.vx, p.vy) || 1;
      p.x += (p.vx / len) * step;
      p.y += (p.vy / len) * step;
      p.vx *= 0.5;
      p.vy *= 0.5;
    }
  }

  // Stretch positions (not shapes) to fill the box, leaving room for labels.
  const xs = nodes.map(({ p }) => p.x);
  const ys = nodes.map(({ p }) => p.y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const mx = 90;
  const my = 36;
  const sx = (width - mx * 2) / Math.max(1, maxX - minX);
  const sy = (height - my * 2) / Math.max(1, maxY - minY);
  const placed = nodes.map(({ n, p }) => ({ ...n, x: mx + (p.x - minX) * sx, y: my + (p.y - minY) * sy }));

  // Labelled nodes must not sit on each other: nudge overlapping boxes apart, inside the frame.
  const half = (n: Placed) => (n.type === 'page' ? { w: 80, h: 20 } : { w: 34, h: 16 });
  const boxes = placed.filter((n) => n.type !== 'fact');
  for (let pass = 0; pass < 40; pass += 1) {
    let moved = false;
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const A = boxes[i]!;
        const B = boxes[j]!;
        const [ha, hb] = [half(A), half(B)];
        const ox = ha.w + hb.w - Math.abs(A.x - B.x);
        const oy = ha.h + hb.h - Math.abs(A.y - B.y);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        if (oy < ox) {
          const d = (oy / 2 + 1) * (A.y <= B.y ? 1 : -1);
          A.y -= d;
          B.y += d;
        } else {
          const d = (ox / 2 + 1) * (A.x <= B.x ? 1 : -1);
          A.x -= d;
          B.x += d;
        }
      }
    }
    for (const b of boxes) {
      const h = half(b);
      b.x = Math.min(width - h.w - 4, Math.max(h.w + 4, b.x));
      b.y = Math.min(height - h.h - 4, Math.max(h.h + 4, b.y));
    }
    if (!moved) break;
  }
  return placed;
}
