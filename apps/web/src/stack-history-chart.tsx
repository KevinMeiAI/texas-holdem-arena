import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { formatChips } from "./components";
import type { ArenaPlayer, StackHistoryPoint } from "./types";
import { useUiPreferences } from "./ui-preferences";

const SERIES_COLORS = [
  "var(--chart-series-1)",
  "var(--chart-series-2)",
  "var(--chart-series-3)",
  "var(--chart-series-4)",
  "var(--chart-series-5)",
  "var(--chart-series-6)",
  "var(--chart-series-7)",
  "var(--chart-series-8)",
  "var(--chart-series-9)",
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

interface StackChartPoint {
  key: string;
  handNo: number | null;
  stacks: Record<string, number>;
}

export function createStackHistorySeries(
  players: Pick<ArenaPlayer, "id">[],
  points: StackHistoryPoint[],
  initialStack: number,
): StackChartPoint[] {
  return [
    {
      key: "origin",
      handNo: null,
      stacks: Object.fromEntries(players.map((player) => [player.id, initialStack])),
    },
    ...points.map((point) => ({ key: `hand-${point.handNo}`, ...point })),
  ];
}

export function StackHistoryChart({ players, points, initialStack }: {
  players: ArenaPlayer[];
  points: StackHistoryPoint[];
  initialStack: number;
}) {
  const { text } = useUiPreferences();
  const orderedPlayers = [...players].sort((left, right) => left.seat - right.seat);
  const seriesPoints = createStackHistorySeries(orderedPlayers, points, initialStack);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(points.length);
  const [focusedPlayerId, setFocusedPlayerId] = useState<string | null>(null);
  const [isPointerActive, setIsPointerActive] = useState(false);

  useEffect(() => setSelectedIndex(points.length), [points.length]);
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    container.scrollLeft = container.scrollWidth - container.clientWidth;
  }, [points.length]);
  if (orderedPlayers.length === 0) return <div className="stack-history-empty">{text("还没有筹码记录。", "No stack history yet.")}</div>;

  const maximumStack = Math.max(1, ...seriesPoints.flatMap((point) => orderedPlayers.map((player) => point.stacks[player.id] ?? 0)));
  const yMaximum = axisMaximum(maximumStack);
  const yTicks = Array.from({ length: 5 }, (_, index) => index * yMaximum / 4);
  const xAt = (index: number) => chart.left + (seriesPoints.length === 1 ? 0 : index * plotWidth / (seriesPoints.length - 1));
  const yAt = (stack: number) => chart.top + plotHeight - stack / yMaximum * plotHeight;
  const selected = seriesPoints[Math.min(selectedIndex, seriesPoints.length - 1)]!;
  const selectedLabel = selected.handNo === null
    ? text("初始", "Origin")
    : text(`第 ${selected.handNo} 手`, `H${selected.handNo}`);
  const ranking = orderedPlayers
    .map((player, index) => ({ player, color: SERIES_COLORS[index % SERIES_COLORS.length]!, stack: selected.stacks[player.id] ?? 0 }))
    .sort((left, right) => right.stack - left.stack || left.player.seat - right.player.seat);
  const xLabelIndexes = [0, ...sampledIndexes(points.length, 8).map((index) => index + 1)];
  // 首个采样标签与「初始 / Origin」间距过近时省略它，避免文字重叠
  if (xLabelIndexes.length > 1 && xAt(xLabelIndexes[1]!) - xAt(0) < 44) xLabelIndexes.splice(1, 1);

  const selectFromPointer = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const svgX = (event.clientX - bounds.left) / bounds.width * chart.width;
    const progress = Math.min(1, Math.max(0, (svgX - chart.left) / plotWidth));
    setSelectedIndex(Math.round(progress * Math.max(0, seriesPoints.length - 1)));
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
            onPointerEnter={() => setIsPointerActive(true)}
            onPointerMove={selectFromPointer}
            onPointerDown={selectFromPointer}
            onPointerLeave={() => setIsPointerActive(false)}
            onPointerCancel={() => setIsPointerActive(false)}
          >
            <title id="stack-chart-title">{text("各模型从初始筹码到每手结束后的筹码走势", "Model stacks from the origin through every completed hand")}</title>
            <desc id="stack-chart-description">{text("横轴从初始筹码开始，随后为每手结束状态；纵轴为筹码。右侧列表展示当前选中节点的精确筹码。", "The x-axis starts at the initial stacks and continues through each completed hand. The list shows exact stacks for the selected point.")}</desc>
            {yTicks.map((tick) => {
              const y = yAt(tick);
              return (
                <g className="stack-chart-grid" key={tick}>
                  <line x1={chart.left} x2={chart.width - chart.right} y1={y} y2={y} />
                  <text x={chart.left - 14} y={y + 4}>{axisLabel(tick)}</text>
                </g>
              );
            })}
            {xLabelIndexes.map((index) => (
              <text className="stack-chart-x-label" x={xAt(index)} y={chart.height - 18} key={seriesPoints[index]!.key}>
                {seriesPoints[index]!.handNo === null ? text("初始", "Origin") : `H${seriesPoints[index]!.handNo}`}
              </text>
            ))}
            {orderedPlayers.map((player, playerIndex) => {
              const color = SERIES_COLORS[playerIndex % SERIES_COLORS.length]!;
              const path = seriesPoints.map((point, index) => `${index === 0 ? "M" : "L"} ${xAt(index)} ${yAt(point.stacks[player.id] ?? 0)}`).join(" ");
              const muted = focusedPlayerId !== null && focusedPlayerId !== player.id;
              return (
                <g className={`stack-chart-series${muted ? " is-muted" : ""}`} key={player.id}>
                  <path d={path} stroke={color} />
                  {isPointerActive && (
                    <circle cx={xAt(selectedIndex)} cy={yAt(selected.stacks[player.id] ?? 0)} r="4.5" fill={color} />
                  )}
                </g>
              );
            })}
            {isPointerActive && (
              <g className="stack-chart-cursor">
                <line x1={xAt(selectedIndex)} x2={xAt(selectedIndex)} y1={chart.top} y2={chart.top + plotHeight} />
                <rect x={xAt(selectedIndex) - 31} y={chart.top - 5} width="62" height="24" rx="3" />
                <text x={xAt(selectedIndex)} y={chart.top + 11}>{selectedLabel}</text>
              </g>
            )}
            <rect className="stack-chart-hitarea" x={chart.left} y={chart.top} width={plotWidth} height={plotHeight} />
          </svg>
        </div>
      </div>
      <aside className="stack-chart-inspector" aria-live="polite">
        <header><span>{text("筹码快照", "Snapshot")}</span><strong>{selectedLabel}</strong></header>
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
        <caption>{text("各模型从初始筹码到每手结束后的筹码明细", "Model stacks from the origin through every completed hand")}</caption>
        <thead><tr><th>{text("节点", "Point")}</th>{orderedPlayers.map((player) => <th key={player.id}>{player.displayName}</th>)}</tr></thead>
        <tbody>{seriesPoints.map((point) => <tr key={point.key}><th>{point.handNo === null ? text("初始", "Origin") : text(`第 ${point.handNo} 手`, `H${point.handNo}`)}</th>{orderedPlayers.map((player) => <td key={player.id}>{point.stacks[player.id] ?? 0}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}
