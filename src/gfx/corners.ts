import type { Course } from '../game/course';

/**
 * 「这一行算不算在弯里」—— 路肩红白条和刹车距离牌共用的一个判断。
 *
 * 门槛 0.005(半径 200 米)。原先按真实赛道的直觉取了 0.008(半径 125 米),
 * 量下来生成器出的赛道以高速弯为主:0.008 时每圈只有 3~6% 的长度有路肩,
 * seed 7 整圈一处都没有。0.005 时是 10~21%,和「一圈里几个弯有路肩」的观感
 * 对得上。
 */
const CORNER_CURVATURE = 0.005;
/** 估曲率用前后各几行。两行 = 24 米基线,和 `RACING_AI.curvatureBase` 同一量级。 */
const CURVATURE_ROWS = 2;

/**
 * 中心线在第 `row` 行的有符号曲率(1/米)。
 *
 * **正值 = 朝 `Course` 的横向正方向拐**(`Course` 里 `right = (-tangentZ, tangentX)`,
 * 也是条带 UV 的横向正方向)。
 */
export function rowCurvature(course: Course, row: number): number {
  const samples = course.layout.samples;
  const count = samples.length;
  const a = samples[(((row - CURVATURE_ROWS) % count) + count) % count];
  const b = samples[(row + CURVATURE_ROWS) % count];
  if (a === undefined || b === undefined) {
    return 0;
  }
  const cross = a.tangentX * b.tangentZ - a.tangentZ * b.tangentX;
  const dot = a.tangentX * b.tangentX + a.tangentZ * b.tangentZ;
  return Math.atan2(cross, dot) / (2 * CURVATURE_ROWS * course.layout.spacing);
}

/**
 * 每一行在不在弯里(1 / 0)。曲率过门槛的行,向前后各扩一行 —— 入弯前、
 * 出弯后那几米车也会用到路肩。
 */
export function cornerRowMask(course: Course): Float32Array {
  const count = course.layout.samples.length;
  const sharp = new Uint8Array(count);
  for (let row = 0; row < count; row++) {
    sharp[row] = Math.abs(rowCurvature(course, row)) >= CORNER_CURVATURE ? 1 : 0;
  }
  const mask = new Float32Array(count);
  for (let row = 0; row < count; row++) {
    const near =
      (sharp[(row - 1 + count) % count] ?? 0) + (sharp[row] ?? 0) + (sharp[(row + 1) % count] ?? 0);
    mask[row] = near > 0 ? 1 : 0;
  }
  return mask;
}

/**
 * 每一行的「弯道外侧」是哪一边:`Course` 的横向符号,不在弯里是 0。
 *
 * 外侧 = 车冲出去会去的那一边,真实赛道的看台和广告牌都摆在那儿。
 * `cornerRowMask()` 向前后各扩出来的那一行自己的曲率还没起来,符号是噪声,
 * 所以跟着紧挨着的那一行过门槛的走。
 */
export function cornerOutsideSide(course: Course): Int8Array {
  const count = course.layout.samples.length;
  const mask = cornerRowMask(course);
  const side = new Int8Array(count);
  for (let row = 0; row < count; row++) {
    const k = rowCurvature(course, row);
    if (Math.abs(k) >= CORNER_CURVATURE) {
      side[row] = k > 0 ? -1 : 1;
    }
  }
  const out = new Int8Array(count);
  for (let row = 0; row < count; row++) {
    if ((mask[row] ?? 0) === 0) {
      continue;
    }
    const own = side[row] ?? 0;
    const next = side[(row + 1) % count] ?? 0;
    const previous = side[(row - 1 + count) % count] ?? 0;
    out[row] = own !== 0 ? own : next !== 0 ? next : previous;
  }
  return out;
}
