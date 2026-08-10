import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { formatChips } from "./components";
import type { ArenaPlayer, StackHistoryPoint } from "./types";

const SERIES_COLORS = [
  "#e4b85f",
  "#62c8c2",
  "#f0836d",
  "#b69bef",
  "#78aaf3",
  "#9ccb70",
  "#e58fb8",
  "#e59c58",
  "#b8c4c1",
];

const chart = { width: 920, height: 390, left: 72, right: 26, top: 24, bottom: 54 };
const plotWidth = chart.width - chart.left - chart.right;
const plotHeight = chart.height - chart.top - chart.bottom;

function niceStep(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const multiplier = normalized <= 1 ? 1
    : normalized <= 2 ? 2
      : normalized <= 2.5 ? 2.5
        : normalized <= 3 ? 3
          : normalized <= 4 ? 4
            : normalized <= 5 ? 5 : 10;
  return multiplier * magnitude;
}

function axisMaximum(value: number): number {
  const step = niceStep(value / 4);
  return Math.max(step, Math.ceil(value / step) * step);
}

function axisLabel(value: number): string {
  if (value < 1_000) return String(value);
  const thousands = value / 1_000;
  return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}K`;
}

function sampledIndexes(length: number, maximum = 9): number[] {
  if (length <= maximum) return Array.from({ length }, (_, index) => index);
  const step = Math.ceil((length - 1) / (maximum - 1));
  const indexes = Array.from({ length: Math.ceil(length / step) }, (_, index) => index * step)
    .filter((index) => index < length);
  if (indexes.at(-1) !== length - 1) indexes.push(length - 1);
  return indexes;
}

export function StackHistoryChart({ players, points }: {
  players: ArenaPlayer[];
  points: StackHistoryPoint[];
}) {
  const orderedPlayers = [...players].sort((left, right) => left.seat - right.seat);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(Math.max(0, points.length - 1));
  const [focusedPlayerId, setFocusedPlayerId] = useState<string | null>(null);

  useEffect(() => setSelectedIndex(Math.max(0, points.length - 1)), [points.length]);
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    container.scrollLeft = container.scrollWidth - container.clientWidth;
  }, [points.length]);
  if (points.length === 0) return <div className="stack-history-empty">还没有可绘制的手牌结算记录。</div>;

  const maximumStack = Math.max(1, ...points.flatMap((point) => orderedPlayers.map((player) => point.stacks[player.id] ?? 0)));
  const yMaximum = axisMaximum(maximumStack);
  const yTicks = Array.from({ length: 5 }, (_, index) => index * yMaximum / 4);
  const xAt = (index: number) => chart.left + (points.length === 1 ? plotWidth / 2 : index * plotWidth / (points.length - 1));
  const yAt = (stack: number) => chart.top + plotHeight - stack / yMaximum * plotHeight;
  const selected = points[Math.min(selectedIndex, points.length - 1)]!;
  const ranking = orderedPlayers
    .map((player, index) => ({ player, color: SERIES_COLORS[index % SERIES_COLORS.length]!, stack: selected.stacks[player.id] ?? 0 }))
    .sort((left, right) => right.stack - left.stack || left.player.seat - right.player.seat);

  const selectFromPointer = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const svgX = (event.clientX - bounds.left) / bounds.width * chart.width;
    const progress = Math.min(1, Math.max(0, (svgX - chart.left) / plotWidth));
    setSelectedIndex(Math.round(progress * Math.max(0, points.length - 1)));
  };

  return (
    <div className="stack-chart-layout">
      <div className="stack-chart-main">
        <div className="stack-chart-scroll" ref={scrollRef}>
          <svg
            className="stack-chart-svg"
            viewBox={`0 0 ${chart.width} ${chart.height}`}
            role="img"
            aria-labelledby="stack-chart-title stack-chart-description"
            onPointerMove={selectFromPointer}
            onPointerDown={selectFromPointer}
          >
            <title id="stack-chart-title">各模型每手结束后的筹码走势</title>
            <desc id="stack-chart-description">横轴为手数，纵轴为筹码。右侧列表展示当前选中手牌的精确筹码。</desc>
            {yTicks.map((tick) => {
              const y = yAt(tick);
              return (
                <g className="stack-chart-grid" key={tick}>
                  <line x1={chart.left} x2={chart.width - chart.right} y1={y} y2={y} />
                  <text x={chart.left - 14} y={y + 4}>{axisLabel(tick)}</text>
                </g>
              );
            })}
            {sampledIndexes(points.length).map((index) => (
              <text className="stack-chart-x-label" x={xAt(index)} y={chart.height - 18} key={points[index]!.handNo}>
                H{points[index]!.handNo}
              </text>
            ))}
            {orderedPlayers.map((player, playerIndex) => {
              const color = SERIES_COLORS[playerIndex % SERIES_COLORS.length]!;
              const path = points.map((point, index) => `${index === 0 ? "M" : "L"} ${xAt(index)} ${yAt(point.stacks[player.id] ?? 0)}`).join(" ");
              const muted = focusedPlayerId !== null && focusedPlayerId !== player.id;
              return (
                <g className={`stack-chart-series${muted ? " is-muted" : ""}`} key={player.id}>
                  <path d={path} stroke={color} />
                  <circle cx={xAt(selectedIndex)} cy={yAt(selected.stacks[player.id] ?? 0)} r="4.5" fill={color} />
                </g>
              );
            })}
            <g className="stack-chart-cursor">
              <line x1={xAt(selectedIndex)} x2={xAt(selectedIndex)} y1={chart.top} y2={chart.top + plotHeight} />
              <rect x={xAt(selectedIndex) - 31} y={chart.top - 5} width="62" height="24" rx="3" />
              <text x={xAt(selectedIndex)} y={chart.top + 11}>第 {selected.handNo} 手</text>
            </g>
            <rect className="stack-chart-hitarea" x={chart.left} y={chart.top} width={plotWidth} height={plotHeight} />
          </svg>
        </div>
        <p className="stack-chart-hint">移动指针或横向拖动，查看每一手结算后的筹码。</p>
      </div>
      <aside className="stack-chart-inspector" aria-live="polite">
        <header><span>结算快照</span><strong>第 {selected.handNo} 手</strong></header>
        <div className="stack-chart-ranking">
          {ranking.map(({ player, color, stack }, index) => (
            <button
              type="button"
              key={player.id}
              onPointerEnter={() => setFocusedPlayerId(player.id)}
              onPointerLeave={() => setFocusedPlayerId(null)}
              onFocus={() => setFocusedPlayerId(player.id)}
              onBlur={() => setFocusedPlayerId(null)}
            >
              <i style={{ backgroundColor: color }} />
              <span><b>{index + 1}</b>{player.displayName}</span>
              <strong>{formatChips(stack)}</strong>
            </button>
          ))}
        </div>
      </aside>
      <table className="visually-hidden">
        <caption>各模型每手结束后的筹码明细</caption>
        <thead><tr><th>手数</th>{orderedPlayers.map((player) => <th key={player.id}>{player.displayName}</th>)}</tr></thead>
        <tbody>{points.map((point) => <tr key={point.handNo}><th>第 {point.handNo} 手</th>{orderedPlayers.map((player) => <td key={player.id}>{point.stacks[player.id] ?? 0}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}
