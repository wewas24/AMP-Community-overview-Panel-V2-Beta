/**
 * Reduces chart history without hiding latency spikes. Each bucket keeps its
 * local minimum and maximum in chronological order, plus the first and last
 * measurement. This fits a 160 px chart far better than 300 raw points.
 */
export function downsampleMetrics(points, maximum = 120) {
  const source = Array.isArray(points) ? points : [];
  const limit = Math.max(8, Math.min(300, Number(maximum) || 120));
  if (source.length <= limit) return source;

  const innerCount = source.length - 2;
  const buckets = Math.max(1, Math.floor((limit - 2) / 2));
  const selected = [0];
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const start = 1 + Math.floor(bucket * innerCount / buckets);
    const end = Math.min(source.length - 1, 1 + Math.floor((bucket + 1) * innerCount / buckets));
    let minimum = start;
    let maximumIndex = start;
    for (let index = start + 1; index < end; index += 1) {
      const value = Number(source[index]?.latencyMs);
      const low = Number(source[minimum]?.latencyMs);
      const high = Number(source[maximumIndex]?.latencyMs);
      if (Number.isFinite(value) && (!Number.isFinite(low) || value < low)) minimum = index;
      if (Number.isFinite(value) && (!Number.isFinite(high) || value > high)) maximumIndex = index;
    }
    for (const index of [minimum, maximumIndex].sort((left, right) => left - right)) {
      if (selected.at(-1) !== index) selected.push(index);
    }
  }
  if (selected.at(-1) !== source.length - 1) selected.push(source.length - 1);
  return selected.slice(0, limit).map((index) => source[index]);
}
