export function chooseCount(total: number, count: number): number {
  if (count < 0 || count > total) return 0;
  const effective = Math.min(count, total - count);
  let result = 1;
  for (let index = 1; index <= effective; index += 1) {
    result = result * (total - effective + index) / index;
  }
  return Math.round(result);
}

export function stringSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

export function exactRunouts<T>(items: readonly T[], count: number, visit: (items: T[]) => void): void {
  const current: T[] = [];
  const walk = (start: number) => {
    if (current.length === count) {
      visit([...current]);
      return;
    }
    const needed = count - current.length;
    for (let index = start; index <= items.length - needed; index += 1) {
      current.push(items[index]!);
      walk(index + 1);
      current.pop();
    }
  };
  walk(0);
}

export function sampledRunouts<T>(
  items: readonly T[],
  count: number,
  samples: number,
  seed: number,
  visit: (items: T[]) => void,
): void {
  const random = mulberry32(seed);
  for (let sample = 0; sample < samples; sample += 1) {
    const shuffled = [...items];
    for (let index = 0; index < count; index += 1) {
      const target = index + Math.floor(random() * (shuffled.length - index));
      [shuffled[index], shuffled[target]] = [shuffled[target]!, shuffled[index]!];
    }
    visit(shuffled.slice(0, count));
  }
}
